import { type Plugin, tool } from "@opencode-ai/plugin";
import { StateStore } from "../core/persistence/store.js";
import { Controller } from "../core/runtime/controller.js";
import { JevClient } from "../jev/client.js";
import { UsageLog } from "../jev/usage.js";
import { resolve } from "node:path";
import { loadWorkflowConfig } from "./config.js";
import type { WorkflowState } from "../core/types.js";
import { sanitize } from "../core/security.js";

export const ForemanPlugin: Plugin = async ({ directory, client }) => {
  if (process.env.FOREMAN_DISABLED === "1") return {};

  const workflow = await loadWorkflowConfig(directory);
  const usage = new UsageLog(directory);
  let connected = false;
  const notify = async (
    title: string,
    message: string,
    variant: "warning" | "success" = "warning",
  ) => {
    await client.app
      .log({
        body: {
          service: "foreman",
          level: variant === "warning" ? "warn" : "info",
          message: title + ": " + message,
        },
      })
      .catch(() => {});
    await client.tui
      .showToast({ body: { title, message, variant, duration: 12000 } })
      .catch(() => {});
  };
  const controller = new Controller(
    new StateStore(directory),
    new JevClient({
      onNotice: async (notice) => {
        if (notice.type === "connected") {
          if (!connected) {
            connected = true;
            await notify("Jev connected", notice.message, "success");
          }
        } else await notify("Jev retrying", notice.message);
      },
      onUsage: async (record) => {
        try {
          await usage.append(record);
        } catch {
          await client.app
            .log({
              body: {
                service: "foreman",
                level: "error",
                message:
                  "Could not write .foreman/usage.jsonl; Jev usage accounting may be incomplete.",
              },
            })
            .catch(() => {});

          throw new Error("Jev usage accounting could not be persisted");
        }
      },
    }),
    {
      workflow,
      maxTurns:
        process.env.FOREMAN_MAX_TURNS === undefined ||
        process.env.FOREMAN_MAX_TURNS === "unlimited"
          ? undefined
          : Number(process.env.FOREMAN_MAX_TURNS),
    },
  );
  let disposed = false;
  const active = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const log = async (message: string) => {
    await client.app
      .log({ body: { service: "foreman", level: "info", message } })
      .catch(() => {});
  };
  await log("Loaded Foreman workflow: " + workflow.name);
  async function selectModel(state: WorkflowState) {
    const model = controller.selectedModel(state);

    if (model) {
      await controller.recordModel(state.sessionID, model);
      await log(
        `Capability ${state.capability} model ${model.providerID}/${model.modelID}`,
      );
    }

    return model;
  }
  async function onIdle(sessionID: string) {
    if (disposed || active.has(sessionID)) return;

    active.add(sessionID);

    try {
      let s = await controller.get(sessionID);

      if (!s || ["paused", "complete", "bypassed"].includes(s.status)) return;

      const host = await client.session.status({ query: { directory } });

      if (host.error || !host.data) throw new Error("Cannot read host status");

      if (host.data[sessionID] && host.data[sessionID]!.type !== "idle") return;

      if (s.phase.kind === "deciding") s = await controller.recover(sessionID);

      if (!s) return;

      if (s.status === "paused") {
        await notify("Foreman paused", s.pauseReason ?? "Decision paused");

        return;
      }

      const hadPendingDelivery = s.phase.kind === "dispatching";

      if (
        hadPendingDelivery &&
        (await reconcileDelivery(sessionID)) === "waiting"
      )
        return;

      await processCompletedResponse(sessionID, hadPendingDelivery);
    } catch {
      await controller
        .pause(
          sessionID,
          "Supervisor host operation failed. Send foreman resume to retry the pending work.",
        )
        .catch(() => {});
      await notify(
        "Foreman paused",
        "Host operation failed; pending work is preserved. Send foreman resume.",
      );
    } finally {
      active.delete(sessionID);
    }
  }
  /** Reconcile the durable message ID before sending any continuation. */
  async function reconcileDelivery(
    sessionID: string,
  ): Promise<"received" | "waiting"> {
    const claimed = await controller.claimDelivery(sessionID);

    if (!claimed || claimed.phase.kind !== "dispatching") return "waiting";

    const delivery = claimed.phase.delivery;

    try {
      // Reconcile by the saved ID, not by a timing assumption or a recent-message window.
      const existing = await client.session.message({
        path: { id: sessionID, messageID: delivery.id },
        query: { directory },
      });

      if (existing.data) {
        await controller.received(sessionID, delivery.id);

        return "received";
      } else {
        if (existing.response?.status !== 404)
          throw new Error("Cannot reconcile continuation");

        const latest = await controller.get(sessionID);

        if (
          disposed ||
          latest?.phase.kind !== "dispatching" ||
          latest.phase.delivery.id !== delivery.id
        )
          return "waiting";

        const sent = await client.session.promptAsync({
          path: { id: sessionID },
          query: { directory },
          body: {
            messageID: delivery.id,
            model: await selectModel(latest),
            agent: latest.agent,
            parts: [
              {
                type: "text",
                text: delivery.text,
                synthetic: true,
              },
            ],
          },
        });

        if (sent.error) throw new Error("Continuation dispatch failed");

        return "waiting"; // The host callback or a recovery scan acknowledges receipt.
      }
    } finally {
      await controller.releaseDelivery(sessionID, delivery.id);
    }
  }

  async function processCompletedResponse(
    sessionID: string,
    hadPendingDelivery: boolean,
  ) {
    const s = await controller.get(sessionID);

    if (!s) return;

    const response = await client.session.messages({
      path: { id: sessionID },
      query: { directory },
    });

    if (response.error || !response.data)
      throw new Error("Cannot read session messages");

    const parentID =
      s.phase.kind === "delivering"
        ? s.phase.delivery.id
        : s.phase.kind === "working" || s.phase.kind === "reported"
          ? s.phase.inputMessageID
          : undefined;
    const last = response.data.findLast(
      (m) =>
        m.info.role === "assistant" &&
        (!parentID || m.info.parentID === parentID),
    );

    if (!last || last.info.role !== "assistant" || !last.info.time.completed) {
      if (hadPendingDelivery || s.phase.kind === "delivering") {
        await controller.pause(
          sessionID,
          "OpenCode received the saved continuation but no completed response is available. Send foreman resume to continue.",
        );
        await notify(
          "Foreman paused",
          "An interrupted host response needs resuming. Send foreman resume.",
        );
      }

      return;
    }

    if (s.phase.kind === "delivering") {
      const next = await controller.finished(
        sessionID,
        last.info.id,
        last.info.parentID,
        last.info.error
          ? "Final response failed. Send foreman resume to retry delivery."
          : undefined,
      );

      if (next?.status === "paused")
        await notify("Foreman paused", next.pauseReason!);

      return;
    }

    if (last.info.error) {
      await controller.pause(
        sessionID,
        "OpenCode agent failed or was interrupted. Send foreman resume.",
      );
      await notify(
        "Foreman paused",
        "OpenCode response failed. Send foreman resume.",
      );

      return;
    }

    const next = await controller.gate(sessionID, last.info.id);

    if (next?.status === "paused")
      await notify(
        "Foreman paused",
        [...next.questions, next.pauseReason ?? ""].join("\n"),
      );
    else if (next?.phase.kind === "dispatching") schedule(sessionID);
  }

  function schedule(sessionID: string) {
    if (disposed) return;

    if (timers.has(sessionID)) clearTimeout(timers.get(sessionID));

    timers.set(
      sessionID,
      setTimeout(() => {
        timers.delete(sessionID);
        void onIdle(sessionID);
      }, 150),
    );
  }
  async function recover() {
    if (disposed) return;

    try {
      for (const s of await controller.list())
        if (
          ["dispatching", "deciding", "delivering", "reported"].includes(
            s.phase.kind,
          )
        )
          schedule(s.sessionID);
    } catch {
      await log(
        "Could not recover Foreman state; run foreman_status to inspect local state.",
      );
    }
  }
  const startup = setTimeout(() => void recover(), 300);
  const recovery = setInterval(() => void recover(), 5000);
  startup.unref?.();
  recovery.unref?.();
  const strings = tool.schema
    .array(tool.schema.string().max(24000))
    .max(1000)
    .optional();

  return {
    dispose: async () => {
      disposed = true;
      clearTimeout(startup);
      clearInterval(recovery);

      for (const timer of timers.values()) clearTimeout(timer);

      await controller.dispose();
    },
    "chat.message": async (input, output) => {
      if (!(await controller.get(input.sessionID))) {
        const session = await client.session.get({
          path: { id: input.sessionID },
          query: { directory },
        });

        // The parent workflow owns native subagent work; don't admit a second project.
        if (session.data?.parentID) return;
      }

      const parts = output.parts.filter((p) => p.type === "text");
      const text = parts.map((p) => p.text).join("\n");
      // Synthetic host messages (compaction) and persisted internal IDs never create a goal.
      const existing = await controller.get(input.sessionID);
      const state = await controller.admit(
        input.sessionID,
        text,
        output.message.id,
        parts.length > 0 && parts.every((p) => p.synthetic),
        {
          model: input.model ?? existing?.model ?? output.message.model,
          agent: input.agent,
        },
      );

      if (state) {
        if (state.status === "paused") {
          await notify(
            "Foreman paused",
            state.pauseReason ?? "Awaiting user input",
          );

          return;
        }

        const model = await selectModel(state);

        if (model) {
          const changed =
            output.message.model?.providerID !== model.providerID ||
            output.message.model?.modelID !== model.modelID;
          output.message.model = model;

          // Provider-specific variants must not leak onto a different model.
          if (changed) delete (output.message as { variant?: string }).variant;
        }
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;

      const s = await controller.get(input.sessionID);

      if (s) output.system.push(controller.instructions(s));
    },
    "experimental.session.compacting": async (input, output) => {
      const s = await controller.get(input.sessionID);

      if (s) output.context.push(controller.instructions(s));
    },
    "shell.env": async (_input, output) => {
      output.env.TYPESAFE_API_KEY = "";
    },
    "tool.execute.before": async (input, output) => {
      await controller.beforeTool(
        input.sessionID,
        input.tool,
        output.args?.command,
      );
    },
    "tool.execute.after": async (input, output) => {
      if (
        !["bash", "shell"].includes(input.tool) ||
        typeof input.args?.command !== "string"
      )
        return;

      const cwd = input.args.workdir ?? input.args.cwd ?? directory;

      if (resolve(cwd) !== resolve(directory)) return;

      await controller.evidence(input.sessionID, {
        callID: input.callID,
        command: input.args.command,
        exit:
          typeof output.metadata?.exit === "number"
            ? output.metadata.exit
            : null,
        output: output.output,
      });
    },
    event: async ({ event }) => {
      if (event.type === "session.error" && event.properties.sessionID) {
        await controller
          .pause(
            event.properties.sessionID,
            "OpenCode reported an error or cancellation. Reply after resolving it to resume.",
          )
          .catch(() => {});
      }

      if (event.type !== "session.idle") return;

      const sessionID = event.properties.sessionID;
      schedule(sessionID);
    },
    tool: {
      foreman_status: tool({
        description:
          "Read the durable Foreman workflow and current capability. No transition is requested.",
        args: { producer: tool.schema.string().optional() },
        execute: async (args, context) => {
          const state = await controller.get(context.sessionID);
          if (!state) return JSON.stringify({ managed: false });
          if (args.producer)
            return JSON.stringify({
              capability: state.capability,
              producer: args.producer,
              completed: Object.hasOwn(state.completed, args.producer),
              output: state.capabilityOutputs[args.producer] ?? null,
            });
          return controller.instructions(state);
        },
      }),
      foreman_report: tool({
        description:
          "Report the CURRENT capability. Put workflow-defined outputs in data. For incomplete/blocked omit data and describe findings in summary. Questions are essential human decisions only. covered contains exact labels required by an acceptance gate. After acceptance, finish the response. Correct a rejected report in this turn.",
        args: {
          summary: tool.schema.string().min(1).max(4000),
          outcome: tool.schema.enum(["ready", "incomplete", "blocked"]),
          data: tool.schema
            .record(tool.schema.string(), tool.schema.unknown())
            .optional(),
          questions: strings,
          covered: strings,
        },
        execute: async (args, context) => {
          try {
            await controller.report(context.sessionID, args);
          } catch (error) {
            const state = await controller.get(context.sessionID);
            const reason =
              error instanceof Error ? error.message : "Report rejected";
            const correction = state
              ? `Correct the report for capability ${state.capability}. Omit data if that capability has no output schema. Read foreman_status for the current workflow instructions.`
              : "Read foreman_status before retrying; no managed workflow is available.";
            throw new Error(
              sanitize(`${reason}\nThe report was not accepted. ${correction}`),
              { cause: error },
            );
          }

          return "Capability report persisted. Finish your response now. Foreman selects the next eligible capability.";
        },
      }),
    },
  };
};
