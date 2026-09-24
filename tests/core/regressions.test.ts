import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Controller } from "../../src/core/runtime/controller.js";
import { StateStore } from "../../src/core/persistence/store.js";
import { JevClient } from "../../src/jev/client.js";
import { workflowInstructions } from "../../src/core/runtime/instructions.js";
import { readRoutingDiagnostics } from "../../src/core/runtime/diagnostics.js";
import {
  fixture,
  sample,
  ready,
  advance,
  chooser,
} from "../support/fixtures.js";

test("gated command outputs are explicitly required to be runnable shell commands", async () => {
  const w = structuredClone(sample);
  const draft = w.capabilities.draft!;
  const properties = draft.outputs!.properties as Record<string, unknown>;
  properties.commands = properties.checks;
  delete properties.checks;
  draft.outputs!.required = ["commands", "labels"];
  w.capabilities.proof!.gate!.commands = "draft.commands";

  const f = await fixture(w);
  assert.match(
    workflowInstructions(await f.state()),
    /Commands contract: every commands item is a finite, directly runnable shell command/,
  );

  const noCommandGate = await fixture(sample);
  assert.doesNotMatch(
    workflowInstructions(await noCommandGate.state()),
    /Commands contract:/,
  );
});

test("append validates the final snapshot atomically, including artifact paths", async () => {
  const w = structuredClone(sample);
  (w.capabilities.draft!.outputs!.properties as any).labels.maxItems = 1;
  const f = await fixture(w);
  await advance(f.c);
  await f.c.report("s", { summary: "repair", outcome: "incomplete" });
  const back = await f.c.gate("s", "repair");
  await f.c.admit("s", "continue", back!.pending!.id, true);
  const before = await f.state();
  await assert.rejects(
    f.c.report("s", { ...ready, data: { ...ready.data, labels: ["new"] } }),
    /Invalid capability output/,
  );
  assert.deepEqual(await f.state(), before);
  const artifacts = structuredClone(sample);
  (artifacts.capabilities.draft!.outputs!.properties as any).files = {
    type: "array",
    items: { type: "string" },
    minItems: 1,
  };
  (artifacts.capabilities.draft!.outputs!.required as string[]).push("files");
  artifacts.capabilities.draft!.append!.push("files");
  artifacts.capabilities.draft!.gate = { files: "draft.files" };
  const g = await fixture(artifacts);
  await writeFile(join(g.root, "old.md"), "old");
  await g.c.report("s", {
    ...ready,
    data: { ...ready.data, files: ["old.md"] },
  });
  const p = await g.c.gate("s", "first");
  await g.c.admit("s", "continue", p!.pending!.id, true);
  await g.c.report("s", { summary: "repair", outcome: "incomplete" });
  const q = await g.c.gate("s", "back");
  await g.c.admit("s", "continue", q!.pending!.id, true);
  await unlink(join(g.root, "old.md"));
  await writeFile(join(g.root, "new.md"), "new");
  await assert.rejects(
    g.c.report("s", { ...ready, data: { ...ready.data, files: ["new.md"] } }),
    /artifact missing/,
  );
});

test("a large accepted report produces a bounded request instead of an unrecoverable pause", async () => {
  const w = structuredClone(sample);
  (w.capabilities.draft!.outputs!.properties as any).notes = { type: "string" };
  const f = await fixture(w);
  await f.c.report("s", {
    ...ready,
    data: { ...ready.data, notes: "x".repeat(45000) },
  });
  let size = 0;
  const client = new JevClient({
    key: "fake",
    fetch: async (_url, args) => {
      size = Buffer.byteLength(args!.body as string);
      return Response.json({
        answers: {
          next: {
            type: "choice",
            choice: "proof",
            confidence: 1,
            probabilities: { proof: 1 },
          },
        },
      });
    },
  });
  const c = new Controller(f.store, client, { workflow: w });
  const next = await c.gate("s", "done");
  assert.equal(next?.capability, "proof");
  assert.ok(size > 0 && size < 28000);
  assert.equal(
    (await f.state()).capabilityOutputs.draft!.notes!.toString().length,
    45000,
  );
  assert.ok(
    !Object.hasOwn(
      JSON.parse(await readFile(f.store.path, "utf8")).workflows[
        (await f.state()).id
      ],
      "data",
    ),
  );
});

test("pause is immediate during a slow choice and its late result cannot advance the run", async () => {
  const f = await fixture();
  await f.c.report("s", ready);
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((r) => (release = r));
  const entered = new Promise<void>((r) => (started = r));
  let signal: AbortSignal | undefined;
  const c = new Controller(
    f.store,
    {
      choose: async (s, criteria, instructions, context) => {
        signal = context?.signal;
        started();
        await waiting;
        return chooser().choose(s, criteria, instructions);
      },
    },
    { workflow: sample },
  );
  const pending = c.gate("s", "done");
  await entered;
  assert.equal(
    (await readRoutingDiagnostics(f.store.dir, "s")).records.at(-1)!.status,
    "pending",
  );
  const pause = c.pause("s", "User stopped");
  try {
    await Promise.race([
      pause,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("pause blocked by network")), 500),
      ),
    ]);
  } finally {
    release();
  }
  await pending;
  assert.equal(signal?.aborted, true);
  assert.equal(
    (await readRoutingDiagnostics(f.store.dir, "s")).records.at(-1)!.status,
    "cancelled",
  );
  assert.equal((await f.state()).status, "paused");
  assert.equal((await f.state()).capability, "draft");
  assert.equal((await f.state()).history.length, 1);
});

