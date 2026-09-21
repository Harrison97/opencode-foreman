export interface ModelRef { providerID: string; modelID: string }
export interface Decision { choice: string; confidence: number; probabilities: Record<string, number>; model?: string }
export interface Chooser { choose(state: unknown, criteria: Record<string, string>, instructions: string, context?: { sessionID: string }): Promise<Decision> }
export type Outcome = 'ready' | 'incomplete' | 'blocked';
export interface Capability {
  purpose: string;
  instructions: string;
  completion: string;
  model?: string;
  dependsOn?: string[];
  outputs?: Record<string, unknown>;
  append?: string[];
  tools?: { allow?: string[]; deny?: string[]; declaredChecksOnly?: boolean };
  gate?: { files?: string[]; checks?: string; coverage?: string };
  next?: Partial<Record<Outcome, string[]>>;
  fallback?: Partial<Record<Outcome, string>>;
  terminal?: boolean;
}
export interface Workflow {
  version: 1;
  name: string;
  admission: { instructions: string; entries: string[]; fallback?: string };
  capabilities: Record<string, Capability>;
}
export interface Report {
  summary: string;
  outcome: Outcome;
  data?: Record<string, unknown>;
  covered?: string[];
  questions?: string[];
}
export interface Evidence { callID: string; command: string; exit: number | null; output: string; at: string; revision: number; epoch: number }
export interface Transition { from: string | null; to: string; at: string; source: 'jev' | 'fallback' | 'guard'; confidence?: number; reason: string }
export interface WorkflowState {
  schema: 2; id: string; sessionID: string; goal: string;
  workflow: Workflow; workflowHash: string;
  capability: string; status: 'running' | 'paused' | 'complete';
  epoch: number; revision: number; createdAt: string; updatedAt: string;
  data: Record<string, unknown>; completed: Record<string, number>;
  progress: string[]; questions: string[]; pauseReason?: string;
  report?: Report; evidence: Evidence[]; history: Transition[];
  internalIDs: string[]; consumedMessage?: string;
  pending?: { id: string; text: string; delivered: boolean };
  turns: number; stalls: number;
  model?: ModelRef; agent?: string; selectedModel?: ModelRef;
  modelHistory: { capability: string; epoch: number; model: ModelRef; at: string }[];
}
export interface Database { schema: 2; active?: string; workflows: Record<string, WorkflowState> }
