import type { ModelRef } from './types.js';
export function parseModel(value: unknown): ModelRef {
  if (typeof value !== 'string' || !/^[^\s/]+\/[^\s]+$/.test(value)) throw new Error('Model must use provider/model');
  const split = value.indexOf('/');
  return { providerID: value.slice(0, split), modelID: value.slice(split + 1) };
}