test("a separate controller can change guidance while a decision runs; stale result is discarded", async () => {
  const f = await fixture();
  await f.c.report("s", ready);
  let release!: () => void, started!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  const entered = new Promise<void>((r) => (started = r));
  const slow = new Controller(
    f.store,
    {
      choose: async (s, c, i) => {
        started();
        await wait;
        return chooser().choose(s, c, i);
      },
    },
    { workflow: sample },
  );
  const pending = slow.gate("s", "done");
  await entered;
  const other = new Controller(new StateStore(f.root), chooser(), {
    workflow: sample,
  });
  await other.admit(
    "s",
    "Change the requirement: use PostgreSQL instead",
    "new-user",
  );
  release();
  await pending;
  const state = await other.get("s");
  assert.equal(state?.phase.kind, "working");
  assert.equal(state?.capability, "draft");
  assert.match(state!.guidance.at(-1)!, /PostgreSQL/);
  assert.equal(state?.report, undefined);
  assert.equal(
    (await readRoutingDiagnostics(f.store.dir, "s")).records.at(-1)!.status,
    "stale",
  );
});

test("guidance after failed admission is included when Jev retries", async () => {
  const f = await fixture(sample, {
    choose: async () => {
      throw Error("offline");
    },
  });
  let context: unknown;
  const c = new Controller(
    f.store,
    {
      choose: async (s, k, i) => {
        context = s;
        return chooser().choose(s, k, i);
      },
    },
    { workflow: sample },
  );
  await c.admit("s", "Use PostgreSQL instead", "changed");
  assert.match(JSON.stringify(context), /PostgreSQL/);
});

test("aborting backoff cancels retries without an extra request", async () => {
  const abort = new AbortController();
  let calls = 0;
  const client = new JevClient({
    key: "fake",
    fetch: async () => {
      calls++;
      return new Response("", { status: 503 });
    },
    onNotice: async () => {
      abort.abort();
    },
  });
  await assert.rejects(
    client.choose({}, { x: "x" }, "pick", {
      sessionID: "s",
      signal: abort.signal,
    }),
  );
  assert.equal(calls, 1);
});

test("routing budgets account for JSON escaping in workflow text", async () => {
  const w = structuredClone(sample);
  w.admission.when = "\u0001".repeat(24000);
  w.admission.bypass = "\u0001".repeat(24000);
  w.admission.instructions = "\u0001".repeat(24000);
  w.capabilities.draft!.purpose = "\u0001".repeat(24000);
  const f = await fixture(w);
  let size = 0;
  const client = new JevClient({
    key: "fake",
    fetch: async (_url, args) => {
      size = Buffer.byteLength(args!.body as string);
      return Response.json({
        answers: {
          next: {
            type: "choice",
            choice: "draft",
            confidence: 1,
            probabilities: { draft: 1 },
          },
        },
      });
    },
  });
  const c = new Controller(f.store, client, { workflow: w });
  const s = await c.admit(
    "second",
    "foreman: " + "\u0001".repeat(6000),
    "user-2",
  );
  assert.equal(s?.phase.kind, "working");
  assert.ok(size > 0 && size < 28000);
});

test("missing reports retry the same capability without routing or discarding fresh evidence", async () => {
  const f = await fixture();
  await advance(f.c);
  await f.c.evidence("s", {
    callID: "fresh",
    command: "node --test",
    exit: 0,
    output: "pass",
  });
  const before = await f.state();
  await assert.rejects(f.c.report("s", ready), /no declared output schema/);
  const retry = (await f.c.gate("s", "missing-1"))!;
  assert.equal(retry.capability, "proof");
  assert.equal(retry.reportRetries, 1);
  assert.equal(retry.epoch, before.epoch);
  assert.deepEqual(retry.history, before.history);
  assert.deepEqual(retry.evidence, before.evidence);
  await f.c.received("s", retry.pending!.id);
  await f.c.report("s", {
    summary: "Actual proof completed",
    outcome: "ready",
    covered: ready.data.labels,
  });
  assert.equal((await f.c.gate("s", "corrected"))?.capability, "publish");
});

test("report retries survive restart, stop explicitly, and resume without a planning loop", async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++) {
    const next = (await f.c.gate("s", "missing-" + i))!;
    assert.equal(next.reportRetries, i + 1);
    await f.c.received("s", next.pending!.id);
  }
  const restarted = new Controller(new StateStore(f.root), chooser(), {
    workflow: sample,
  });
  const stopped = (await restarted.gate("s", "exhausted"))!;
  assert.equal(stopped.status, "paused");
  assert.match(
    stopped.pauseReason!,
    /No accepted report after three retries in draft/,
  );
  assert.equal(stopped.history.length, 1);
  await restarted.admit("s", "continue", "user-resumes");
  assert.equal((await restarted.get("s"))!.reportRetries, 0);
  await restarted.report("s", ready);
  assert.equal((await restarted.gate("s", "reported"))?.capability, "proof");
});

test("Foreman state does not read or alter the former project directory", async () => {
  const f = await fixture();
  const legacy = join(f.root, ".jev");
  await mkdir(legacy);
  const oldPath = join(legacy, "foreman-state.json");
  await writeFile(oldPath, "not Foreman state");
  const store = new StateStore(f.root);
  assert.equal(store.path, join(f.root, ".foreman", "foreman-state.json"));
  assert.equal((await store.read()).active, (await f.state()).id);
  await unlink(store.path);
  assert.deepEqual(await store.read(), { schema: 3, workflows: {} });
  assert.equal(await readFile(oldPath, "utf8"), "not Foreman state");
});
