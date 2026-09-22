import { isDeepStrictEqual } from "node:util";
import type { CompiledWorkflow, OutputRef } from "../workflow/compiled.js";
import type { WorkflowState } from "../types.js";

export function resolvedOutput(s: WorkflowState, ref: OutputRef): unknown {
  if (!Object.hasOwn(s.completed, ref.producer)) return undefined;
  return s.capabilityOutputs[ref.producer]?.[ref.field];
}
export function mergeOutput(
  compiled: CompiledWorkflow,
  s: WorkflowState,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const c = compiled.definition.capabilities[s.capability]!;
  if (
    Object.keys(data).some((key) =>
      ["__proto__", "constructor", "prototype"].includes(key),
    )
  )
    throw new Error("Reserved output key");
  if (Object.keys(data).length && !c.outputs)
    throw new Error("Capability has no declared output schema");
  const output = structuredClone(data);
  // Appending is scoped to this producer. Cross-capability aggregation must be explicit.
  for (const key of c.append ?? [])
    if (Object.hasOwn(data, key)) {
      const previous = s.capabilityOutputs[s.capability]?.[key];
      if (
        !Array.isArray(data[key]) ||
        (previous !== undefined && !Array.isArray(previous))
      )
        throw new Error("Append field must be an array");
      const merged: unknown[] = [];
      for (const value of [
        ...((previous as unknown[]) ?? []),
        ...(data[key] as unknown[]),
      ])
        if (!merged.some((existing) => isDeepStrictEqual(existing, value)))
          merged.push(value);
      output[key] = merged;
    }
  const validate = compiled.capabilities.get(s.capability)!.validate;
  if (validate && !validate(output))
    throw new Error(
      "Invalid capability output: " + JSON.stringify(validate.errors),
    );
  return output;
}
