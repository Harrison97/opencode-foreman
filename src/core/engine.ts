import { invalidateCompleted, nextCapabilities } from "./graph.js";
import type {
  ActivePhase,
  Decision,
  Evidence,
  Report,
  WorkflowState,
} from "./types.js";

export interface Entropy {
  at: string;
  decisionID: string;
  messageID: string;
}
export type Event =
  | { type: "report"; report: Report; output?: Record<string, unknown> }
  | { type: "idle"; messageID: string; maxTurns: number }
  | { type: "decision"; id: string; version: number; answer: Decision }
  | { type: "decisionFailed"; id: string; version: number; reason: string }
  | { type: "pause"; reason: string }
  | { type: "resume"; guidance?: string; inputMessageID?: string }
  | { type: "received"; messageID: string; actualID?: string }
  | { type: "queue" }
  | { type: "retryDelivery"; messageID: string }
  | { type: "finished"; messageID: string; parentID: string; error?: string }
  | { type: "evidence"; evidence: Evidence };
export type Effect =
  | { type: "choose"; id: string }
  | { type: "dispatch"; id: string }
  | { type: "notify"; reason: string };
export interface Reduction {
  state: WorkflowState;
  effects: Effect[];
}

function invalidate(s: WorkflowState, id: string) {
  const kept = invalidateCompleted(s.workflow, Object.keys(s.completed), id);
  s.completed = Object.fromEntries(
    [...kept].map((key) => [key, s.completed[key]!]),
  );
}
function pause(
  s: WorkflowState,
  resume: ActivePhase,
  reason: string,
  questions: string[] = [],
) {
  s.phase = { kind: "paused", reason, questions, resume };
}
function enter(
  s: WorkflowState,
  id: string,
  entropy: Entropy,
  decision?: Decision,
) {
  const previous = s.capability;
  s.history.push({
    from: previous,
    to: id,
    at: entropy.at,
    source: decision ? "jev" : "guard",
    ...(decision
      ? {
          confidence: decision.confidence,
          probabilities: decision.probabilities,
        }
      : {}),
    reason: decision
      ? "Highest-ranked eligible Jev choice"
      : "Terminal delivery is the only eligible transition",
  });
  s.capability = id;
  s.epoch++;
  invalidate(s, id);
  s.stalls = previous === id ? s.stalls + 1 : 0;
  const terminal = Boolean(s.workflow.capabilities[id]!.terminal);
  const delivery = {
    id: entropy.messageID,
    terminal,
    text: terminal
      ? "[Foreman] Deliver the final response following this capability. No more tools."
      : "[Foreman] Continue the current goal in the selected capability. Submit jev_report and finish the response.",
  };
  s.internalIDs = [...s.internalIDs, delivery.id].slice(-200);
  s.phase = { kind: "dispatching", delivery };
  if (s.stalls >= 3)
    pause(
      s,
      s.phase,
      "Three consecutive repeats; review progress and reply to continue",
    );
}

