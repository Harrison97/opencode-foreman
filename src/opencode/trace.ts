import type { Database, Transition, WorkflowView } from "../core/types.js";
import { viewState } from "../core/types.js";
import { StateStore } from "../core/persistence/store.js";
import { redact } from "../core/security.js";

export interface TraceView {
  sessionID: string;
  name: string;
  capability: string;
  status: WorkflowView["status"];
  pauseReason?: string;
  steps: Transition[];
}

// Keep terminal control sequences out of user-defined capability names and reasons.
const label = (value: string) => redact(value).replace(/\p{Cc}/gu, " ");

export function projectTrace(
  db: Database,
  sessionID: string,
): TraceView | undefined {
  const saved = Object.values(db.workflows).find(
    (s) => s.sessionID === sessionID,
  );
  if (!saved || saved.phase.kind === "bypassed") return;
  const state = viewState(saved);
  return {
    sessionID,
    name: label(state.workflow.name),
    capability: label(state.capability),
    status: state.status,
    pauseReason: state.pauseReason ? label(state.pauseReason) : undefined,
    steps: state.history.map((step) => ({
      ...step,
      from: step.from === null ? null : label(step.from),
      to: label(step.to),
      reason: label(step.reason),
    })),
  };
}

export async function readTrace(directory: string, sessionID: string) {
  // Read only: viewing progress must never acquire a write lock or resume a run.
  return projectTrace(await new StateStore(directory).read(), sessionID);
}

export function recentSteps(trace: TraceView, count = 8) {
  const offset = Math.max(0, trace.steps.length - count);
  return trace.steps.slice(offset).map((step, index) => ({
    number: offset + index + 1,
    text: step.from === null ? step.to : `${step.from} → ${step.to}`,
  }));
}
