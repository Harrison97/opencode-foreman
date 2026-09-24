import { test } from "node:test";
import assert from "node:assert/strict";
import { JevClient, parseDecision } from "../../src/jev/client.js";
import { Controller } from "../../src/core/runtime/controller.js";
import { StateStore } from "../../src/core/persistence/store.js";
import {
  fixture,
  sample,
  ready,
  chooser,
  advance,
  deliver,
} from "../support/fixtures.js";
import type { JevUsage } from "../../src/jev/usage.js";
import { summarizeUsage } from "../../src/jev/usage.js";

const payload = () => ({
  usage: { input_tokens: 10, output_tokens: 2 },
  answers: {
    next: {
      type: "choice",
      choice: "a",
      confidence: 0.1,
      probabilities: { a: 0.4, b: 0.6 },
    },
  },
});
test("highest probability wins below 0.75; ties retain the service choice", async () => {
  assert.equal(parseDecision(payload(), ["a", "b"]).choice, "b");
  assert.equal(parseDecision(payload(), ["a", "b"]).providerChoice, "a");
  assert.equal(parseDecision(payload(), ["a", "b"]).confidence, 0.1);
  const tie = payload();
  tie.answers.next.probabilities = { a: 0.5, b: 0.5 };
  assert.equal(parseDecision(tie, ["a", "b"]).choice, "a");
  const w = structuredClone(sample);
  w.capabilities.proof!.dependsOn = [];
  // Both admission candidates produce a usable contract before review.
  w.capabilities.alternative = structuredClone(w.capabilities.draft!);
  w.admission.entries.push("alternative");
  w.capabilities.alternative.next!.ready = ["draft"];
  const f = await fixture(w, {
    choose: async () => ({
      choice: "draft",
      confidence: 0.1,
      probabilities: { draft: 0.4, alternative: 0.6 },
    }),
  });
  assert.equal((await f.state()).capability, "alternative");
  assert.equal((await f.state()).history[0]!.confidence, 0.1);
});

test("five retries after the initial attempt; each attempt is accounted, notices are safe", async () => {
  const usage: JevUsage[] = [],
    waits: number[] = [],
    notices: string[] = [];
  let calls = 0;
  const c = new JevClient({
    key: "fake-secret",
    fetch: async () => {
      calls++;
      return new Response("private-body", { status: 503 });
    },
    sleep: async (ms) => {
      waits.push(ms);
    },
    onUsage: async (r) => {
      usage.push(r);
    },
    onNotice: async (n) => {
      notices.push(n.message);
    },
  });
  await assert.rejects(
    c.choose({}, { a: "A", b: "B" }, "pick"),
    /Paused after 6 attempt/,
  );
  assert.equal(calls, 6);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000]);
  assert.equal(summarizeUsage(usage).requests, 6);
  assert.equal(new Set(usage.map((r) => r.decisionID)).size, 1);
  assert.deepEqual(
    usage.filter((r) => r.finishedAt).map((r) => r.attempt),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(notices.length, 5);
  assert.ok(!JSON.stringify({ usage, notices }).includes("private-body"));
});

test("transient errors and invalid responses recover; Retry-After is respected", async () => {
  for (const failure of ["network", "invalid", "429", "408", "500"]) {
    let calls = 0;
    const waits: number[] = [];
    const c = new JevClient({
      key: "fake",
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetch: async () => {
        if (++calls > 1) return Response.json(payload());
        if (failure === "network") throw new Error("private transport details");
        if (failure === "invalid") return Response.json({ answers: {} });
        return new Response("", {
          status: Number(failure),
          headers: { "Retry-After": "3" },
        });
      },
    });
    assert.equal((await c.choose({}, { a: "A", b: "B" }, "pick")).choice, "b");
    assert.equal(calls, 2);
    assert.deepEqual(waits, [
      ["network", "invalid"].includes(failure) ? 1000 : 3000,
    ]);
  }
});

test("authentication, other permanent errors and long server retry delays pause without retrying", async () => {
  for (const status of [400, 401, 403, 413, 429]) {
    let calls = 0,
      waits = 0;
    const c = new JevClient({
      key: "fake",
      sleep: async () => {
        waits++;
      },
      fetch: async () => {
        calls++;
        return new Response("", { status, headers: { "Retry-After": "120" } });
      },
    });
    await assert.rejects(
      c.choose({}, { a: "A" }, "pick"),
      status === 429 ? /longer than 30 seconds/ : /Paused after 1 attempt/,
    );
    assert.equal(calls, 1);
    assert.equal(waits, 0);
  }
  const c = new JevClient({
    key: "",
    fetch: async () => {
      throw new Error("should never send");
    },
  });
  await assert.rejects(
    c.choose({}, { a: "A" }, "pick"),
    /credential unavailable/,
  );
});

