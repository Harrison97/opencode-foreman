import type { Decision } from './types.js';

// Only this safe error type may cross into persisted state or UI notifications.
export class DecisionError extends Error {}

export function highestDecision(answer: Decision, legal: string[]): Decision {
  const p = answer?.probabilities;
  if (!answer || !legal.includes(answer.choice) || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1 ||
      !p || Array.isArray(p) || Object.keys(p).length !== legal.length ||
      legal.some(k => !Object.hasOwn(p, k) || !Number.isFinite(p[k]) || p[k]! < 0 || p[k]! > 1) ||
      Math.abs(Object.values(p).reduce((a, b) => a + b, 0) - 1) > 0.025) throw new DecisionError('Invalid Jev choice or probability distribution.');
  // Preserve Jev's selected choice on ties; otherwise use the highest probability.
  const choice = legal.reduce((best, id) => p[id]! > p[best]! ? id : best, answer.choice);
  return { ...answer, choice, confidence: p[choice]! };
}
