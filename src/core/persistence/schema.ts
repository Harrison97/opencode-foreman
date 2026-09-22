import { Ajv } from "ajv";
import type { Database, ActivePhase, WorkflowState } from "../types.js";
import { parseWorkflow, workflowHash } from "../workflow/schema.js";
import { nextCapabilities } from "../workflow/graph.js";

const str = { type: "string" },
  strings = { type: "array", items: str };

const int = { type: "integer", minimum: 0 };

const obj = (required: string[], properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});

const report = obj(["summary", "outcome"], {
  summary: str,
  outcome: { enum: ["ready", "incomplete", "blocked"] },
  covered: strings,
  questions: strings,
});

const delivery = obj(["id", "text", "terminal"], {
  id: str,
  text: str,
  terminal: { type: "boolean" },
  lease: obj(["owner", "pid", "expiresAt"], {
    owner: str,
    pid: int,
    expiresAt: int,
  }),
});

const request = obj(["id", "gate", "choices"], {
  id: str,
  gate: { enum: ["admission", "transition"] },
  choices: strings,
  report,
  inputMessageID: str,
  lease: obj(["owner", "pid", "expiresAt"], {
    owner: str,
    pid: int,
    expiresAt: int,
  }),
});

const active = {
  anyOf: [
    obj(["kind"], { kind: { const: "working" }, inputMessageID: str }),
    obj(["kind", "report"], {
      kind: { const: "reported" },
      report,
      inputMessageID: str,
    }),
    obj(["kind", "request"], { kind: { const: "deciding" }, request }),
    obj(["kind", "delivery"], { kind: { const: "dispatching" }, delivery }),
    obj(["kind", "delivery"], { kind: { const: "delivering" }, delivery }),
  ],
};

const model = obj(["providerID", "modelID"], { providerID: str, modelID: str });

const run = obj(
  [
    "schema",
    "id",
    "sessionID",
    "goal",
    "workflow",
    "workflowHash",
    "capability",
    "phase",
    "version",
    "epoch",
    "revision",
    "createdAt",
    "updatedAt",
    "completed",
    "capabilityOutputs",
    "progress",
    "guidance",
    "evidence",
    "history",
    "internalIDs",
    "turns",
    "stalls",
    "modelHistory",
  ],
  {
    schema: { const: 3 },
    id: str,
    sessionID: str,
    goal: str,
    workflow: { type: "object" },
    workflowHash: str,
    capability: str,
    phase: {
      anyOf: [
        active,
        obj(["kind", "reason", "questions", "resume"], {
          kind: { const: "paused" },
          reason: str,
          questions: strings,
          resume: active,
        }),
        obj(["kind", "messageID"], {
          kind: { const: "complete" },
          messageID: str,
        }),
        obj(["kind"], { kind: { const: "bypassed" } }),
      ],
    },
    version: int,
    epoch: int,
    revision: int,
    createdAt: str,
    updatedAt: str,
    completed: { type: "object", additionalProperties: int },
    capabilityOutputs: {
      type: "object",
      additionalProperties: { type: "object" },
    },
    progress: strings,
    guidance: strings,
    evidence: {
      type: "array",
      items: obj(
        ["callID", "command", "exit", "output", "at", "revision", "epoch"],
        {
          callID: str,
          command: str,
          exit: { type: ["integer", "null"] },
          output: str,
          at: str,
          revision: int,
          epoch: int,
        },
      ),
    },
    history: { type: "array", items: { type: "object" } },
    internalIDs: strings,
    consumedMessage: str,
    turns: int,
    stalls: int,
    model,
    agent: str,
    selectedModel: model,
    modelHistory: {
      type: "array",
      items: obj(["capability", "epoch", "model", "at"], {
        capability: str,
        epoch: int,
        model,
        at: str,
      }),
    },
  },
);

const ajv = new Ajv({ strict: true, allErrors: true, ownProperties: true });

const validate = ajv.compile<Database>(
  obj(["schema", "workflows"], {
    schema: { const: 3 },
    active: str,
    workflows: { type: "object", additionalProperties: run },
  }),
);

