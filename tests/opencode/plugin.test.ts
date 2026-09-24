import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { ForemanPlugin } from "../../src/opencode/plugin.js";
import { UsageLog, summarizeUsage } from "../../src/jev/usage.js";
import { fixture, sample, ready } from "../support/fixtures.js";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function setup() {
  const w = structuredClone(sample);
  w.capabilities.proof!.model = "test/reviewer";
  const f = await fixture(w);
  await writeFile(join(f.root, "foreman.workflow.yaml"), YAML.stringify(w));
  const prompts: any[] = [];
  const logs: any[] = [];
  const toasts: any[] = [];
  const plugin = await ForemanPlugin({
    directory: f.root,
    client: {
      app: {
        log: async (x: any) => {
          logs.push(x);
          return {};
        },
      },
      session: {
        status: async () => ({ data: {} }),
        message: async () => ({ response: { status: 404 } }),
        get: async (x: any) => ({
          data: x.path.id === "child" ? { parentID: "s" } : {},
        }),
        messages: async () => ({
          data: [
            {
              info: {
                id: "assistant",
                parentID: "msg_user",
                role: "assistant",
                time: { completed: Date.now() },
              },
              parts: [],
            },
          ],
        }),
        promptAsync: async (x: any) => {
          prompts.push(x);
          return {};
        },
      },
      tui: {
        showToast: async (x: any) => {
          toasts.push(x);
          return {};
        },
      },
    },
  } as any);
  return { ...f, plugin, prompts, logs, toasts };
}
test("OpenCode hooks load custom YAML, inject capabilities, collect native evidence and strip keys", async () => {
  const f = await setup();
  try {
    assert.deepEqual(Object.keys(f.plugin.tool!).sort(), [
      "foreman_report",
      "foreman_status",
    ]);
    const system = { system: [] as string[] };
    await f.plugin["experimental.chat.system.transform"]!(
      { sessionID: "s" } as any,
      system,
    );
    assert.match(system.system[0]!, /CURRENT CAPABILITY: draft/);
    const context = { context: [] as string[] };
    await f.plugin["experimental.session.compacting"]!(
      { sessionID: "s" },
      context,
    );
    assert.equal(context.context.length, 1);
    assert.match(context.context[0]!, /CURRENT CAPABILITY: draft/);
    await f.c.report("s", ready);
    const next = await f.c.gate("s", "draft");
    await f.c.admit("s", "continue", next!.pending!.id, true);
    await f.plugin["tool.execute.after"]!(
      {
        sessionID: "s",
        tool: "bash",
        callID: "wrong",
        args: { command: "node --test", workdir: "/elsewhere" },
      },
      { title: "x", output: "pass", metadata: { exit: 0 } },
    );
    assert.equal((await f.state()).evidence.length, 0);
    await f.plugin["tool.execute.after"]!(
      {
        sessionID: "s",
        tool: "bash",
        callID: "real",
        args: { command: "node --test" },
      },
      { title: "x", output: "pass", metadata: { exit: 0 } },
    );
    assert.equal((await f.state()).evidence[0]!.exit, 0);
    const env = { env: {} as Record<string, string> };
    await f.plugin["shell.env"]!({ cwd: f.root }, env);
    assert.equal(env.env.TYPESAFE_API_KEY, "");
  } finally {
    await f.plugin.dispose!();
  }
});
test("accepted report drives real adapter idle continuation, routed model, usage, and no recursive admission", async () => {
  const f = await setup();
  const fetcher = globalThis.fetch;
  const key = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "fake-adapter-key";
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options!.body as string);
    const keys = Object.keys(body.questions.next.criteria);
    return Response.json({
      model: "mock",
      usage: { input_tokens: 45, output_tokens: 8 },
      answers: {
        next: {
          type: "choice",
          choice: "proof",
          confidence: 1,
          probabilities: Object.fromEntries(
            keys.map((k) => [k, k === "proof" ? 1 : 0]),
          ),
        },
      },
    });
  };
  try {
    await f.plugin.tool!.foreman_report!.execute(
      ready as any,
      { sessionID: "s" } as any,
    );
    await f.plugin.event!({
      event: { type: "session.idle", properties: { sessionID: "s" } },
    } as any);
    for (let n = 0; n < 40 && !f.prompts.length; n++) await delay(25);
    assert.equal(f.prompts.length, 1);
    assert.ok(f.toasts.some((t) => t.body.title === "Jev connected"));
    assert.deepEqual(f.prompts[0].body.model, {
      providerID: "test",
      modelID: "reviewer",
    });
    assert.equal(f.prompts[0].body.parts[0].synthetic, true);
    assert.doesNotMatch(
      f.prompts[0].body.parts[0].text,
      /CURRENT CAPABILITY:|Output JSON schema:|Required gates:/,
    );
    assert.match(f.prompts[0].body.parts[0].text, /Continue the current goal/);
    const system = { system: [] as string[] };
    await f.plugin["experimental.chat.system.transform"]!(
      { sessionID: "s" } as any,
      system,
    );
    assert.match(system.system[0]!, /CURRENT CAPABILITY: proof/);
    assert.match(system.system[0]!, /Omit data/);
    assert.match(system.system[0]!, /node --test/);
    await f.plugin["chat.message"]!({ sessionID: "s" }, {
      message: { id: f.prompts[0].body.messageID },
      parts: f.prompts[0].body.parts,
    } as any);
    await f.plugin.event!({
      event: { type: "session.idle", properties: { sessionID: "s" } },
    } as any);
    await delay(250);
    assert.equal(f.prompts.length, 1);
    assert.equal(Object.keys((await f.store.read()).workflows).length, 1);
    const usage = summarizeUsage((await new UsageLog(f.root).read()).records);
    assert.equal(usage.requests, 1);
    assert.equal(usage.inputTokens, 45);
  } finally {
    globalThis.fetch = fetcher;
    if (key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = key;
    await f.plugin.dispose!();
  }
});
test("Jev authentication failure is visible at admission and does not silently bypass", async () => {
  const f = await setup();
  const fetcher = globalThis.fetch;
  const key = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "fake-adapter-key";
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response("private provider message", { status: 401 });
  };
  try {
    await f.plugin["chat.message"]!(
      { sessionID: "new" } as any,
      {
        message: { id: "first" },
        parts: [{ type: "text", text: "Write a handbook" }],
      } as any,
    );
    assert.equal(requests, 1);
    const state = await f.c.get("new");
    assert.equal(state?.status, "paused");
    assert.equal(state?.pendingDecision, "admission");
    assert.ok(
      f.toasts.some(
        (t) =>
          t.body.title === "Foreman paused" &&
          t.body.message.includes("authentication rejected"),
      ),
    );
    assert.ok(!JSON.stringify(f.toasts).includes("private provider message"));
  } finally {
    globalThis.fetch = fetcher;
    if (key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = key;
    await f.plugin.dispose!();
  }
});
test("errors pause, synthetic prompts cannot resume, and native child sessions bypass admission", async () => {
  const f = await setup();
  try {
    await f.plugin.event!({
      event: { type: "session.error", properties: { sessionID: "s" } },
    } as any);
    assert.equal((await f.state()).status, "paused");
    await f.plugin.event!({
      event: { type: "session.idle", properties: { sessionID: "s" } },
    } as any);
    await delay(200);
    assert.equal(f.prompts.length, 0);
    await f.plugin["chat.message"]!({ sessionID: "child" }, {
      message: { id: "childmsg" },
      parts: [{ type: "text", text: "foreman: Draft" }],
    } as any);
    assert.equal(await f.c.get("child"), undefined);
  } finally {
    await f.plugin.dispose!();
  }
});
test("initial user turn selects capability model and errors do not silently change models", async () => {
  const f = await setup();
  const fetcher = globalThis.fetch;
  const key = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "fake-adapter-key";
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options!.body as string);
    const keys = Object.keys(body.questions.next.criteria);
    return Response.json({
      answers: {
        next: {
          type: "choice",
          choice: "draft",
          confidence: 1,
          probabilities: Object.fromEntries(
            keys.map((k) => [k, k === "draft" ? 1 : 0]),
          ),
        },
      },
    });
  };
  try {
    const output: any = {
      message: {
        id: "initial",
        model: { providerID: "test", modelID: "base" },
      },
      parts: [{ type: "text", text: "foreman: Write copy" }],
    };
    await f.plugin["chat.message"]!(
      { sessionID: "new", model: output.message.model },
      output,
    );
    assert.equal((await f.c.get("new"))?.capability, "draft");
    assert.deepEqual(output.message.model, {
      providerID: "test",
      modelID: "base",
    });
  } finally {
    globalThis.fetch = fetcher;
    if (key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = key;
    await f.plugin.dispose!();
  }
});
test("disabled plugin neither loads config nor records requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "foreman-disabled-"));
  const old = process.env.FOREMAN_DISABLED;
  process.env.FOREMAN_DISABLED = "1";
  try {
    assert.deepEqual(await ForemanPlugin({ directory: root } as any), {});
    await assert.rejects(stat(new UsageLog(root).path), { code: "ENOENT" });
  } finally {
    if (old === undefined) delete process.env.FOREMAN_DISABLED;
    else process.env.FOREMAN_DISABLED = old;
  }
});

