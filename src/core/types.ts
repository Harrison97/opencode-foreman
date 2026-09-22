export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface Decision {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  model?: string;
}

export interface Chooser {
  choose(
    state: unknown,
    criteria: Record<string, string>,
    instructions: string,
    context?: { sessionID: string; signal?: AbortSignal },
  ): Promise<Decision>;
}

export type Outcome = "ready" | "incomplete" | "blocked";

export interface Capability {
  purpose: string;
  instructions: string;
  completion: string;
  model?: string;
  dependsOn?: string[];
  outputs?: Record<string, unknown>;
  append?: string[];
  tools?: { allow?: string[]; deny?: string[]; declaredChecksOnly?: boolean };
  gate?: { files?: string[] | string; commands?: string; acceptance?: string };
  next?: Partial<Record<Outcome, string[]>>;
  terminal?: boolean;
}

export interface Workflow {
  version: 1;
  name: string;
  admission: { instructions: string; entries: string[] };
  capabilities: Record<string, Capability>;
}

export interface Report {
  summary: string;
  outcome: Outcome;
  data?: Record<string, unknown>;
  covered?: string[];
  questions?: string[];
}

export interface Evidence {
  callID: string;
  command: string;
  exit: number | null;
  output: string;
  at: string;
  revision: number;
  epoch: number;
}

export interface Transition {
  from: string | null;
  to: string;
  at: string;
  source: "jev" | "guard";
  confidence?: number;
  probabilities?: Record<string, number>;
  reason: string;
}

export interface Delivery {
  id: string;
  text: string;
  terminal: boolean;
  lease?: { owner: string; pid: number; expiresAt: number };
}

export interface DecisionRequest {
  id: string;
  gate: "admission" | "transition";
  choices: string[];
  report?: Report;
  inputMessageID?: string;
  lease?: { owner: string; pid: number; expiresAt: number };
}

export type ActivePhase =
  | { kind: "working"; inputMessageID?: string }
  | { kind: "reported"; report: Report; inputMessageID?: string }
  | { kind: "deciding"; request: DecisionRequest }
  | { kind: "dispatching"; delivery: Delivery }
  | { kind: "delivering"; delivery: Delivery };

export type Phase =
  | ActivePhase
  | { kind: "paused"; reason: string; questions: string[]; resume: ActivePhase }
  | { kind: "complete"; messageID: string }
  | { kind: "bypassed" };

export interface WorkflowState {
  schema: 3;
  id: string;
  sessionID: string;
  goal: string;
  workflow: Workflow;
  workflowHash: string;
  capability: string;
  phase: Phase;
  version: number;
  epoch: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  completed: Record<string, number>;
  capabilityOutputs: Record<string, Record<string, unknown>>;
  progress: string[];
  guidance: string[];
  evidence: Evidence[];
  history: Transition[];
  internalIDs: string[];
  consumedMessage?: string;
  turns: number;
  stalls: number;
  model?: ModelRef;
  agent?: string;
  selectedModel?: ModelRef;
  modelHistory: {
    capability: string;
    epoch: number;
    model: ModelRef;
    at: string;
  }[];
}

// Read-only presentation fields are derived, never stored as a second source of truth.
export type WorkflowView = WorkflowState & {
  status: "running" | "paused" | "delivering" | "complete" | "bypassed";
  questions: string[];
  pauseReason?: string;
  report?: Report;
  pendingDecision?: "admission" | "transition";
  pending?: Delivery & { delivered: boolean };
};

export interface Database {
  schema: 3;
  active?: string;
  workflows: Record<string, WorkflowState>;
}

export function viewState(state: WorkflowState): WorkflowView {
  const phase =
    state.phase.kind === "paused" ? state.phase.resume : state.phase;
  const view: WorkflowView = {
    ...state,
    status: "running",
    questions: [],
    pauseReason: undefined,
    report: undefined,
    pendingDecision: undefined,
    pending: undefined,
  };

  switch (state.phase.kind) {
    case "paused":
      view.status = "paused";
      view.questions = state.phase.questions;
      view.pauseReason = state.phase.reason;
      break;
    case "complete":
    case "bypassed":
    case "delivering":
      view.status = state.phase.kind;
      break;
    case "dispatching":
      if (state.phase.delivery.terminal) view.status = "delivering";
      break;
  }

  // A paused run still exposes the report or delivery it will resume.
  if (phase.kind === "reported") {
    view.report = phase.report;
  } else if (phase.kind === "deciding") {
    view.report = phase.request.report;
    view.pendingDecision = phase.request.gate;
  }

  if (phase.kind === "dispatching" || phase.kind === "delivering") {
    view.pending = {
      ...phase.delivery,
      delivered: phase.kind === "delivering",
    };
  }

  return view;
}
