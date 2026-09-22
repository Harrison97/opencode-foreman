import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Controller } from "../../src/core/runtime/controller.js";
import { StateStore } from "../../src/core/persistence/store.js";
import { JevClient } from "../../src/jev/client.js";
import {
  fixture,
  sample,
  ready,
  advance,
  chooser,
} from "../support/fixtures.js";

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
