import type { WorkflowState } from './types.js';

export function outputReference(value: string): { producer: string; field: string } | undefined {
  const match = /^([a-zA-Z][a-zA-Z0-9_-]*)\.([a-zA-Z_][a-zA-Z0-9_-]*)$/.exec(value);
  return match ? { producer: match[1]!, field: match[2]! } : undefined;
}

export function outputValue(state: WorkflowState, reference: string): unknown {
  const ref = outputReference(reference);
  if (!ref || !Object.hasOwn(state.completed, ref.producer)) return undefined;
  const output = state.capabilityOutputs?.[ref.producer];
  return output && Object.hasOwn(output, ref.field) ? output[ref.field] : undefined;
}
