import { Ajv, type ValidateFunction } from "ajv";
import { parseWorkflow, workflowHash } from "./schema.js";
import { outputReference } from "./references.js";
import type { Workflow } from "../types.js";

export interface OutputRef {
  readonly producer: string;
  readonly field: string;
}

export interface CompiledCapability {
  readonly commands?: OutputRef;
  readonly acceptance?: OutputRef;
  readonly files?: readonly string[] | OutputRef;
  readonly validate?: ValidateFunction;
}

export interface CompiledWorkflow {
  readonly definition: Workflow;
  readonly hash: string;
  readonly capabilities: ReadonlyMap<string, CompiledCapability>;
}

const ajv = new Ajv({ allErrors: true, strict: true, ownProperties: true });

function freezeDefinition(value: object): void {
  for (const child of Object.values(value))
    if (child && typeof child === "object") freezeDefinition(child);

  Object.freeze(value);
}

export class WorkflowCompiler {
  private cache = new Map<string, CompiledWorkflow>();

  compile(input: Workflow): CompiledWorkflow {
    const hash = workflowHash(input);
    const found = this.cache.get(hash);

    if (found) return found;

    const definition = parseWorkflow(input);
    freezeDefinition(definition);
    const capabilities = new Map<string, CompiledCapability>();

    for (const [id, c] of Object.entries(definition.capabilities)) {
      capabilities.set(id, {
        commands: c.gate?.commands
          ? outputReference(c.gate.commands)!
          : undefined,
        acceptance: c.gate?.acceptance
          ? outputReference(c.gate.acceptance)!
          : undefined,
        files:
          typeof c.gate?.files === "string"
            ? outputReference(c.gate.files)!
            : c.gate?.files,
        validate: c.outputs ? ajv.compile(c.outputs) : undefined,
      });
    }

    const compiled: CompiledWorkflow = {
      definition,
      hash,
      capabilities,
    };
    this.cache.set(hash, compiled);

    return compiled;
  }
}
