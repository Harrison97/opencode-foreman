import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
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
import { mergeOutput, resolvedOutput } from "./output.js";
import { outputReference } from "../workflow/references.js";
import { decisionContext } from "./context.js";
import { reduceRun, type Event, type Entropy } from "./engine.js";

const entropy = (): Entropy => ({
  at: new Date().toISOString(),
  decisionID: randomUUID(),
  messageID:
    "msg_" + Date.now().toString(16) + randomUUID().replaceAll("-", ""),
});
// Budget the encoded JSON string, including escaping and multi-byte characters.
function boundedText(value: string, limit: number): string {
  let low = 0,
    high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(value.slice(0, mid))) - 2 <= limit)
      low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low);
}
export function findSession(db: Database, id: string) {
  return Object.values(db.workflows).find((s) => s.sessionID === id);
}
export function eligible(s: WorkflowState, ids: string[]) {
  return eligibleCapabilities(
    s.workflow,
    new Set(Object.keys(s.completed)),
    ids,
  );
}
export function checkCommands(s: WorkflowState): string[] {
  const field = s.workflow.capabilities[s.capability]?.gate?.commands;
  const ref = field ? outputReference(field) : undefined;
  const values = ref ? resolvedOutput(s, ref) : undefined;
  return Array.isArray(values) &&
    values.every((x) => typeof x === "string" && x.trim())
    ? values
    : [];
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Effect runner: pure transitions are committed in short transactions; Jev and files are checked outside locks. */
export class Controller {
  readonly workflow: Workflow;
  readonly maxTurns: number;
  private readonly compiler = new WorkflowCompiler();
  private readonly owner = randomUUID();
  private readonly decisions = new Map<string, AbortController>();
  constructor(
    readonly store: StateStore,
    readonly chooser: Chooser,
    options: { workflow: Workflow; maxTurns?: number },
  ) {
    this.workflow = this.compiler.compile(options.workflow).definition;
    this.maxTurns = options.maxTurns ?? 40;
    if (!Number.isInteger(this.maxTurns) || this.maxTurns < 1)
      throw new Error("Invalid supervisor configuration");
  }
  async get(id: string) {
    const s = findSession(await this.store.read(), id);
    return s ? viewState(s) : undefined;
  }
  async list() {
    return Object.values((await this.store.read()).workflows).map(viewState);
  }
  private async event(
    sessionID: string,
    event: Event,
    runChoice = false,
  ): Promise<ReturnType<typeof viewState> | undefined> {
    const committed = await this.store.transaction((db) => {
      const s = findSession(db, sessionID);
      if (!s) return undefined;
      const result = reduceRun(s, event, entropy());
      db.workflows[s.id] = result.state;
      if (result.state.phase.kind === "bypassed") {
        delete db.workflows[s.id];
        if (db.active === s.id) delete db.active;
      }
      return { state: viewState(result.state), effects: result.effects };
    });
    // Execute external work only after the durable reduction releases its lock.
    if (
      runChoice &&
      committed?.effects.some((effect) => effect.type === "choose")
    )
      return this.decide(sessionID);
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
      const s = findSession(db, sessionID);
      if (!s || s.phase.kind !== "deciding") return undefined;
      const lease = s.phase.request.lease;
      if (lease && lease.expiresAt > Date.now() && alive(lease.pid))
        return undefined;
      s.phase.request.lease = {
        owner: this.owner,
        pid: process.pid,
        expiresAt: Date.now() + 300000,
      };
      return structuredClone(s);
    });
    if (!snapshot || snapshot.phase.kind !== "deciding")
      return this.get(sessionID);
    const request = snapshot.phase.request;
    const abort = new AbortController();
    this.decisions.set(snapshot.id, abort);
    const compiled = this.compiler.compile(snapshot.workflow);
    const emptyCriteria = Object.fromEntries(
      request.choices.map((id) => [id, ""]),
    );
    const each = Math.max(
      0,
      Math.floor(
        (8000 - Buffer.byteLength(JSON.stringify(emptyCriteria))) /
          request.choices.length,
      ),
    );
    const criteria = Object.fromEntries(
      request.choices.map((id) => [
        id,
        boundedText(
          id === "BYPASS"
            ? "Handle normally without this workflow"
            : compiled.definition.capabilities[id]!.purpose,
          each,
        ),
      ]),
    );
    const instructions = boundedText(
      request.gate === "admission"
        ? snapshot.workflow.admission.instructions
        : "Choose the next useful capability among ONLY the eligible options. Use the latest user guidance, outcome and evidence. Avoid repeating unchanged work.",
      2000,
    );
    try {
      const answer = highestDecision(
        await this.chooser.choose(
          sanitize(decisionContext(snapshot)),
          criteria,
          instructions,
          { sessionID, signal: abort.signal },
        ),
        request.choices,
      );
      if (abort.signal.aborted) return this.get(sessionID);
      return await this.event(sessionID, {
        type: "decision",
        id: request.id,
        version: snapshot.version,
        answer,
      });
    } catch (error) {
      if (abort.signal.aborted) return this.get(sessionID);
      const reason =
        error instanceof DecisionError
          ? error.message
          : "Jev decision failed. Check connectivity and credentials, then send foreman resume.";
      return await this.event(sessionID, {
        type: "decisionFailed",
        id: request.id,
        version: snapshot.version,
        reason,
      });
    } finally {
      if (this.decisions.get(snapshot.id) === abort)
        this.decisions.delete(snapshot.id);
      await this.store.transaction((db) => {
        const s = db.workflows[snapshot.id];
        const p = s?.phase.kind === "paused" ? s.phase.resume : s?.phase;
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
      return this.event(sessionID, { type: "queue" });
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
        return this.event(sessionID, { type: "received", messageID });
      return existing;
    }
    if (existing) this.cancel(existing.id);
    const bypass = /^\s*(?:foreman|jev) bypass:/i.test(text);
    const resumeCommand = /^\s*(?:foreman|jev) resume\b/i.test(text);
    const stop =
      /^\s*(stop|cancel|pause)(\s+(working|the workflow|this task))?[.!]?\s*$/i.test(
        text,
      );
    const guidance = resumeCommand
      ? text.replace(/^\s*(?:foreman|jev) resume\b\s*:?\s*/i, "").trim()
      : /^(continue|resume)[.!]?$/i.test(text.trim())
        ? ""
        : text;
    const initial = await this.store.transaction((db) => {
      let s = findSession(db, sessionID);
      if (bypass) {
        if (s) {
          const r = reduceRun(
            s,
            { type: "pause", reason: "Detached by user" },
            entropy(),
          ).state;
          r.sessionID = "detached:" + s.id;
          db.workflows[s.id] = r;
        }
        return undefined;
      }
      if (s?.phase.kind === "complete" || s?.phase.kind === "bypassed") {
        s.sessionID = "finished:" + s.id;
        s = undefined;
      }
      if (!s && resumeCommand) {
        s = Object.values(db.workflows)
          .filter(
            (x) =>
              x.phase.kind === "paused" || x.sessionID.startsWith("detached:"),
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        if (!s) return undefined;
        s.sessionID = sessionID;
      }
      if (s) {
        s.model = host?.model ?? s.model;
        s.agent = host?.agent ?? s.agent;
        const event: Event = stop
          ? { type: "pause", reason: "Paused at the user’s request" }
          : {
              type: "resume",
              guidance: guidance || undefined,
              inputMessageID: messageID,
            };
        db.workflows[s.id] = reduceRun(s, event, entropy()).state;
        return viewState(db.workflows[s.id]!);
      }
      const e = entropy();
      const explicit = /^\s*(?:foreman|jev):/i.test(text);
      s = {
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
            id: e.decisionID,
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
        createdAt: e.at,
        updatedAt: e.at,
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
      db.workflows[s.id] = sanitize(s);
      db.active = s.id;
      return viewState(s);
    });
    if (!initial) return undefined;
    let state =
      initial.phase.kind === "deciding"
        ? await this.decide(sessionID)
        : initial;
    if (state?.phase.kind === "dispatching") {
      // This real user turn can carry the continuation without another host request.
      state = await this.event(sessionID, {
        type: "received",
        messageID: state.phase.delivery.id,
        actualID: messageID ?? state.phase.delivery.id,
      });
    } else if (state?.phase.kind === "delivering" && messageID) {
      // A resume following a failed final response starts a fresh delivery response.
      state = await this.event(sessionID, { type: "retryDelivery", messageID });
    }
    return state?.phase.kind === "bypassed" ? undefined : state;
  }
  async pause(id: string, reason: string) {
    const s = await this.get(id);
    if (s) this.cancel(s.id);
    return this.event(id, { type: "pause", reason });
  }
  async recordModel(id: string, model: ModelRef) {
    await this.store.transaction((db) => {
      const s = findSession(db, id);
      if (!s) return;
      s.selectedModel = model;
      const last = s.modelHistory.at(-1);
      if (
        !last ||
        last.epoch !== s.epoch ||
        JSON.stringify(last.model) !== JSON.stringify(model)
      )
        s.modelHistory = [
          ...s.modelHistory,
          {
            capability: s.capability,
            epoch: s.epoch,
            model,
            at: new Date().toISOString(),
          },
        ].slice(-300);
    });
  }
  selectedModel(s: WorkflowState) {
    const name = s.workflow.capabilities[s.capability]!.model;
    return name ? parseModel(name) : s.model;
  }
  async report(id: string, input: Report) {
    const s = await this.get(id);
    if (!s || s.phase.kind !== "working")
      throw new Error("No active capability or report already accepted");
    const r = sanitize(input);
    if (Buffer.byteLength(JSON.stringify(r)) > 64000)
      throw new Error("Report exceeds 64 KB");
    if (
      !r.summary?.trim() ||
      !["ready", "incomplete", "blocked"].includes(r.outcome)
    )
      throw new Error("Invalid capability report");
    if (r.outcome === "ready" && r.questions?.length)
      throw new Error("Ready report cannot contain unresolved questions");
    const compiled = this.compiler.compile(s.workflow);
    const cap = compiled.capabilities.get(s.capability)!;
    let output: Record<string, unknown> | undefined;
    if (r.outcome !== "ready") {
      if (Object.keys(r.data ?? {}).length)
        throw new Error("Incomplete reports cannot publish outputs");
    } else {
      output = mergeOutput(compiled, s, r.data ?? {});
      if (cap.files) {
        const paths = Array.isArray(cap.files)
          ? cap.files
          : "producer" in cap.files
            ? cap.files.producer === s.capability
              ? output[cap.files.field]
              : resolvedOutput(s, cap.files)
            : undefined;
        if (
          !Array.isArray(paths) ||
          !paths.length ||
          paths.some((p) => typeof p !== "string" || !p.trim())
        )
          throw new Error("Required artifact path list is missing or invalid");
        const root = await realpath(resolve(this.store.dir, ".."));
        for (const name of paths) {
          const file = await realpath(resolve(root, name)).catch(
            () => undefined,
          );
          const rel = file ? relative(root, file) : "..";
          if (
            !file ||
            isAbsolute(name) ||
            rel === ".." ||
            rel.startsWith("../") ||
            isAbsolute(rel) ||
            !(await stat(file)).isFile()
          )
            throw new Error(
              "Required artifact missing or outside project: " + name,
            );
        }
      }
      if (cap.commands) {
        const commands = resolvedOutput(s, cap.commands);
        if (
          !Array.isArray(commands) ||
          !commands.length ||
          commands.some((c) => typeof c !== "string" || !c.trim())
        )
          throw new Error("Required command list is missing");
        for (const command of commands) {
          const last = s.evidence.findLast(
            (e) =>
              e.command === command &&
              e.epoch === s.epoch &&
              e.revision === s.revision,
          );
          if (last?.exit !== 0)
            throw new Error(
              "Missing fresh passing native evidence for: " +
                command +
                ". Report incomplete to request repair.",
            );
        }
      }
      if (cap.acceptance) {
        const labels = resolvedOutput(s, cap.acceptance);
        if (
          !Array.isArray(labels) ||
          !labels.length ||
          labels.some((l) => typeof l !== "string")
        )
          throw new Error("Missing coverage contract");
        if (labels.some((l) => !r.covered?.includes(l)))
          throw new Error(
            "Missing exact coverage. Correct the report; fresh checks do not need to be rerun.",
          );
      }
    }
    await this.store.transaction((db) => {
      const current = findSession(db, id);
      if (!current || current.version !== s.version)
        throw new Error(
          "Workflow changed while checking report; retry with current state",
        );
      db.workflows[current.id] = reduceRun(
        current,
        { type: "report", report: r, output },
        entropy(),
      ).state;
    });
  }
  async beforeTool(id: string, tool: string, command?: string) {
    const s = await this.get(id);
    if (!s) return;
    if (tool === "jev_status") return;
    if (s.phase.kind !== "working")
      throw new Error(
        s.phase.kind === "reported"
          ? "Report accepted; finish your response"
          : "Workflow " + s.status + ": stop",
      );
    if (tool === "jev_report") return;
    const rules = s.workflow.capabilities[s.capability]!.tools;
    if (
      rules?.deny?.includes(tool) ||
      (rules?.allow && !rules.allow.includes(tool))
    )
      throw new Error("Tool unavailable in capability " + s.capability);
    const ref = this.compiler
      .compile(s.workflow)
      .capabilities.get(s.capability)!.commands;
    const commands = ref ? resolvedOutput(s, ref) : [];
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
      const s = findSession(db, id);
      if (
        !s ||
        s.phase.kind !== "working" ||
        !checkCommands(s).includes(result.command) ||
        s.evidence.some((e) => e.callID === result.callID)
      )
        return;
      const evidence = sanitize({
        ...result,
        output: result.output.slice(-5000),
        at: new Date().toISOString(),
        revision: s.revision,
        epoch: s.epoch,
      });
      db.workflows[s.id] = reduceRun(
        s,
        { type: "evidence", evidence },
        entropy(),
      ).state;
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
    return this.event(
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
    return this.event(id, { type: "received", messageID });
  }
  async finished(
    id: string,
    messageID: string,
    parentID: string,
    error?: string,
  ) {
    return this.event(id, { type: "finished", messageID, parentID, error });
  }
  async claimDelivery(id: string) {
    return this.store.transaction((db) => {
      const s = findSession(db, id);
      if (!s || s.phase.kind !== "dispatching") return undefined;
      const lease = s.phase.delivery.lease;
      if (lease && lease.expiresAt > Date.now() && alive(lease.pid))
        return undefined;
      s.phase.delivery.lease = {
        owner: this.owner,
        pid: process.pid,
        expiresAt: Date.now() + 30000,
      };
      return viewState(s);
    });
  }
  async releaseDelivery(id: string, messageID: string) {
    await this.store.transaction((db) => {
      const s = findSession(db, id);
      const p = s?.phase.kind === "paused" ? s.phase.resume : s?.phase;
      if (
        (p?.kind === "dispatching" || p?.kind === "delivering") &&
        p.delivery.id === messageID &&
        p.delivery.lease?.owner === this.owner
      )
        delete p.delivery.lease;
    });
  }
  instructions(s: WorkflowState) {
    const c = s.workflow.capabilities[s.capability]!;
    const v = viewState(s);
    return [
      "Foreman workflow: " + s.workflow.name,
      "CURRENT CAPABILITY: " + s.capability,
      "Runtime phase: " + s.phase.kind,
      "Purpose: " + c.purpose,
      c.instructions,
      "Completion: " + c.completion,
      "Output JSON schema: " + JSON.stringify(c.outputs ?? null),
      "Tool rules: " + JSON.stringify(c.tools ?? {}),
      "Required gates: " + JSON.stringify(c.gate ?? {}),
      v.status === "paused"
        ? "Present the pause reason and questions; wait for real user input. Do not use tools."
        : v.status === "delivering" || v.status === "complete"
          ? "Deliver this capability’s final response. Do not use tools."
          : "Perform only the current capability. Call jev_report with summary, outcome and workflow-defined data. Incomplete/blocked reports cannot publish outputs. Questions are essential human decisions only. Correct rejected reports; finish your response after acceptance. Foreman chooses the next capability.",
      "Outputs are scoped by producer. Reference capabilityOutputs[capability][field]. Carry forward earlier criteria explicitly when producing your own contract. Never edit Foreman state/config to bypass gates or expose credentials.",
      JSON.stringify(
        sanitize({
          goal: s.goal,
          guidance: s.guidance,
          capabilityOutputs: s.capabilityOutputs,
          completed: s.completed,
          progress: s.progress.slice(-8),
          questions: v.questions,
          pauseReason: v.pauseReason,
          reportAccepted: s.phase.kind === "reported",
        }),
      ),
    ].join("\n");
  }
}
