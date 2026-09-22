import type { Workflow } from "../types.js";
import { invalidateCompleted, nextCapabilities } from "./graph.js";
import { outputReference } from "./references.js";

export interface Diagnostic {
  severity: "error" | "warning";
  path: string;
  message: string;
}

type Schema = Record<string, any>;

const outputProperties = (
  workflow: Workflow,
  id: string,
): Record<string, Schema> =>
  (workflow.capabilities[id]!.outputs?.properties as Record<string, Schema>) ??
  {};

function schemaTypes(schema: Schema | undefined): string[] {
  if (typeof schema?.type === "string") return [schema.type];
  if (Array.isArray(schema?.type)) return schema.type;

  return [];
}

/** Semantic checks over a structurally validated workflow. No services or model calls. */
export function checkWorkflow(
  workflow: Workflow,
  stateLimit = 20000,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const emit = (
    severity: Diagnostic["severity"],
    path: string,
    message: string,
  ) => {
    if (!diagnostics.some((d) => d.path === path && d.message === message))
      diagnostics.push({ severity, path, message });
  };
  const fields = checkCapabilityContracts(workflow, emit);
  checkReachability(workflow, fields, stateLimit, emit);

  return diagnostics;
}

type EmitDiagnostic = (
  severity: Diagnostic["severity"],
  path: string,
  message: string,
) => void;

function checkCapabilityContracts(
  workflow: Workflow,
  emit: EmitDiagnostic,
): Set<string> {
  const fields = new Set<string>();

  for (const [id, capability] of Object.entries(workflow.capabilities)) {
    const path = `capabilities.${id}`;

    for (const key of capability.append ?? []) {
      const current = outputProperties(workflow, id)[key];

      if (
        !current ||
        schemaTypes(current).length !== 1 ||
        schemaTypes(current)[0] !== "array"
      )
        emit(
          "error",
          `${path}.append`,
          `Declare ${key} as an array in this capability's outputs before appending it.`,
        );
    }

    if (capability.tools?.declaredChecksOnly && !capability.gate?.commands)
      emit(
        "error",
        `${path}.tools.declaredChecksOnly`,
        "Set gate.commands to a declared command-array field, or disable this restriction.",
      );

    for (const tool of capability.tools?.allow ?? [])
      if (capability.tools?.deny?.includes(tool))
        emit(
          "warning",
          `${path}.tools`,
          `${tool} appears in allow and deny; deny wins. Remove the contradictory entry.`,
        );

    for (const tool of capability.tools?.deny ?? [])
      if (["foreman_status", "foreman_report"].includes(tool))
        emit(
          "warning",
          `${path}.tools.deny`,
          `${tool} is a Foreman control tool and is exempt from these lists.`,
        );

    if (
      capability.gate?.commands &&
      !["bash", "shell"].some(
        (tool) =>
          !capability.tools?.deny?.includes(tool) &&
          (!capability.tools?.allow || capability.tools.allow.includes(tool)),
      )
    )
      emit(
        "error",
        `${path}.tools`,
        "A command gate requires an allowed bash or shell tool to collect native evidence.",
      );

    for (const kind of ["commands", "acceptance", "files"] as const) {
      const field = capability.gate?.[kind];

      if (!field || Array.isArray(field)) continue;

      fields.add(field);
      const ref = outputReference(field);

      if (!ref) {
        emit(
          "error",
          `${path}.gate.${kind}`,
          `Use capability.output, such as build.checks, instead of ${field}.`,
        );
        continue;
      }

      if (!Object.hasOwn(workflow.capabilities, ref.producer)) {
        emit(
          "error",
          `${path}.gate.${kind}`,
          `Unknown output producer ${ref.producer}; reference an existing capability.`,
        );
        continue;
      }

      if (ref.producer === id && kind !== "files")
        emit(
          "error",
          `${path}.gate.${kind}`,
          "A gate must consume an earlier capability output, not its own output.",
        );

      if (
        ref.producer === id &&
        kind === "files" &&
        !(capability.outputs?.required as string[] | undefined)?.includes(
          ref.field,
        )
      )
        emit(
          "error",
          `${path}.gate.files`,
          `Require ${ref.field} in this capability's outputs.required so its submitted paths can be checked.`,
        );

      const outputs = outputProperties(workflow, ref.producer);
      if (!Object.hasOwn(outputs, ref.field)) {
        emit(
          "error",
          `${path}.gate.${kind}`,
          `No declared output ${field}; declare ${ref.field} in ${ref.producer}.outputs.properties.`,
        );
        continue;
      }

      const schema = outputs[ref.field]!;

      const outputTypes = schemaTypes(schema),
        itemTypes = schemaTypes(schema.items);

      if (
        (outputTypes.length &&
          (outputTypes.length !== 1 || outputTypes[0] !== "array")) ||
        (itemTypes.length &&
          (itemTypes.length !== 1 || itemTypes[0] !== "string"))
      )
        emit(
          "error",
          `${path}.gate.${kind}`,
          `${field} must be an array of strings; correct its output schema.`,
        );
      else if (!outputTypes.length || !itemTypes.length)
        emit(
          "warning",
          `${path}.gate.${kind}`,
          `Cannot prove the type of ${field}; use explicit type: array and items.type: string for static checking.`,
        );

      if (!(schema.minItems >= 1))
        emit(
          "warning",
          `${path}.gate.${kind}`,
          `${field} permits an empty array, which this gate rejects; set minItems: 1.`,
        );
    }

    if (
      capability.outputs &&
      ["$ref", "allOf", "anyOf", "oneOf", "if", "patternProperties"].some(
        (k) => k in capability.outputs!,
      )
    )
      emit(
        "warning",
        `${path}.outputs`,
        "Complex output schemas still validate at runtime; static field analysis uses only top-level properties and required declarations.",
      );
  }

  return fields;
}

