import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../../src/core/runtime/controller.js";
import { StateStore } from "../../src/core/persistence/store.js";
import type { Workflow, Chooser } from "../../src/core/types.js";
export const sample: Workflow = {
  version: 1,
  name: "editorial",
  admission: {
    instructions:
      "Use the editorial workflow for substantial writing; BYPASS casual questions.",
    entries: ["draft"],
  },
  capabilities: {
    draft: {
      purpose: "Draft copy",
      instructions: "Write copy with a voice contract.",
      completion: "Copy and checks exist",
      outputs: {
        type: "object",
        additionalProperties: false,
        required: ["checks", "labels"],
        properties: {
          checks: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
          labels: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
        },
      },
      append: ["labels"],
      next: { ready: ["proof"], incomplete: ["draft"], blocked: ["draft"] },
    },
    proof: {
      purpose: "Proofread",
      instructions: "Check copy and labels.",
      completion: "Evidence is complete",
      dependsOn: ["draft"],
      tools: { allow: ["read", "bash"], declaredChecksOnly: true },
      gate: { commands: "draft.checks", acceptance: "draft.labels" },
      next: { ready: ["publish"], incomplete: ["draft"], blocked: ["draft"] },
    },
    publish: {
      purpose: "Deliver copy",
      instructions: "Deliver the finished text.",
      completion: "Delivered",
      dependsOn: ["proof"],
      terminal: true,
    },
  },
};
export const chooser = (preferred = "draft", confidence = 1): Chooser => ({
  choose: async (_state, criteria) => {
    const keys = Object.keys(criteria);
    const choice = keys.includes(preferred) ? preferred : keys[0]!;
    return {
      choice,
      confidence,
      probabilities: Object.fromEntries(
        keys.map((k) => [k, k === choice ? 1 : 0]),
      ),
    };
  },
});
export const ready = {
  summary: "Drafted",
  outcome: "ready" as const,
  data: { checks: ["node --test"], labels: ["Correct tone"] },
};
export async function fixture(workflow = sample, select = chooser()) {
  const root = await mkdtemp(join(tmpdir(), "foreman-test-"));
  const store = new StateStore(root);
  const c = new Controller(store, select, { workflow });
  await c.admit("s", "foreman: Write a handbook", "msg_user");
  return { root, store, c, state: async () => (await c.get("s"))! };
}
export async function advance(c: Controller, id = "s", message = "msg_draft") {
  await c.report(id, ready);
  const next = await c.gate(id, message);
  if (next?.pending)
    await c.admit(id, next.pending.text, next.pending.id, true);
  return next!;
}
export async function deliver(c: Controller, id = "s") {
  const s = (await c.get(id))!;
  if (s.phase.kind === "dispatching") await c.received(id, s.phase.delivery.id);
  const waiting = (await c.get(id))!;
  if (waiting.phase.kind !== "delivering")
    throw new Error("Expected delivery phase");
  await c.finished(id, "assistant-final", waiting.phase.delivery.id);
  return (await c.get(id))!;
}
