import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  Chooser,
  Workflow,
  WorkflowState,
  Database,
  Report,
  Evidence,
  ModelRef,
} from "../types.js";
import { viewState } from "../types.js";
import { StateStore } from "../persistence/store.js";
import { sanitize } from "../security.js";
import { DecisionError, highestDecision } from "./decision.js";
import { parseModel } from "../models.js";
import { WorkflowCompiler } from "../workflow/compiled.js";
import { eligibleCapabilities } from "../workflow/graph.js";
import { resolvedOutput } from "./output.js";
import { validateReport, validateReportOutput } from "./report.js";
import { outputReference } from "../workflow/references.js";
import { decisionContext, decisionPrompt } from "./context.js";
import { appendRoutingDiagnostic, routingDiagnostic } from "./diagnostics.js";
import { workflowInstructions } from "./instructions.js";
import {
  applyWorkflowEvent,
  type Event,
  type TransitionContext,
} from "./engine.js";

const newTransitionContext = (): TransitionContext => ({
  at: new Date().toISOString(),
  decisionID: randomUUID(),
  messageID:
    "msg_" + Date.now().toString(16) + randomUUID().replaceAll("-", ""),
});

export function findSession(db: Database, id: string) {
  return Object.values(db.workflows).find((state) => state.sessionID === id);
}

export function eligible(state: WorkflowState, ids: string[]) {
  return eligibleCapabilities(
    state.workflow,
    new Set(Object.keys(state.completed)),
    ids,
  );
}

