import { invalidateCompleted, nextCapabilities } from "../workflow/graph.js";
import type {
  ActivePhase,
  Decision,
  Evidence,
  Report,
  WorkflowState,
} from "../types.js";

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

function invalidate(state: WorkflowState, id: string) {
  const kept = invalidateCompleted(
    state.workflow,
    Object.keys(state.completed),
    id,
  );
  state.completed = Object.fromEntries(
    [...kept].map((key) => [key, state.completed[key]!]),
  );
}

function pause(
  state: WorkflowState,
  resume: ActivePhase,
  reason: string,
  questions: string[] = [],
) {
  state.phase = { kind: "paused", reason, questions, resume };
}

function enter(
  state: WorkflowState,
  id: string,
  entropy: Entropy,
  decision?: Decision,
) {
  const previous = state.capability;
  state.history.push({
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
  state.capability = id;
  state.epoch++;
  invalidate(state, id);
  state.stalls = previous === id ? state.stalls + 1 : 0;
  const terminal = Boolean(state.workflow.capabilities[id]!.terminal);
  const delivery = {
    id: entropy.messageID,
    terminal,
    text: terminal
      ? "[Foreman] Deliver the final response following this capability. No more tools."
      : "[Foreman] Continue the current goal in the selected capability. Submit jev_report and finish the response.",
  };
  state.internalIDs = [...state.internalIDs, delivery.id].slice(-200);
  state.phase = { kind: "dispatching", delivery };

  if (state.stalls >= 3)
    pause(
      state,
      state.phase,
      "Three consecutive repeats; review progress and reply to continue",
    );
}

/** Pure transition. Handlers may mutate only this private clone, never the caller's state. */
export function reduceRun(
  input: WorkflowState,
  event: Event,
  entropy: Entropy,
): Reduction {
  const state = structuredClone(input);
  const changed = applyEvent(state, event, entropy);

  if (!changed) return { state: input, effects: [] };

  state.version++;
  state.updatedAt = entropy.at;

  return { state: state, effects: pendingEffects(state) };
}

function applyEvent(
  state: WorkflowState,
  event: Event,
  entropy: Entropy,
): boolean {
  switch (event.type) {
    case "report":
      return onReport(state, event);
    case "idle":
      return onIdle(state, event, entropy);
    case "decision":
      return onDecision(state, event, entropy);
    case "decisionFailed":
      return onDecisionFailed(state, event);
    case "pause":
      return onPause(state, event);
    case "resume":
      return onResume(state, event, entropy);
    case "received":
      return onReceived(state, event);
    case "retryDelivery":
      return onRetryDelivery(state, event);
    case "queue":
      return onQueue(state, entropy);
    case "finished":
      return onFinished(state, event);
    case "evidence":
      return onEvidence(state, event);
  }
}

function pendingEffects(state: WorkflowState): Effect[] {
  switch (state.phase.kind) {
    case "deciding":
      return [{ type: "choose", id: state.phase.request.id }];
    case "dispatching":
      return [{ type: "dispatch", id: state.phase.delivery.id }];
    case "paused":
      return [{ type: "notify", reason: state.phase.reason }];
    default:
      return [];
  }
}

function onReport(
  state: WorkflowState,
  event: Extract<Event, { type: "report" }>,
): boolean {
  const phase = state.phase;

  if (phase.kind !== "working")
    throw new Error("No working capability or report already accepted");

  if (event.output) {
    state.capabilityOutputs[state.capability] = event.output;
    state.revision++;
  }

  state.progress = [
    ...state.progress,
    state.capability + ": " + event.report.summary,
  ].slice(-40);
  // Data lives only in the producer snapshot; accepted reports carry outcome metadata.
  state.phase = {
    kind: "reported",
    report: { ...event.report, data: undefined },
    inputMessageID: phase.inputMessageID,
  };

  return true;
}

function onIdle(
  state: WorkflowState,
  event: Extract<Event, { type: "idle" }>,
  entropy: Entropy,
): boolean {
  const phase = state.phase;

  if (
    (phase.kind !== "working" && phase.kind !== "reported") ||
    state.consumedMessage === event.messageID
  ) {
    return false;
  }

  state.consumedMessage = event.messageID;
  state.turns++;

  if (state.turns >= event.maxTurns) {
    pause(state, phase, "Automatic work-unit limit reached; reply to continue");

    return true;
  }

  const report = phase.kind === "reported" ? phase.report : undefined;

  if (report?.questions?.length) {
    pause(state, phase, "Human input requested", report.questions);

    return true;
  }

  const outcome = report?.outcome ?? "incomplete";

  if (outcome === "ready") state.completed[state.capability] = state.epoch;
  else invalidate(state, state.capability);

  const choices = nextCapabilities(
    state.workflow,
    state.capability,
    outcome,
    new Set(Object.keys(state.completed)),
  );

  if (!choices.length) {
    pause(state, phase, "No eligible transition for " + outcome);

    return true;
  }

  if (
    choices.length === 1 &&
    state.workflow.capabilities[choices[0]!]!.terminal
  )
    enter(state, choices[0]!, entropy);
  else
    state.phase = {
      kind: "deciding",
      request: {
        id: entropy.decisionID,
        gate: "transition",
        choices,
        report,
        inputMessageID: phase.inputMessageID,
      },
    };

  return true;
}

function onDecision(
  state: WorkflowState,
  event: Extract<Event, { type: "decision" }>,
  entropy: Entropy,
): boolean {
  const phase = state.phase;

  if (
    phase.kind !== "deciding" ||
    phase.request.id !== event.id ||
    state.version !== event.version
  ) {
    return false;
  }

  if (!phase.request.choices.includes(event.answer.choice))
    throw new Error("Illegal decision");

  if (phase.request.gate === "admission") {
    if (event.answer.choice === "BYPASS") {
      state.phase = { kind: "bypassed" };
      state.sessionID = "bypassed:" + state.id;

      return true;
    }

    state.capability = event.answer.choice;
    state.history.push({
      from: null,
      to: state.capability,
      at: entropy.at,
      source: "jev",
      confidence: event.answer.confidence,
      probabilities: event.answer.probabilities,
      reason: "Highest-ranked eligible Jev choice",
    });
    state.phase = {
      kind: "working",
      inputMessageID: phase.request.inputMessageID,
    };
  } else enter(state, event.answer.choice, entropy, event.answer);

  return true;
}

function onDecisionFailed(
  state: WorkflowState,
  event: Extract<Event, { type: "decisionFailed" }>,
): boolean {
  const phase = state.phase;

  if (
    phase.kind !== "deciding" ||
    phase.request.id !== event.id ||
    state.version !== event.version
  ) {
    return false;
  }

  delete phase.request.lease;
  pause(state, phase, event.reason);

  return true;
}

function onPause(
  state: WorkflowState,
  event: Extract<Event, { type: "pause" }>,
): boolean {
  const phase = state.phase;

  if (phase.kind === "complete" || phase.kind === "bypassed") {
    return false;
  }

  pause(state, phase.kind === "paused" ? phase.resume : phase, event.reason);

  return true;
}

function onResume(
  state: WorkflowState,
  event: Extract<Event, { type: "resume" }>,
  entropy: Entropy,
): boolean {
  const phase = state.phase;

  if (phase.kind === "complete" || phase.kind === "bypassed") {
    return false;
  }

  const resume = phase.kind === "paused" ? phase.resume : phase;

  if (event.guidance) {
    state.guidance = [...state.guidance, event.guidance].slice(-40);
    state.progress = [
      ...state.progress,
      "Human guidance: " + event.guidance,
    ].slice(-40);
  }

  state.turns = 0;
  state.stalls = 0;

  if (
    resume.kind === "deciding" &&
    (!event.guidance || resume.request.gate === "admission")
  ) {
    state.phase = {
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
    state.phase = resume;
  } else if (state.workflow.capabilities[state.capability]!.terminal) {
    state.phase = {
      kind: "dispatching",
      delivery: {
        id: entropy.messageID,
        terminal: true,
        text: "[Foreman] Deliver the result, incorporating the latest user guidance.",
      },
    };
    state.internalIDs = [...state.internalIDs, entropy.messageID].slice(-200);
  } else {
    // Changed requirements invalidate accepted work. The agent must reconsider it.
    state.epoch++;
    state.revision++;
    invalidate(state, state.capability);
    state.phase = { kind: "working", inputMessageID: event.inputMessageID };
  }

  if (state.phase.kind === "deciding" && event.inputMessageID)
    state.phase.request.inputMessageID = event.inputMessageID;

  return true;
}

function onReceived(
  state: WorkflowState,
  event: Extract<Event, { type: "received" }>,
): boolean {
  const phase = state.phase;

  if (phase.kind !== "dispatching" || phase.delivery.id !== event.messageID) {
    return false;
  }

  state.phase = phase.delivery.terminal
    ? {
        kind: "delivering",
        delivery: {
          ...phase.delivery,
          id: event.actualID ?? phase.delivery.id,
        },
      }
    : { kind: "working", inputMessageID: event.actualID ?? phase.delivery.id };

  return true;
}

function onRetryDelivery(
  state: WorkflowState,
  event: Extract<Event, { type: "retryDelivery" }>,
): boolean {
  const phase = state.phase;

  if (phase.kind !== "delivering") {
    return false;
  }

  state.phase = {
    kind: "delivering",
    delivery: { ...phase.delivery, id: event.messageID, lease: undefined },
  };

  return true;
}

function onQueue(state: WorkflowState, entropy: Entropy): boolean {
  const phase = state.phase;

  if (phase.kind !== "working") {
    return false;
  }

  state.phase = {
    kind: "dispatching",
    delivery: {
      id: entropy.messageID,
      terminal: false,
      text: "[Foreman] Resume the admitted capability and existing goal.",
    },
  };
  state.internalIDs = [...state.internalIDs, entropy.messageID].slice(-200);

  return true;
}

function onFinished(
  state: WorkflowState,
  event: Extract<Event, { type: "finished" }>,
): boolean {
  const phase = state.phase;

  if (phase.kind !== "delivering" || phase.delivery.id !== event.parentID) {
    return false;
  }

  if (event.error) pause(state, phase, event.error);
  else state.phase = { kind: "complete", messageID: event.messageID };

  return true;
}

function onEvidence(
  state: WorkflowState,
  event: Extract<Event, { type: "evidence" }>,
): boolean {
  const phase = state.phase;

  if (phase.kind !== "working") {
    return false;
  }

  state.evidence = [...state.evidence, event.evidence].slice(-120);

  return true;
}
