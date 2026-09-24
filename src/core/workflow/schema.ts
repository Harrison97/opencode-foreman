import { Ajv } from "ajv";
import { createHash } from "node:crypto";
import type { Workflow } from "../types.js";
import { parseModel } from "../models.js";
import { checkWorkflow } from "./checker.js";

const ajv = new Ajv({ allErrors: true, strict: true, ownProperties: true });

const string = { type: "string", minLength: 1, maxLength: 24000 };

const strings = {
  type: "array",
  items: string,
  uniqueItems: true,
  maxItems: 100,
};

const outcomes = {
  type: "object",
  additionalProperties: false,
  properties: { ready: strings, incomplete: strings, blocked: strings },
};

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "name", "admission", "capabilities"],
  properties: {
    version: { const: 1 },
    name: string,
    compaction: { type: "boolean" },
    admission: {
      type: "object",
      additionalProperties: false,
      required: ["entries"],
      anyOf: [
        { properties: { when: string }, required: ["when"] },
        { properties: { instructions: string }, required: ["instructions"] },
      ],
      properties: {
        when: string,
        bypass: string,
        instructions: string,
        entries: { ...strings, minItems: 1 },
      },
    },
    capabilities: {
      type: "object",
      minProperties: 1,
      maxProperties: 100,
      propertyNames: { pattern: "^[a-zA-Z][a-zA-Z0-9_-]*$", maxLength: 64 },
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["purpose", "instructions", "completion"],
        properties: {
          purpose: string,
          instructions: string,
          completion: string,
          model: string,
          dependsOn: strings,
          outputs: { type: "object" },
          append: strings,
          tools: {
            type: "object",
            additionalProperties: false,
            properties: {
              allow: strings,
              deny: strings,
              declaredChecksOnly: { type: "boolean" },
            },
          },
          gate: {
            type: "object",
            additionalProperties: false,
            properties: {
              files: { anyOf: [strings, string] },
              commands: string,
              acceptance: string,
            },
          },
          next: outcomes,
          terminal: { type: "boolean" },
        },
      },
    },
  },
};

const validate = ajv.compile(schema);

export function validateOutput(
  schema: Record<string, unknown>,
  data: Record<string, unknown>,
): void {
  const check = ajv.compile(schema);

  if (!check(data))
    throw new Error(
      "Invalid capability output: " + ajv.errorsText(check.errors),
    );
}

export function parseWorkflow(value: unknown): Workflow {
  if (!validate(value))
    throw new Error("Invalid workflow: " + ajv.errorsText(validate.errors));

  const w = value as unknown as Workflow;
  const ids = Object.keys(w.capabilities);
  const has = (id: string) => Object.hasOwn(w.capabilities, id);

  for (const id of ids) {
    if (["constructor", "prototype", "__proto__", "BYPASS"].includes(id))
      throw new Error("Reserved capability identifier");

    const c = w.capabilities[id]!;

    if (c.model) parseModel(c.model);

    if (c.outputs) {
      if (c.outputs.type !== "object")
        throw new Error("Capability outputs schema must describe an object");

      ajv.compile(c.outputs);
    }

    for (const field of c.append ?? [])
      if (["__proto__", "constructor", "prototype"].includes(field))
        throw new Error("Reserved output key");

    for (const target of [
      ...Object.values(c.next ?? {}).flat(),
      ...(c.dependsOn ?? []),
    ])
      if (!has(target))
        throw new Error("Unknown capability reference: " + target);

    if (
      c.terminal &&
      (Object.values(c.next ?? {}).some((list) => list!.length) ||
        c.gate ||
        c.outputs)
    )
      throw new Error(
        "Terminal delivery cannot have transitions, outputs, or gates",
      );

    if (
      !c.terminal &&
      !Object.values(c.next ?? {}).some((list) => list!.length)
    )
      throw new Error("Nonterminal capability needs transitions: " + id);
  }

  for (const entry of w.admission.entries) {
    if (
      !has(entry) ||
      w.capabilities[entry]!.terminal ||
      w.capabilities[entry]!.dependsOn?.length
    )
      throw new Error("Entry must be an independent, nonterminal capability");
  }

  const visiting = new Set<string>(),
    done = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error("Cyclic capability dependencies");

    if (done.has(id)) return;

    visiting.add(id);

    for (const dep of w.capabilities[id]!.dependsOn ?? []) visit(dep);

    visiting.delete(id);
    done.add(id);
  }
  ids.forEach(visit);
  const reached = new Set(w.admission.entries);

  for (const id of reached)
    for (const next of Object.values(w.capabilities[id]!.next ?? {}).flat())
      reached.add(next);

  if (ids.some((id) => !reached.has(id)))
    throw new Error("Unreachable capability");

  if (!ids.some((id) => w.capabilities[id]!.terminal))
    throw new Error("Workflow requires a terminal delivery capability");

  // Every node needs a possible path to delivery, even though outcomes may loop.
  const finishing = new Set(ids.filter((id) => w.capabilities[id]!.terminal));

  for (let n = 0; n < ids.length; n++)
    for (const id of ids)
      if (
        Object.values(w.capabilities[id]!.next ?? {})
          .flat()
          .some((next) => finishing.has(next))
      )
        finishing.add(id);

  if (finishing.size !== ids.length)
    throw new Error("Capability cannot reach terminal delivery");

  const errors = checkWorkflow(w).filter((d) => d.severity === "error");

  if (errors.length)
    throw new Error(
      "Invalid workflow:\n" +
        errors.map((d) => `${d.path}: ${d.message}`).join("\n"),
    );

  return structuredClone(w);
}

export function workflowHash(w: Workflow): string {
  return createHash("sha256").update(JSON.stringify(w)).digest("hex");
}