export function checkCommands(state: WorkflowState): string[] {
  const field = state.workflow.capabilities[state.capability]?.gate?.commands;
  const ref = field ? outputReference(field) : undefined;
  const values = ref ? resolvedOutput(state, ref) : undefined;

  return Array.isArray(values) &&
    values.every((x) => typeof x === "string" && x.trim())
    ? values
    : [];
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

function parseUserMessage(text: string) {
  const bypass = /^\s*foreman bypass:/i.test(text);
  const resumeCommand = /^\s*foreman resume\b/i.test(text);
  const stop =
    /^\s*(stop|cancel|pause)(\s+(working|the workflow|this task))?[.!]?\s*$/i.test(
      text,
    );
  const guidance = resumeCommand
    ? text.replace(/^\s*foreman resume\b\s*:?\s*/i, "").trim()
    : /^(continue|resume)[.!]?$/i.test(text.trim())
      ? ""
      : text;

  return { bypass, resumeCommand, stop, guidance };
}

/** Coordinates saved workflow state, Jev decisions, and report validation. */
export class Controller {
  readonly workflow: Workflow;
  readonly maxTurns: number | undefined;
  private readonly compiler = new WorkflowCompiler();
  private readonly owner = randomUUID();
  private readonly decisions = new Map<string, AbortController>();

  constructor(
    readonly store: StateStore,
    readonly chooser: Chooser,
    options: { workflow: Workflow; maxTurns?: number },
  ) {
    this.workflow = this.compiler.compile(options.workflow).definition;
    this.maxTurns = options.maxTurns;

    if (
      this.maxTurns !== undefined &&
      (!Number.isSafeInteger(this.maxTurns) || this.maxTurns < 1)
    )
      throw new Error("Invalid supervisor configuration");
  }

  async get(id: string) {
    const state = findSession(await this.store.read(), id);

    return state ? viewState(state) : undefined;
  }

  async list() {
    return Object.values((await this.store.read()).workflows).map(viewState);
  }

  private async commitEvent(
    sessionID: string,
    event: Event,
    runChoice = false,
  ): Promise<ReturnType<typeof viewState> | undefined> {
    const committed = await this.store.transaction((db) => {
      const state = findSession(db, sessionID);

      if (!state) return undefined;

      const updated = applyWorkflowEvent(state, event, newTransitionContext());
      db.workflows[state.id] = updated;

      if (updated.phase.kind === "bypassed") {
        delete db.workflows[state.id];

        if (db.active === state.id) delete db.active;
      }

      return {
        state: viewState(updated),
        needsDecision: updated !== state && updated.phase.kind === "deciding",
      };
    });

    // The state is saved and the lock is released before calling Jev.
    if (runChoice && committed?.needsDecision) return this.decide(sessionID);

    return committed?.state;
  }

  private cancel(id: string) {
    this.decisions.get(id)?.abort();
  }

  async dispose() {
    for (const abort of this.decisions.values()) abort.abort();
  }

  private async decide(sessionID: string) {
    const snapshot = await this.store.transaction((db) => {
      const state = findSession(db, sessionID);

      if (!state || state.phase.kind !== "deciding") return undefined;

      const lease = state.phase.request.lease;

      if (lease && lease.expiresAt > Date.now() && isProcessAlive(lease.pid))
        return undefined;

      state.phase.request.lease = {
        owner: this.owner,
        pid: process.pid,
        expiresAt: Date.now() + 300000,
      };

      return structuredClone(state);
    });

    if (!snapshot || snapshot.phase.kind !== "deciding")
      return this.get(sessionID);

    const request = snapshot.phase.request;
    const abort = new AbortController();
    this.decisions.set(snapshot.id, abort);
    const compiled = this.compiler.compile(snapshot.workflow);
    const { criteria, instructions } = decisionPrompt(
      compiled.definition,
      request,
    );

    const diagnostic = routingDiagnostic(snapshot, {
      state: sanitize(decisionContext(snapshot)),
      criteria,
      instructions,
    });
    const persistDiagnostic = () =>
      appendRoutingDiagnostic(this.store.dir, diagnostic).catch(() => {
        console.warn("Foreman: could not write local routing diagnostics");
      });
    await persistDiagnostic();
    try {
      const answer = highestDecision(
        await this.chooser.choose(
          diagnostic.input.state,
          diagnostic.input.criteria,
          diagnostic.input.instructions,
          { sessionID, signal: abort.signal, decisionID: diagnostic.id },
        ),
        request.choices,
      );

      diagnostic.answer = answer;
      if (abort.signal.aborted) {
        diagnostic.status = "cancelled";
        return this.get(sessionID);
      }
      const result = await this.commitEvent(sessionID, {
        type: "decision",
        id: request.id,
        version: snapshot.version,
        answer,
        diagnosticID: diagnostic.id,
      });
      diagnostic.status =
        result?.status === "bypassed" ||
        result?.history.some((step) => step.decisionID === diagnostic.id)
          ? "applied"
          : "stale";
      return result;
    } catch (error) {
      if (abort.signal.aborted) {
        diagnostic.status = "cancelled";
        return this.get(sessionID);
      }
      diagnostic.status = "failed";
      const reason =
        error instanceof DecisionError
          ? error.message
          : "Jev decision failed. Check connectivity and credentials, then send foreman resume.";

      diagnostic.error = reason;
      return await this.commitEvent(sessionID, {
        type: "decisionFailed",
        id: request.id,
        version: snapshot.version,
        reason,
      });
    } finally {
      diagnostic.finishedAt = new Date().toISOString();
      await persistDiagnostic();
      if (this.decisions.get(snapshot.id) === abort)
        this.decisions.delete(snapshot.id);

      await this.store.transaction((db) => {
        const state = db.workflows[snapshot.id];
        const p =
          state?.phase.kind === "paused" ? state.phase.resume : state?.phase;

        if (
          p?.kind === "deciding" &&
          p.request.id === request.id &&
          p.request.lease?.owner === this.owner
        )
          delete p.request.lease;
      });
    }
  }

  async recover(sessionID: string) {
    const before = await this.get(sessionID);

    if (before?.phase.kind !== "deciding") return before;

    const after = await this.decide(sessionID);

    if (
      before.phase.request.gate === "admission" &&
      after?.phase.kind === "working"
    )
      return this.commitEvent(sessionID, { type: "queue" });

    return after;
  }

  async admit(
    sessionID: string,
    text: string,
    messageID?: string,
    synthetic = false,
    host?: { model?: ModelRef; agent?: string },
  ) {
    const existing = await this.get(sessionID);

    if (synthetic || (messageID && existing?.internalIDs.includes(messageID))) {
      if (
        messageID &&
        existing?.phase.kind === "dispatching" &&
        existing.phase.delivery.id === messageID
      )
        return this.commitEvent(sessionID, { type: "received", messageID });

      return existing;
    }

    if (existing) this.cancel(existing.id);

    const initial = await this.store.transaction((db) =>
      this.applyUserMessage(db, sessionID, text, messageID, host),
    );

    if (!initial) return undefined;

    let state =
      initial.phase.kind === "deciding"
        ? await this.decide(sessionID)
        : initial;

    if (state?.phase.kind === "dispatching") {
      // This real user turn can carry the continuation without another host request.
      state = await this.commitEvent(sessionID, {
        type: "received",
        messageID: state.phase.delivery.id,
        actualID: messageID ?? state.phase.delivery.id,
      });
    } else if (state?.phase.kind === "delivering" && messageID) {
      // A resume following a failed final response starts a fresh delivery response.
      state = await this.commitEvent(sessionID, {
        type: "retryDelivery",
        messageID,
      });
    }

    return state?.phase.kind === "bypassed" ? undefined : state;
  }

  /** Apply admission or resume changes together while the state transaction is held. */
  private applyUserMessage(
    db: Database,
    sessionID: string,
    text: string,
    messageID?: string,
    host?: { model?: ModelRef; agent?: string },
  ) {
    const { bypass, resumeCommand, stop, guidance } = parseUserMessage(text);

    let state = findSession(db, sessionID);

    if (bypass) {
      if (state) {
        const detachedState = applyWorkflowEvent(
          state,
          { type: "pause", reason: "Detached by user" },
          newTransitionContext(),
        );
        detachedState.sessionID = "detached:" + state.id;
        db.workflows[state.id] = detachedState;
      }

      return undefined;
    }

    if (state?.phase.kind === "complete" || state?.phase.kind === "bypassed") {
      state.sessionID = "finished:" + state.id;
      state = undefined;
    }

    if (!state && resumeCommand) {
      state = Object.values(db.workflows)
        .filter(
          (x) =>
            x.phase.kind === "paused" || x.sessionID.startsWith("detached:"),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

      if (!state) return undefined;

      state.sessionID = sessionID;
    }

    if (state) {
      state.model = host?.model ?? state.model;
      state.agent = host?.agent ?? state.agent;
      const event: Event = stop
        ? { type: "pause", reason: "Paused at the user’s request" }
        : {
            type: "resume",
            guidance: guidance || undefined,
            inputMessageID: messageID,
          };
      db.workflows[state.id] = applyWorkflowEvent(
        state,
        event,
        newTransitionContext(),
      );

      return viewState(db.workflows[state.id]!);
    }

    state = this.createRun(sessionID, text, messageID, host);
    db.workflows[state.id] = sanitize(state);
    db.active = state.id;

    return viewState(state);
  }

  private createRun(
    sessionID: string,
    text: string,
    messageID?: string,
    host?: { model?: ModelRef; agent?: string },
  ): WorkflowState {
    const context = newTransitionContext();
    const explicit = /^\s*foreman:/i.test(text);

    return {
      schema: 3,
      id: randomUUID(),
      sessionID,
      goal: text,
      workflow: structuredClone(this.workflow),
      workflowHash: this.compiler.compile(this.workflow).hash,
      capability: this.workflow.admission.entries[0]!,
      phase: {
        kind: "deciding",
        request: {
          id: context.decisionID,
          gate: "admission",
          choices: [
            ...this.workflow.admission.entries,
            ...(explicit ? [] : ["BYPASS"]),
          ],
          inputMessageID: messageID,
        },
      },
      version: 0,
      epoch: 0,
      revision: 0,
      createdAt: context.at,
      updatedAt: context.at,
      completed: {},
      capabilityOutputs: {},
      progress: [],
      guidance: [],
      evidence: [],
      history: [],
      internalIDs: [],
      turns: 0,
      stalls: 0,
      modelHistory: [],
      ...host,
    };
  }

  async pause(id: string, reason: string) {
    const state = await this.get(id);

    if (state) this.cancel(state.id);

    return this.commitEvent(id, { type: "pause", reason });
  }

  async recordModel(id: string, model: ModelRef) {
    await this.store.transaction((db) => {
      const state = findSession(db, id);

      if (!state) return;

      state.selectedModel = model;
      const last = state.modelHistory.at(-1);

      if (
        !last ||
        last.epoch !== state.epoch ||
        JSON.stringify(last.model) !== JSON.stringify(model)
      )
        state.modelHistory = [
          ...state.modelHistory,
          {
            capability: state.capability,
            epoch: state.epoch,
            model,
            at: new Date().toISOString(),
          },
        ].slice(-300);
    });
  }

  selectedModel(state: WorkflowState) {
    const name = state.workflow.capabilities[state.capability]!.model;

    return name ? parseModel(name) : state.model;
  }

  async report(id: string, input: Report) {
    const state = await this.get(id);

    if (!state || state.phase.kind !== "working")
      throw new Error("No active capability or report already accepted");

    const report = validateReport(input);
    const compiled = this.compiler.compile(state.workflow);
    const output = await validateReportOutput(
      compiled,
      state,
      report,
      resolve(this.store.dir, ".."),
    );

    await this.store.transaction((db) => {
      const current = findSession(db, id);

      if (!current || current.version !== state.version)
        throw new Error(
          "Workflow changed while checking report; retry with current state",
        );

      db.workflows[current.id] = applyWorkflowEvent(
        current,
        { type: "report", report, output },
        newTransitionContext(),
      );
    });
  }

  async beforeTool(id: string, tool: string, command?: string) {
    const state = await this.get(id);

    if (!state) return;

    if (tool === "foreman_status") return;

    if (state.phase.kind !== "working")
      throw new Error(
        state.phase.kind === "reported"
          ? "Report accepted; finish your response"
          : "Workflow " + state.status + ": stop",
      );

    if (tool === "foreman_report") return;

    const rules = state.workflow.capabilities[state.capability]!.tools;

    if (
      rules?.deny?.includes(tool) ||
      (rules?.allow && !rules.allow.includes(tool))
    )
      throw new Error("Tool unavailable in capability " + state.capability);

    const ref = this.compiler
      .compile(state.workflow)
      .capabilities.get(state.capability)!.commands;
    const commands = ref ? resolvedOutput(state, ref) : [];

    if (
      rules?.declaredChecksOnly &&
      ["bash", "shell"].includes(tool) &&
      (!Array.isArray(commands) || !commands.includes(command))
    )
      throw new Error("Only exact declared check commands are allowed");
  }

  async evidence(
    id: string,
    result: Omit<Evidence, "at" | "revision" | "epoch">,
  ) {
    await this.store.transaction((db) => {
      const state = findSession(db, id);

      if (
        !state ||
        state.phase.kind !== "working" ||
        !checkCommands(state).includes(result.command) ||
        state.evidence.some((e) => e.callID === result.callID)
      )
        return;

      const evidence = sanitize({
        ...result,
        output: result.output.slice(-5000),
        at: new Date().toISOString(),
        revision: state.revision,
        epoch: state.epoch,
      });
      db.workflows[state.id] = applyWorkflowEvent(
        state,
        { type: "evidence", evidence },
        newTransitionContext(),
      );
    });
  }

  async gate(id: string, messageID: string) {
    const before = await this.get(id);

    if (
      !before ||
      !["working", "reported"].includes(before.phase.kind) ||
      before.consumedMessage === messageID
    )
      return undefined;

    return this.commitEvent(
      id,
      {
        type: "idle",
        messageID,
        maxTurns: this.maxTurns,
      },
      true,
    );
  }

  async received(id: string, messageID: string) {
    return this.commitEvent(id, { type: "received", messageID });
  }

  async compactionAttempted(id: string, messageID: string) {
    return this.commitEvent(id, { type: "compactionAttempted", messageID });
  }

  async finished(
    id: string,
    messageID: string,
    parentID: string,
    error?: string,
  ) {
    return this.commitEvent(id, {
      type: "finished",
      messageID,
      parentID,
      error,
    });
  }

  async claimDelivery(id: string) {
    return this.store.transaction((db) => {
      const state = findSession(db, id);

      if (!state || state.phase.kind !== "dispatching") return undefined;

      const lease = state.phase.delivery.lease;

      if (lease && lease.expiresAt > Date.now() && isProcessAlive(lease.pid))
        return undefined;

      state.phase.delivery.lease = {
        owner: this.owner,
        pid: process.pid,
        expiresAt: Date.now() + 30000,
      };

      return viewState(state);
    });
  }

  async releaseDelivery(id: string, messageID: string) {
    await this.store.transaction((db) => {
      const state = findSession(db, id);
      const p =
        state?.phase.kind === "paused" ? state.phase.resume : state?.phase;

      if (
        (p?.kind === "dispatching" || p?.kind === "delivering") &&
        p.delivery.id === messageID &&
        p.delivery.lease?.owner === this.owner
      )
        delete p.delivery.lease;
    });
  }

  instructions(state: WorkflowState) {
    return workflowInstructions(state);
  }
}