test("status stays focused and rejected reports explain the active contract", async () => {
  const f = await setup();
  try {
    await f.c.report("s", ready);
    const next = (await f.c.gate("s", "draft"))!;
    await f.c.received("s", next.pending!.id);
    await f.store.transaction((db) => {
      db.workflows[db.active!]!.evidence = Array.from(
        { length: 100 },
        (_, i) => ({
          callID: String(i),
          command: "node --test",
          exit: 0,
          output: "x".repeat(1000),
          at: new Date().toISOString(),
          revision: 0,
          epoch: 0,
        }),
      );
    });
    const status = await f.plugin.tool!.foreman_status!.execute({}, {
      sessionID: "s",
    } as any);
    assert.ok(typeof status === "string");
    assert.match(status, /CURRENT CAPABILITY: proof/);
    assert.match(status, /Correct tone/);
    assert.ok(status.length < 10000);
    const result = await f.plugin.tool!.foreman_status!.execute(
      { producer: "draft" },
      { sessionID: "s" } as any,
    );
    assert.ok(typeof result === "string");
    const output = JSON.parse(result);
    assert.deepEqual(output.output, ready.data);
    await assert.rejects(
      f.plugin.tool!.foreman_report!.execute(ready, { sessionID: "s" } as any),
      (error: Error) => {
        assert.match(error.message, /report was not accepted/i);
        assert.match(error.message, /capability proof/i);
        assert.match(error.message, /omit data/i);
        assert.doesNotMatch(
          error.message,
          /CURRENT CAPABILITY:|Output JSON schema:|Required gates:/,
        );
        return true;
      },
    );
    assert.equal((await f.state()).phase.kind, "working");
  } finally {
    await f.plugin.dispose!();
  }
});