function checkReachability(
  workflow: Workflow,
  fields: Set<string>,
  stateLimit: number,
  emit: EmitDiagnostic,
) {
  const ids = Object.keys(workflow.capabilities);
  // Explore completion sets, preserving producer output presence across repair loops.
  // This mirrors runtime invalidation; plain graph reachability misses dependency deadlocks.
  type State = { id: string; done: Set<string>; data: Set<string> };
  const stateKey = (current: State) =>
    JSON.stringify([
      current.id,
      [...current.done].sort(),
      [...current.data].sort(),
    ]);
  const queue: State[] = workflow.admission.entries.map((id) => ({
    id,
    done: new Set(),
    data: new Set(),
  }));
  const scheduled = new Set(queue.map(stateKey));
  const visited = new Set<string>(),
    reached = new Set<string>(),
    terminal = new Set<string>();
  let truncated = false;

  for (let n = 0; n < queue.length; n++) {
    const current = queue[n]!;
    const key = stateKey(current);

    if (visited.has(key)) continue;

    if (visited.size >= stateLimit) {
      truncated = true;
      break;
    }

    visited.add(key);
    reached.add(current.id);
    const capability = workflow.capabilities[current.id]!;

    if (capability.terminal) {
      terminal.add(current.id);
      continue;
    }

    for (const kind of ["commands", "acceptance", "files"] as const) {
      const field = capability.gate?.[kind];

      if (
        !field ||
        Array.isArray(field) ||
        (kind === "files" && outputReference(field)?.producer === current.id)
      )
        continue;

      if (
        field &&
        (!current.data.has(field) ||
          !current.done.has(outputReference(field)?.producer ?? ""))
      )
        emit(
          "error",
          `capabilities.${current.id}.gate.${kind}`,
          `${field} is not guaranteed on every entry path. Require it in an earlier producer's outputs.required and prevent transitions that skip or invalidate that producer.`,
        );
    }

    for (const outcome of ["ready", "incomplete", "blocked"] as const) {
      let done = new Set(current.done);
      const data = new Set(current.data);

      if (outcome === "ready") {
        done.add(current.id);

        for (const field of fields)
          if (outputReference(field)?.producer === current.id)
            data.delete(field);

        for (const field of (capability.outputs?.required as
          string[] | undefined) ?? [])
          if (
            fields.has(`${current.id}.${field}`) &&
            Object.hasOwn(outputProperties(workflow, current.id), field)
          )
            data.add(`${current.id}.${field}`);
      } else done = invalidateCompleted(workflow, done, current.id);

      const targets = nextCapabilities(workflow, current.id, outcome, done);

      if (capability.next?.[outcome]?.length && !targets.length)
        emit(
          "warning",
          `capabilities.${current.id}.next.${outcome}`,
          "A reachable completion state has no eligible next capability; this outcome pauses. Adjust dependencies/transitions if that is unintended.",
        );

      for (const id of targets) {
        const nextDone = invalidateCompleted(workflow, done, id);
        const next = { id, done: nextDone, data };
        const key = stateKey(next);

        if (!scheduled.has(key)) {
          if (queue.length >= stateLimit) truncated = true;
          else {
            scheduled.add(key);
            queue.push(next);
          }
        }
      }
    }
  }

  if (truncated)
    emit(
      "warning",
      "capabilities",
      `Dependency/output analysis reached its ${stateLimit}-state limit; full reachability was not proven. Simplify the graph or review the unproven paths.`,
    );
  else {
    for (const id of ids)
      if (!reached.has(id))
        emit(
          "error",
          `capabilities.${id}.dependsOn`,
          "Capability is unreachable with completion prerequisites enforced; reorder transitions or fix its dependencies.",
        );

    if (!terminal.size)
      emit(
        "error",
        "capabilities",
        "No terminal delivery is reachable with completion prerequisites enforced; fix dependency deadlocks.",
      );
  }
}

export function checkHost(
  workflow: Workflow,
  models: string[],
  tools: string[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const [id, capability] of Object.entries(workflow.capabilities)) {
    if (capability.model && !models.includes(capability.model))
      diagnostics.push({
        severity: "warning",
        path: `capabilities.${id}.model`,
        message: `${capability.model} is not advertised by a connected provider in this host; configure the provider/model before running.`,
      });

    for (const name of new Set([
      ...(capability.tools?.allow ?? []),
      ...(capability.tools?.deny ?? []),
    ]))
      if (
        !tools.includes(name) &&
        !["foreman_status", "foreman_report"].includes(name)
      )
        diagnostics.push({
          severity: "warning",
          path: `capabilities.${id}.tools`,
          message: `${name} is not advertised by this host's tool inventory; verify the name and plugin/MCP configuration.`,
        });
  }

  return diagnostics;
}
