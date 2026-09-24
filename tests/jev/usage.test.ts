import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JevClient } from "../../src/jev/client.js";
import {
  UsageLog,
  summarizeUsage,
  type JevUsage,
} from "../../src/jev/usage.js";
import { StateStore } from "../../src/core/persistence/store.js";
import { Controller } from "../../src/core/runtime/controller.js";
import { execFileSync } from "node:child_process";
import { sample, ready } from "../support/fixtures.js";

const response = (extras: Record<string, unknown> = {}) => ({
  model: "jev-1.13.0",
  usage: { input_tokens: 123, output_tokens: 12 },
  answers: {
    next: {
      type: "choice",
      choice: "IMPLEMENT",
      confidence: 0.2,
      probabilities: { IMPLEMENT: 1 },
    },
  },
  ...extras,
});
async function fixture(fetcher: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), "jev-usage-test-"));
  const log = new UsageLog(root);
  const client = new JevClient({
    sleep: async () => {},
    key: "fake-test-key-not-real",
    fetch: fetcher,
    onUsage: (record) => log.append(record),
  });
  return {
    root,
    log,
    client,
    call: () =>
      client.choose(
        { goal: "private goal" },
        { IMPLEMENT: "implement" },
        "next",
        { sessionID: "ses_usage" },
      ),
  };
}
test("persists actual model and exact tokens for accepted decisions; counts a request once", async () => {
  let requestBody: any;
  const f = await fixture(async (_url, init) => {
    requestBody = JSON.parse(init!.body as string);
    return Response.json(response());
  });
  assert.equal((await f.call()).confidence, 0.2);
  const records = (await new UsageLog(f.root).read()).records;
  assert.equal(records.length, 2);
  assert.equal(records[0]!.status, "pending");
  assert.equal(records[1]!.status, "success");
  assert.equal(records[0]!.requestID, records[1]!.requestID);
  assert.equal(records[1]!.sessionID, "ses_usage");
  const summary = summarizeUsage(records);
  assert.equal(summary.requests, 1);
  assert.equal(summary.inputTokens, 123);
  assert.equal(summary.outputTokens, 12);
  assert.equal(summary.models[0]!.model, "jev-1.13.0");
  assert.equal(summary.unknownInputRequests, 0);
  assert.equal(requestBody.sessionID, undefined);
  const text = await readFile(f.log.path, "utf8");
  assert.ok(!text.includes("private goal"));
  assert.ok(!text.includes("fake-test-key-not-real"));
  assert.equal((await stat(f.log.path)).mode & 0o777, 0o600);
});
test("invalid decisions still retain returned token usage", async () => {
  const f = await fixture(async () => Response.json(response({ answers: {} })));
  await assert.rejects(f.call(), /Invalid Jev/);
  const records = (await f.log.read()).records;
  assert.equal(records[1]!.status, "invalid_response");
  assert.equal(summarizeUsage(records).inputTokens, 6 * 123);
});
test("missing or malformed token usage stays unknown and does not break valid decisions", async () => {
  for (const usage of [
    undefined,
    { input_tokens: -2, output_tokens: 1.5 },
    { input_tokens: "123", output_tokens: null },
  ]) {
    const f = await fixture(async () => Response.json(response({ usage })));
    assert.equal((await f.call()).choice, "IMPLEMENT");
    const summary = summarizeUsage((await f.log.read()).records);
    assert.equal(summary.unknownInputRequests, 1);
    assert.equal(summary.unknownOutputRequests, 1);
  }
});
test("HTTP failures and network interruptions are recorded without response bodies or credentials", async () => {
  for (const [fetcher, status] of [
    [
      async () => new Response("private provider error text", { status: 429 }),
      "http_error",
    ],
    [
      async () => {
        throw new Error("private transport error text");
      },
      "transport_error",
    ],
  ] as const) {
    const f = await fixture(fetcher as typeof fetch);
    await assert.rejects(f.call());
    const records = (await f.log.read()).records;
    assert.equal(records[1]!.status, status);
    assert.equal(records[1]!.inputTokens, null);
    assert.equal(summarizeUsage(records).unknownInputRequests, 6);
    assert.ok(!(await readFile(f.log.path, "utf8")).includes("private"));
  }
});
test("unparseable JSON records an invalid response with unknown usage", async () => {
  const f = await fixture(
    async () => new Response("broken JSON", { status: 200 }),
  );
  await assert.rejects(f.call());
  assert.equal((await f.log.read()).records[1]!.status, "invalid_response");
});
test("concurrent requests preserve separate session and model totals across reload", async () => {
  const f = await fixture(async () => Response.json(response()));
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      f.client.choose({}, { IMPLEMENT: "implement" }, "next", {
        sessionID: i % 2 ? "ses_a" : "ses_b",
      }),
    ),
  );
  const summary = summarizeUsage((await new UsageLog(f.root).read()).records);
  assert.equal(summary.requests, 8);
  assert.equal(summary.inputTokens, 8 * 123);
  assert.equal(summary.sessions.length, 2);
  assert.ok(summary.sessions.every((s) => s.requests === 4));
});
test("interrupted requests and damaged ledger lines are visible", async () => {
  const f = await fixture(async () => Response.json(response()));
  await f.call();
  const records = (await f.log.read()).records;
  const interrupted: JevUsage = { ...records[0]!, requestID: "interrupted" };
  await f.log.append(interrupted);
  await appendFile(f.log.path, "{broken\n");
  const result = await f.log.read();
  const summary = summarizeUsage(result.records);
  assert.equal(result.unreadableLines, 1);
  assert.equal(summary.requests, 2);
  assert.equal(summary.pendingRequests, 1);
  assert.equal(summary.inputTokens, 123);
  assert.equal(summary.unknownInputRequests, 1);
});
test("admission and workflow gates both attribute usage without recursively locking state", async () => {
  const f = await fixture(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    const choice = body.state.gate === "admission" ? "draft" : "proof";
    return Response.json(
      response({
        answers: {
          next: {
            type: "choice",
            choice,
            confidence: 1,
            probabilities: Object.fromEntries(
              Object.keys(body.questions.next.criteria).map((k) => [
                k,
                k === choice ? 1 : 0,
              ]),
            ),
          },
        },
      }),
    );
  });
  const controller = new Controller(new StateStore(f.root), f.client, {
    workflow: sample,
  });
  await controller.admit("ses_attributed", "foreman: Write a handbook.");
  await controller.report("ses_attributed", ready);
  assert.equal(
    (await controller.gate("ses_attributed", "msg_done"))?.capability,
    "proof",
  );
  const summary = summarizeUsage((await f.log.read()).records);
  assert.equal(summary.requests, 2);
  assert.equal(summary.sessions[0]!.sessionID, "ses_attributed");
});
test("a failed initial accounting write prevents an untracked provider request", async () => {
  let called = false;
  const client = new JevClient({
    sleep: async () => {},
    key: "fake-test-key-not-real",
    fetch: async () => {
      called = true;
      return Response.json(response());
    },
    onUsage: async () => {
      throw new Error("Usage storage unavailable");
    },
  });
  await assert.rejects(
    client.choose({}, { IMPLEMENT: "implement" }, "next"),
    /accounting could not be persisted/,
  );
  assert.equal(called, false);
});

test("usage summary command reports recorded tokens and supports session filtering", async () => {
  const f = await fixture(async () => Response.json(response()));
  await f.call();
  const run = (session?: string) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/cli/jev-usage.ts",
          f.root,
          ...(session ? [session] : []),
        ],
        { encoding: "utf8" },
      ),
    );
  const summary = run();
  assert.equal(summary.requests, 1);
  assert.equal(summary.inputTokens, 123);
  assert.equal(summary.complete, true);
  assert.equal(run("ses_usage").outputTokens, 12);
  assert.equal(run("ses_other").requests, 0);
});
