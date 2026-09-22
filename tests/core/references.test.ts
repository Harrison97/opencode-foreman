import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkflow } from "../../src/core/workflow/schema.js";
import {
  Controller,
  checkCommands,
} from "../../src/core/runtime/controller.js";
import { StateStore } from "../../src/core/persistence/store.js";
import { outputValue } from "../../src/core/workflow/references.js";
import {
  fixture,
  sample,
  ready,
  chooser,
  advance,
  deliver,
} from "../support/fixtures.js";

test("gates require capability.output and reject missing producers, fields, and self references", () => {
  for (const [ref, error] of [
    ["checks", /Use capability.output/],
    ["unknown.checks", /Unknown output producer unknown/],
    ["draft.ceptance", /No declared output draft.ceptance/],
    ["draft.checks.nested", /Use capability.output/],
    ["proof.checks", /not its own output/],
  ] as const) {
    const w = structuredClone(sample);
    w.capabilities.proof!.gate!.commands = ref;
    assert.throws(() => parseWorkflow(w), error);
  }
});

test("qualified gates use the named producer even after another capability overwrites shared fields", async () => {
  const w = structuredClone(sample);
  w.capabilities.draft!.next!.ready = ["other"];
  w.capabilities.other = {
    ...structuredClone(w.capabilities.draft!),
    dependsOn: ["draft"],
    next: { ready: ["proof"], incomplete: ["draft"] },
  };
  const f = await fixture(w);
  await advance(f.c);
  assert.equal((await f.state()).capability, "other");
  await f.c.report("s", {
    ...ready,
    data: { checks: ["node other-check.mjs"], labels: ["Other criterion"] },
  });
  const next = await f.c.gate("s", "other-done");
  await f.c.admit("s", "continue", next!.pending!.id, true);
  const c = new Controller(new StateStore(f.root), chooser(), { workflow: w });
  const s = (await c.get("s"))!;
  assert.deepEqual(s.capabilityOutputs.other!.checks, ["node other-check.mjs"]);
  assert.deepEqual(checkCommands(s), ["node --test"]);
  assert.deepEqual(outputValue(s, "draft.labels"), ["Correct tone"]);
  await assert.rejects(
    c.beforeTool("s", "bash", "node other-check.mjs"),
    /exact declared/,
  );
  await c.beforeTool("s", "bash", "node --test");
  await c.evidence("s", {
    callID: "pass",
    command: "node --test",
    exit: 0,
    output: "pass",
  });
  await c.report("s", {
    summary: "Verified original contract",
    outcome: "ready",
    covered: ["Correct tone"],
  });
  assert.equal((await c.gate("s", "proof-done"))?.status, "delivering");
  assert.equal((await deliver(c)).status, "complete");
});

test("invalidated producers cannot supply stale outputs; reruns replace optional fields", async () => {
  const w = structuredClone(sample);
  (w.capabilities.draft!.outputs!.properties as Record<string, unknown>).note =
    { type: "string" };
  const f = await fixture(w);
  await f.c.report("s", {
    ...ready,
    data: { ...ready.data, note: "old note" },
  });
  const next = await f.c.gate("s", "draft");
  await f.c.admit("s", "continue", next!.pending!.id, true);
  assert.equal(outputValue(await f.state(), "draft.note"), "old note");
  await f.c.report("s", { summary: "Repair", outcome: "incomplete" });
  const back = await f.c.gate("s", "repair");
  await f.c.admit("s", "continue", back!.pending!.id, true);
  assert.equal(outputValue(await f.state(), "draft.checks"), undefined);
  await f.c.report("s", ready);
  await f.c.gate("s", "repaired");
  assert.deepEqual(outputValue(await f.state(), "draft.checks"), [
    "node --test",
  ]);
  assert.equal(outputValue(await f.state(), "draft.note"), undefined);
});

test("invalid stored states are rejected atomically at the boundary", async () => {
  const f = await fixture();
  const before = await f.state();
  await assert.rejects(
    f.store.transaction((db) => {
      delete (db.workflows[db.active!] as any).capabilityOutputs;
    }),
    /Invalid Foreman state schema/,
  );
  assert.deepEqual(await f.state(), before);
});
