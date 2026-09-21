import type { Chooser, Decision } from '../core/types.js';
import { sanitize } from '../core/security.js';
import { randomUUID } from 'node:crypto';
import { tokenCount, type JevUsage } from './usage.js';
export function parseDecision(payload: unknown, legal: string[]): Decision {
  const obj = payload as { model?: string; answers?: { next?: Partial<Decision> & { type?: string } } };
  const answer = obj?.answers?.next;
  if (!answer || answer.type !== 'choice' || !legal.includes(answer.choice ?? '') ||
      typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1 ||
      !answer.probabilities || typeof answer.probabilities !== 'object') throw new Error('Invalid Jev Choice response');
  const probabilities = answer.probabilities;
  if (Object.keys(probabilities).length !== legal.length || legal.some(key => typeof probabilities[key] !== 'number' || !Number.isFinite(probabilities[key]) || probabilities[key]! < 0 || probabilities[key]! > 1) ||
      Math.abs(Object.values(probabilities).reduce((a, b) => a + b, 0) - 1) > 0.025) throw new Error('Invalid Jev probability distribution');
  return { choice: answer.choice!, confidence: answer.confidence, probabilities, model: typeof obj.model === 'string' ? obj.model : undefined };
}
export class JevClient implements Chooser {
  constructor(private options: { key?: string; model?: string; timeoutMs?: number; fetch?: typeof fetch; onUsage?: (record: JevUsage) => Promise<void> } = {}) {}
  async choose(state: unknown, criteria: Record<string, string>, instructions: string, context?: { sessionID: string }): Promise<Decision> {
    const key = this.options.key ?? process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
    if (!key) throw new Error('Jev credential unavailable');
    const requestedModel = this.options.model ?? process.env.JEV_MODEL ?? 'jev-latest';
    const body = JSON.stringify(sanitize({ model: requestedModel, state,
      questions: { next: { type: 'choice', instructions, criteria } } }));
    // Conservative byte budget below Jev's per-state/question token limit.
    if (Buffer.byteLength(body) > 28_000) throw new Error('Jev decision context exceeds budget');
    const usage: JevUsage = {
      schema: 1, requestID: randomUUID(), sessionID: context?.sessionID ?? null,
      startedAt: new Date().toISOString(), finishedAt: null, requestedModel, model: null,
      status: 'pending', httpStatus: null, inputTokens: null, outputTokens: null,
    };
    // A pending record makes interrupted requests visible rather than implying zero usage.
    await this.options.onUsage?.({ ...usage });
    try {
      const response = await (this.options.fetch ?? fetch)('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 12_000), redirect: 'error',
      });
      usage.httpStatus = response.status;
      if (!response.ok) { usage.status = 'http_error'; throw new Error(`Jev HTTP ${response.status}`); }
      usage.status = 'invalid_response';
      const payload = await response.json();
      usage.model = typeof payload?.model === 'string' ? payload.model : null;
      usage.inputTokens = tokenCount(payload?.usage?.input_tokens);
      usage.outputTokens = tokenCount(payload?.usage?.output_tokens);
      const decision = parseDecision(payload, Object.keys(criteria));
      usage.status = 'success';
      return decision;
    } catch (e) {
      if (usage.status === 'pending') usage.status = 'transport_error';
      // Never propagate request objects, headers, provider response bodies or transport errors.
      if (e instanceof Error && /^Jev HTTP \d+$|^Invalid Jev/.test(e.message)) throw e;
      throw new Error('Jev request failed or timed out');
    } finally {
      usage.finishedAt = new Date().toISOString();
      await this.options.onUsage?.({ ...usage });
    }
  }
}