test("failed admission persists a pause and retries admission after reload, without implicit bypass", async () => {
  const f = await fixture(sample, {
    choose: async () => {
      throw new Error("network");
    },
  });
  assert.equal((await f.state()).status, "paused");
  assert.equal((await f.state()).history.length, 0);
  await assert.rejects(f.c.beforeTool("s", "bash", "anything"), /paused/);
  const c = new Controller(new StateStore(f.root), chooser(), {
    workflow: sample,
  });
  const resumed = await c.admit("s", "foreman resume");
  assert.equal(resumed?.capability, "draft");
  assert.equal(resumed?.pendingDecision, undefined);
  assert.equal(resumed?.history.length, 1);
  const plain = await f.c.admit("plain", "Explain this");
  assert.equal(plain?.status, "paused");
  const bypass = new Controller(new StateStore(f.root), chooser("BYPASS"), {
    workflow: sample,
  });
  assert.equal(await bypass.admit("plain", "foreman resume"), undefined);
  assert.equal(await bypass.get("plain"), undefined);
});

test("failed routing preserves report/evidence and resumes selection without rerunning work", async () => {
  const w = structuredClone(sample);
  w.capabilities.proof!.next!.ready = ["publish", "draft"];
  const f = await fixture(w);
  await advance(f.c);
  await f.c.evidence("s", {
    callID: "check",
    command: "node --test",
    exit: 0,
    output: "pass",
  });
  await f.c.report("s", {
    summary: "Verified",
    outcome: "ready",
    covered: ready.data.labels,
  });
  const failing = new Controller(
    f.store,
    {
      choose: async () => {
        throw new Error("network");
      },
    },
    { workflow: w },
  );
  const paused = await failing.gate("s", "review-done");
  assert.equal(paused?.pendingDecision, "transition");
  assert.equal(paused?.report?.outcome, "ready");
  const c = new Controller(new StateStore(f.root), chooser("publish"), {
    workflow: w,
  });
  const resumed = await c.admit("s", "foreman resume");
  assert.equal(resumed?.status, "delivering");
  assert.equal((await deliver(c)).status, "complete");
  assert.equal(resumed?.evidence.length, 1);
  assert.equal(resumed?.pending?.delivered, true);
  assert.equal(resumed?.pendingDecision, undefined);
});

test("legacy Jev environment key is not used for authentication", async () => {
  const current = process.env.TYPESAFE_API_KEY;
  const legacy = process.env.JEV_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  process.env.JEV_API_KEY = "unsupported-test-key";
  try {
    const client = new JevClient({
      fetch: async () => {
        throw new Error("must not send without TYPESAFE_API_KEY");
      },
    });
    await assert.rejects(
      client.choose({}, { a: "A" }, "pick"),
      /Set TYPESAFE_API_KEY/,
    );
  } finally {
    if (current === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = current;
    if (legacy === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = legacy;
  }
});

test("SDK transport keeps the endpoint, model, redirect protection and in-flight cancellation", async () => {
  const abort = new AbortController();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const records: JevUsage[] = [];
  let calls = 0;
  const client = new JevClient({
    key: "fake-key",
    model: "test-model",
    onUsage: async (record) => {
      records.push(record);
    },
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(init!.redirect, "error");
      assert.equal(
        new Headers(init!.headers).get("authorization"),
        "Bearer fake-key",
      );
      assert.equal(JSON.parse(init!.body as string).model, "test-model");
      started();
      return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => reject(new Error("private abort details")),
          { once: true },
        );
      });
    },
  });
  const call = client.choose({}, { a: "A" }, "pick", {
    sessionID: "s",
    signal: abort.signal,
    decisionID: "routing-id",
  });
  await entered;
  abort.abort();
  await assert.rejects(call);
  assert.equal(calls, 1);
  assert.equal(records.at(-1)!.status, "transport_error");
  assert.equal(records.at(-1)!.decisionID, "routing-id");
  assert.ok(records.at(-1)!.finishedAt);
  assert.doesNotMatch(
    JSON.stringify(records),
    /fake-key|private abort details/,
  );
});
