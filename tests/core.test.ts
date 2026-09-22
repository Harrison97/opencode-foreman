import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Controller, eligible } from "../src/core/controller.js";
import { StateStore } from "../src/core/state.js";
import { parseDecision, JevClient } from "../src/jev/client.js";
import {
  fixture,
  ready,
  advance,
  sample,
  chooser,
  deliver,
} from "./fixtures.js";

test("custom names, dependencies, legal transitions, and terminal evidence", async () => {
  const f = await fixture();
  assert.deepEqual(eligible(await f.state(), ["proof", "publish"]), []);
  assert.equal((await advance(f.c)).capability, "proof");
  await assert.rejects(
    f.c.report("s", {
      summary: "done",
      outcome: "ready",
      covered: ["Correct tone"],
    }),
    /native evidence/,
  );
  await f.c.evidence("s", {
    callID: "a",
    command: "node --test",
    exit: 0,
    output: "passed",
  });
  await f.c.report("s", {
    summary: "proofread",
    outcome: "ready",
    covered: ["Correct tone"],
  });
  const end = await f.c.gate("s", "msg_proof");
  assert.equal(end?.status, "delivering");
  assert.equal((await deliver(f.c)).status, "complete");
  assert.equal(end?.capability, "publish");
  assert.equal(end?.history.at(-1)?.source, "guard");
});
test("rejected output and coverage reports are atomic and corrected without rerunning checks", async () => {
  const f = await fixture();
  const before = await f.state();
  await assert.rejects(
    f.c.report("s", {
      summary: "done",
      outcome: "ready",
      data: { labels: [] },
    }),
    /output/,
  );
  assert.deepEqual(await f.state(), before);
  await advance(f.c);
  await f.c.evidence("s", {
    callID: "a",
    command: "node --test",
    exit: 0,
    output: "ok",
  });
  await assert.rejects(
    f.c.report("s", {
      summary: "done",
      outcome: "ready",
      covered: ["paraphrased"],
    }),
    /do not need to be rerun/,
  );
  await assert.rejects(
    f.c.report("s", {
      summary: "done",
      outcome: "ready",
      data: { checks: ["true"] },
    }),
    /no declared output schema/,
  );
  await f.c.report("s", {
    summary: "done",
    outcome: "ready",
    covered: ["Correct tone"],
  });
  assert.equal((await f.c.gate("s", "done"))?.status, "delivering");
  assert.equal((await deliver(f.c)).status, "complete");
});
test("failed verification routes backward and requires fresh evidence after repair", async () => {
  const f = await fixture();
  await advance(f.c);
  await f.c.evidence("s", {
    callID: "a",
    command: "node --test",
    exit: 0,
    output: "pass",
  });
  await f.c.evidence("s", {
    callID: "b",
    command: "node --test",
    exit: 1,
    output: "fail",
  });
  await assert.rejects(
    f.c.report("s", {
      summary: "done",
      outcome: "ready",
      covered: ["Correct tone"],
    }),
    /native evidence/,
  );
  await f.c.report("s", { summary: "typo found", outcome: "incomplete" });
  const back = await f.c.gate("s", "failed");
  assert.equal(back?.capability, "draft");
  assert.deepEqual(back?.completed, {});
  await f.c.admit("s", back!.pending!.text, back!.pending!.id, true);
  await advance(f.c, "s", "repair");
  await assert.rejects(
    f.c.report("s", {
      summary: "done",
      outcome: "ready",
      covered: ["Correct tone"],
    }),
    /native evidence/,
  );
  await f.c.evidence("s", {
    callID: "c",
    command: "node --test",
    exit: 0,
    output: "fixed",
  });
  await f.c.report("s", {
    summary: "done",
    outcome: "ready",
    covered: ["Correct tone"],
  });
  assert.equal((await f.c.gate("s", "verified"))?.status, "delivering");
  assert.equal((await deliver(f.c)).status, "complete");
});
test("tool filters and exact command evidence; duplicate calls and null exits", async () => {
  const f = await fixture();
  await advance(f.c);
  await assert.rejects(f.c.beforeTool("s", "edit"), /unavailable/);
  await assert.rejects(f.c.beforeTool("s", "bash", "true"), /exact declared/);
  await f.c.beforeTool("s", "bash", "node --test");
  await f.c.evidence("s", {
    callID: "unrelated",
    command: "true",
    exit: 0,
    output: "",
  });
  await f.c.evidence("s", {
    callID: "x",
    command: "node --test",
    exit: null,
    output: "timeout",
  });
  await f.c.evidence("s", {
    callID: "x",
    command: "node --test",
    exit: 0,
    output: "fake second",
  });
  assert.equal((await f.state()).evidence.length, 1);
  await assert.rejects(
    f.c.report("s", {
      summary: "done",
      outcome: "ready",
      covered: ["Correct tone"],
    }),
    /native evidence/,
  );
});
test("human pause/resume and reload keep the pinned workflow; synthetic messages do not resume", async () => {
  const f = await fixture();
  await f.c.report("s", {
    summary: "Need audience",
    outcome: "blocked",
    questions: ["Who is the audience?"],
  });
  assert.equal((await f.c.gate("s", "question"))?.status, "paused");
  assert.equal(await f.c.gate("s", "idle"), undefined);
  await f.c.admit("s", "Internal", "synthetic", true);
  assert.equal((await f.state()).status, "paused");
  const edited = structuredClone(sample);
  edited.capabilities.draft!.instructions = "NEW RULE";
  const originalID = (await f.state()).id;
  const reload = new Controller(new StateStore(f.root), chooser(), {
    workflow: edited,
  });
  const resumed = await reload.admit(
    "new",
    "foreman resume: Internal engineers",
  );
  assert.equal(resumed?.id, originalID);
  assert.equal(resumed?.status, "running");
  assert.equal(
    resumed?.workflow.capabilities.draft!.instructions,
    sample.capabilities.draft!.instructions,
  );
});
test("internal prompts and repeated idle events cannot recursively admit", async () => {
  const f = await fixture();
  const next = await advance(f.c);
  assert.equal(await f.c.gate("s", "msg_draft"), undefined);
  assert.equal((await f.state()).phase.kind, "working");
  assert.equal(Object.keys((await f.store.read()).workflows).length, 1);
  assert.equal(next.capability, "proof");
});
test("highest-ranked choices are accepted without a confidence cutoff; decision failures pause", async () => {
  const f = await fixture();
  assert.equal((await advance(f.c)).capability, "proof");
  const bad = await fixture(sample, {
    choose: async () => {
      throw new Error("private network details");
    },
  });
  assert.equal((await bad.state()).status, "paused");
  assert.equal((await bad.state()).pendingDecision, "admission");
  assert.ok(!(await bad.state()).pauseReason!.includes("private"));
});
test("explicit opt-in, normal bypass, stop and resume use generic runtime statuses", async () => {
  const f = await fixture(sample, chooser("BYPASS"));
  assert.ok(await f.c.get("s")); // explicit opt-in cannot choose BYPASS
  assert.equal(await f.c.admit("other", "What does this mean?"), undefined);
  assert.equal((await f.c.admit("s", "Stop working."))?.status, "paused");
  assert.equal((await f.c.admit("s", "Continue."))?.status, "running");
  assert.equal(await f.c.admit("s", "foreman bypass: Explain"), undefined);
  assert.equal((await f.c.admit("s", "foreman resume"))?.status, "running");
});
test("finite work limits and repeated work pause without special workflow nodes", async () => {
  const f = await fixture();
  const c = new Controller(f.store, chooser(), {
    workflow: sample,
    maxTurns: 1,
  });
  await c.report("s", ready);
  assert.equal((await c.gate("s", "budget"))?.status, "paused");
  assert.equal((await c.admit("s", "Continue"))?.turns, 0);
  for (let i = 0; i < 3; i++) {
    await f.c.report("s", { summary: "still working", outcome: "incomplete" });
    const s = await f.c.gate("s", "loop" + i);
    if (s?.pending) await f.c.admit("s", s.pending.text, s.pending.id, true);
  }
  assert.equal((await f.state()).status, "paused");
});
test("durable state, locking, old state preservation and secret redaction", async () => {
  const f = await fixture();
  const other = new StateStore(f.root);
  const oldPath = join(f.root, ".jev/state.json");
  await writeFile(oldPath, '{"schema":1,"historical":"untouched"}');
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? f.store : other).transaction((db) => {
        db.workflows[db.active!]!.revision++;
      }),
    ),
  );
  assert.equal((await f.state()).revision, 12);
  assert.equal(
    await readFile(oldPath, "utf8"),
    '{"schema":1,"historical":"untouched"}',
  );
  assert.equal((await stat(f.store.path)).mode & 0o777, 0o600);
  process.env.FOREMAN_TEST_SECRET = "test-secret-value-123456";
  try {
    await f.c.report("s", {
      summary: process.env.FOREMAN_TEST_SECRET,
      outcome: "incomplete",
    });
    assert.ok(
      !(await readFile(f.store.path, "utf8")).includes(
        process.env.FOREMAN_TEST_SECRET,
      ),
    );
  } finally {
    delete process.env.FOREMAN_TEST_SECRET;
  }
  await writeFile(f.store.path, "broken");
  await assert.rejects(f.store.transaction(() => {}));
  assert.equal(await readFile(f.store.path, "utf8"), "broken");
});
test("missing reports and unsatisfied next dependencies cannot falsely complete", async () => {
  const w = structuredClone(sample);
  w.capabilities.draft!.next!.incomplete = ["publish"];
  const f = await fixture(w);
  const paused = await f.c.gate("s", "no-report");
  assert.equal(paused?.status, "paused");
  assert.equal(paused?.completed.draft, undefined);
});
test("a completed workflow detaches before normal conversation or a fresh request", async () => {
  const f = await fixture();
  await advance(f.c);
  await f.c.evidence("s", {
    callID: "pass",
    command: "node --test",
    exit: 0,
    output: "pass",
  });
  await f.c.report("s", {
    summary: "checked",
    outcome: "ready",
    covered: ["Correct tone"],
  });
  await f.c.gate("s", "finished");
  await deliver(f.c);
  const bypass = new Controller(f.store, chooser("BYPASS"), {
    workflow: sample,
  });
  assert.equal(await bypass.admit("s", "What does this mean?"), undefined);
  assert.equal(await bypass.get("s"), undefined);
  assert.equal(
    (await f.c.admit("s", "foreman: Write another draft"))?.capability,
    "draft",
  );
  assert.equal(Object.keys((await f.store.read()).workflows).length, 2);
});
test("Jev parser validates confidence, probabilities and legal choices", () => {
  const answer = {
    type: "choice",
    choice: "draft",
    confidence: 0.2,
    probabilities: { draft: 0.99, proof: 0.01 },
  };
  assert.equal(
    parseDecision({ answers: { next: answer } }, ["draft", "proof"]).confidence,
    0.99,
  );
  for (const invalid of [
    { ...answer, choice: "other" },
    { ...answer, confidence: NaN },
    { ...answer, probabilities: { draft: 0.3 } },
  ])
    assert.throws(() =>
      parseDecision({ answers: { next: invalid } }, ["draft", "proof"]),
    );
});
test("Jev HTTP contract and errors do not disclose credentials", async () => {
  let body: any;
  const client = new JevClient({
    sleep: async () => {},
    key: "fake-private-key",
    fetch: async (_url, options) => {
      body = JSON.parse(options!.body as string);
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
  assert.equal(
    (await client.choose({}, { draft: "Write" }, "choose")).choice,
    "draft",
  );
  assert.equal(body.questions.next.type, "choice");
  await assert.rejects(
    new JevClient({
      sleep: async () => {},
      key: "fake-private-key",
      fetch: async () => new Response("secret", { status: 401 }),
    }).choose({}, { draft: "Write" }, "choose"),
    /authentication rejected.*HTTP 401/,
  );
});