/** Pure state transition: no network, filesystem, clocks, UUID generation, or mutation of input. */
export function reduceRun(
  input: WorkflowState,
  event: Event,
  entropy: Entropy,
): Reduction {
  const s = structuredClone(input);
  const p = s.phase;
  let changed = true;
  switch (event.type) {
    case "report":
      if (p.kind !== "working")
        throw new Error("No working capability or report already accepted");
      if (event.output) {
        s.capabilityOutputs[s.capability] = event.output;
        s.revision++;
      }
      s.progress = [
        ...s.progress,
        s.capability + ": " + event.report.summary,
      ].slice(-40);
      // Data lives only in the producer snapshot; accepted reports carry outcome metadata.
      s.phase = {
        kind: "reported",
        report: { ...event.report, data: undefined },
        inputMessageID: p.inputMessageID,
      };
      break;
    case "idle": {
      if (
        !["working", "reported"].includes(p.kind) ||
        s.consumedMessage === event.messageID
      ) {
        changed = false;
        break;
      }
      if (p.kind !== "working" && p.kind !== "reported") break;
      s.consumedMessage = event.messageID;
      s.turns++;
      if (s.turns >= event.maxTurns) {
        pause(s, p, "Automatic work-unit limit reached; reply to continue");
        break;
      }
      const report = p.kind === "reported" ? p.report : undefined;
      if (report?.questions?.length) {
        pause(s, p, "Human input requested", report.questions);
        break;
      }
      const outcome = report?.outcome ?? "incomplete";
      if (outcome === "ready") s.completed[s.capability] = s.epoch;
      else invalidate(s, s.capability);
      const choices = nextCapabilities(
        s.workflow,
        s.capability,
        outcome,
        new Set(Object.keys(s.completed)),
      );
      if (!choices.length) {
        pause(s, p, "No eligible transition for " + outcome);
        break;
      }
      if (
        choices.length === 1 &&
        s.workflow.capabilities[choices[0]!]!.terminal
      )
        enter(s, choices[0]!, entropy);
      else
        s.phase = {
          kind: "deciding",
          request: {
            id: entropy.decisionID,
            gate: "transition",
            choices,
            report,
            inputMessageID: p.inputMessageID,
          },
        };
      break;
    }
    case "decision":
      if (
        p.kind !== "deciding" ||
        p.request.id !== event.id ||
        s.version !== event.version
      ) {
        changed = false;
        break;
      }
      if (!p.request.choices.includes(event.answer.choice))
        throw new Error("Illegal decision");
      if (p.request.gate === "admission") {
        if (event.answer.choice === "BYPASS") {
          s.phase = { kind: "bypassed" };
          s.sessionID = "bypassed:" + s.id;
          break;
        }
        s.capability = event.answer.choice;
        s.history.push({
          from: null,
          to: s.capability,
          at: entropy.at,
          source: "jev",
          confidence: event.answer.confidence,
          probabilities: event.answer.probabilities,
          reason: "Highest-ranked eligible Jev choice",
        });
        s.phase = { kind: "working", inputMessageID: p.request.inputMessageID };
      } else enter(s, event.answer.choice, entropy, event.answer);
      break;
    case "decisionFailed":
      if (
        p.kind !== "deciding" ||
        p.request.id !== event.id ||
        s.version !== event.version
      ) {
        changed = false;
        break;
      }
      delete p.request.lease;
      pause(s, p, event.reason);
      break;
    case "pause":
      if (p.kind === "complete" || p.kind === "bypassed") {
        changed = false;
        break;
      }
      pause(s, p.kind === "paused" ? p.resume : p, event.reason);
      break;
    case "resume": {
      if (p.kind === "complete" || p.kind === "bypassed") {
        changed = false;
        break;
      }
      const resume = p.kind === "paused" ? p.resume : p;
      if (event.guidance) {
        s.guidance = [...s.guidance, event.guidance].slice(-40);
        s.progress = [...s.progress, "Human guidance: " + event.guidance].slice(
          -40,
        );
      }
      s.turns = 0;
      s.stalls = 0;
      if (resume.kind === "deciding" && !event.guidance) {
        s.phase = {
          kind: "deciding",
          request: {
            ...resume.request,
            id: entropy.decisionID,
            lease: undefined,
          },
        };
      } else if (
        resume.kind === "deciding" &&
        resume.request.gate === "admission"
      ) {
        s.phase = {
          kind: "deciding",
          request: {
            ...resume.request,
            id: entropy.decisionID,
            lease: undefined,
          },
        };
      } else if (
        (resume.kind === "dispatching" || resume.kind === "delivering") &&
        !event.guidance
      ) {
        s.phase = resume;
      } else if (s.workflow.capabilities[s.capability]!.terminal) {
        s.phase = {
          kind: "dispatching",
          delivery: {
            id: entropy.messageID,
            terminal: true,
            text: "[Foreman] Deliver the result, incorporating the latest user guidance.",
          },
        };
        s.internalIDs = [...s.internalIDs, entropy.messageID].slice(-200);
      } else {
        // Changed requirements invalidate accepted work. The agent must reconsider it.
        s.epoch++;
        s.revision++;
        invalidate(s, s.capability);
        s.phase = { kind: "working", inputMessageID: event.inputMessageID };
      }
      if (s.phase.kind === "deciding" && event.inputMessageID)
        s.phase.request.inputMessageID = event.inputMessageID;
      break;
    }
    case "received":
      if (p.kind !== "dispatching" || p.delivery.id !== event.messageID) {
        changed = false;
        break;
      }
      s.phase = p.delivery.terminal
        ? {
            kind: "delivering",
            delivery: { ...p.delivery, id: event.actualID ?? p.delivery.id },
          }
        : { kind: "working", inputMessageID: event.actualID ?? p.delivery.id };
      break;
    case "retryDelivery":
      if (p.kind !== "delivering") {
        changed = false;
        break;
      }
      s.phase = {
        kind: "delivering",
        delivery: { ...p.delivery, id: event.messageID, lease: undefined },
      };
      break;
    case "queue":
      if (p.kind !== "working") {
        changed = false;
        break;
      }
      s.phase = {
        kind: "dispatching",
        delivery: {
          id: entropy.messageID,
          terminal: false,
          text: "[Foreman] Resume the admitted capability and existing goal.",
        },
      };
      s.internalIDs = [...s.internalIDs, entropy.messageID].slice(-200);
      break;
    case "finished":
      if (p.kind !== "delivering" || p.delivery.id !== event.parentID) {
        changed = false;
        break;
      }
      if (event.error) pause(s, p, event.error);
      else s.phase = { kind: "complete", messageID: event.messageID };
      break;
    case "evidence":
      if (p.kind !== "working") {
        changed = false;
        break;
      }
      s.evidence = [...s.evidence, event.evidence].slice(-120);
      break;
  }
  if (!changed) return { state: input, effects: [] };
  s.version++;
  s.updatedAt = entropy.at;
  const effects: Effect[] =
    s.phase.kind === "deciding"
      ? [{ type: "choose", id: s.phase.request.id }]
      : s.phase.kind === "dispatching"
        ? [{ type: "dispatch", id: s.phase.delivery.id }]
        : s.phase.kind === "paused"
          ? [{ type: "notify", reason: s.phase.reason }]
          : [];
  return { state: s, effects };
}