function migrate(old: any): Database {
  const db: Database = { schema: 3, workflows: {}, active: old.active };

  for (const [id, s] of Object.entries(old.workflows) as [string, any][]) {
    if (!s.capabilityOutputs)
      throw new Error(
        "Legacy state lacks output provenance; preserve it outside .jev/foreman-state.json before starting a new run.",
      );

    const workflow = parseWorkflow(s.workflow);
    const metadata = s.report
      ? {
          summary: s.report.summary,
          outcome: s.report.outcome,
          covered: s.report.covered,
          questions: s.report.questions,
        }
      : undefined;
    let phase: WorkflowState["phase"];
    let activePhase: ActivePhase = metadata
      ? { kind: "reported", report: metadata }
      : { kind: "working" };

    if (s.pendingDecision)
      activePhase = {
        kind: "deciding",
        request: {
          id: "legacy-" + id,
          gate: s.pendingDecision,
          report: metadata,
          choices:
            s.pendingDecision === "admission"
              ? [
                  ...workflow.admission.entries,
                  ...(/^\s*(foreman|jev):/i.test(s.goal) ? [] : ["BYPASS"]),
                ]
              : nextCapabilities(
                  workflow,
                  s.capability,
                  metadata?.outcome ?? "incomplete",
                  new Set(Object.keys(s.completed)),
                ),
        },
      };
    else if (s.pending) {
      const delivery = {
        id: s.pending.id,
        text: s.pending.text,
        terminal: Boolean(workflow.capabilities[s.capability]?.terminal),
      };
      activePhase = s.pending.delivered
        ? delivery.terminal
          ? { kind: "delivering", delivery }
          : { kind: "working", inputMessageID: delivery.id }
        : { kind: "dispatching", delivery };
    }

    if (s.status === "paused")
      phase = {
        kind: "paused",
        reason: s.pauseReason ?? "Legacy pause",
        questions: s.questions ?? [],
        resume: activePhase,
      };
    else if (s.status === "complete" && !s.pending)
      phase = {
        kind: "paused",
        reason:
          "Legacy completion lacks delivery evidence; resume to deliver the result.",
        questions: [],
        resume: {
          kind: "dispatching",
          delivery: {
            id: "msg_" + id.replaceAll("-", ""),
            text: "[Foreman] Deliver the final result.",
            terminal: true,
          },
        },
      };
    else phase = activePhase;

    db.workflows[id] = {
      schema: 3,
      id,
      sessionID: s.sessionID,
      goal: s.goal,
      workflow,
      workflowHash: workflowHash(workflow),
      capability: s.capability,
      phase,
      version: 0,
      epoch: s.epoch,
      revision: s.revision,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      completed: s.completed,
      capabilityOutputs: s.capabilityOutputs,
      progress: s.progress,
      guidance: [],
      evidence: s.evidence,
      history: s.history,
      internalIDs: s.internalIDs,
      consumedMessage: s.consumedMessage,
      turns: s.turns,
      stalls: s.stalls,
      model: s.model,
      agent: s.agent,
      selectedModel: s.selectedModel,
      modelHistory: s.modelHistory,
    };
  }

  return db;
}

export function parseDatabase(value: unknown): Database {
  const legacy = value as { schema?: number; workflows?: unknown };
  const db =
    legacy?.schema === 2 &&
    legacy.workflows &&
    typeof legacy.workflows === "object"
      ? migrate(legacy)
      : value;
  // Normalize undefined optional properties just as persistence does.
  const normalized = JSON.parse(JSON.stringify(db));

  if (!validate(normalized))
    throw new Error(
      "Invalid Foreman state schema: " + ajv.errorsText(validate.errors),
    );

  for (const [id, s] of Object.entries((normalized as Database).workflows)) {
    if (
      id !== s.id ||
      !s.workflow.capabilities?.[s.capability] ||
      workflowHash(s.workflow) !== s.workflowHash
    )
      throw new Error("Invalid pinned workflow state");

    if (s.phase.kind === "delivering" && !s.phase.delivery.terminal)
      throw new Error("Invalid nonterminal delivery state");
  }

  return normalized as Database;
}
