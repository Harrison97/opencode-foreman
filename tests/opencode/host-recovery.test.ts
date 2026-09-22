import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { JevSupervisor } from "../../src/opencode/plugin.js";
import { fixture, sample, ready, advance } from "../support/fixtures.js";

async function until(predicate: () => Promise<boolean>) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Host recovery timed out");
}
async function setup() {
  const f = await fixture();
  await advance(f.c);
  await f.c.evidence("s", {
    callID: "check",
    command: "node --test",
    exit: 0,
    output: "pass",
  });
  await f.c.report("s", {
    summary: "verified",
    outcome: "ready",
    covered: ready.data.labels,
  });
  const pending = await f.c.gate("s", "verified");
  await writeFile(join(f.root, "jev.workflow.yaml"), YAML.stringify(sample));
  const messages: any[] = [],
    toasts: any[] = [],
    sent: any[] = [];
  let fail = false,
    busy = false,
    plugin: Awaited<ReturnType<typeof JevSupervisor>>;
  async function boot() {
    plugin = await JevSupervisor({
      directory: f.root,
      client: {
        app: { log: async () => ({}) },
        tui: {
          showToast: async (x: any) => {
            toasts.push(x);
            return {};
          },
        },
        session: {
          status: async () => ({ data: busy ? { s: { type: "busy" } } : {} }),
          get: async () => ({ data: {} }),
          message: async ({ path }: any) => {
            const data = messages.find((m) => m.info.id === path.messageID);
            return data ? { data } : { response: { status: 404 } };
          },
          messages: async () => ({ data: messages }),
          promptAsync: async ({ body }: any) => {
            sent.push(body);
            if (fail) return { error: "failed" };
            messages.push({
              info: { id: body.messageID, role: "user" },
              parts: body.parts,
            });
            await plugin["chat.message"]!(
              { sessionID: "s" } as any,
              { message: { id: body.messageID }, parts: body.parts } as any,
            );
            busy = true;
            return {};
          },
        },
      },
    } as any);
    return plugin;
  }
  return {
    ...f,
    pending: pending!,
    messages,
    toasts,
    sent,
    boot,
    setFail: (value: boolean) => {
      fail = value;
    },
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}

test("restart replays a missing persisted delivery; completion waits for its matching response", async () => {
  const f = await setup();
  const p = await f.boot();
  try {
    await until(async () => f.sent.length === 1);
    assert.equal((await f.state()).status, "delivering");
    f.messages.push({
      info: {
        id: "unrelated",
        parentID: "wrong",
        role: "assistant",
        time: { completed: 1 },
      },
    });
    await p.event!({
      event: { type: "session.idle", properties: { sessionID: "s" } },
    } as any);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await f.state()).status, "delivering");
    f.messages.push({
      info: {
        id: "final",
        parentID: f.pending.pending!.id,
        role: "assistant",
        time: { completed: 1 },
      },
    });
    f.setBusy(false);
    await p.event!({
      event: { type: "session.idle", properties: { sessionID: "s" } },
    } as any);
    await until(async () => (await f.state()).status === "complete");
    assert.equal(f.sent.length, 1);
  } finally {
    await p.dispose!();
  }
});

test("restart reconciles a received delivery without sending it twice", async () => {
  const f = await setup();
  const id = f.pending.pending!.id;
  f.messages.push(
    { info: { id, role: "user" } },
    {
      info: {
        id: "final",
        parentID: id,
        role: "assistant",
        time: { completed: 1 },
      },
    },
  );
  const p = await f.boot();
  try {
    await until(async () => (await f.state()).status === "complete");
    assert.equal(f.sent.length, 0);
  } finally {
    await p.dispose!();
  }
});

test("failed final dispatch is paused visibly and retains delivery for a user resume", async () => {
  const f = await setup();
  f.setFail(true);
  const p = await f.boot();
  try {
    await until(async () => (await f.state()).status === "paused");
    const s = await f.state();
    assert.equal(s.phase.kind, "paused");
    assert.equal(s.pending?.id, f.pending.pending!.id);
    assert.ok(f.toasts.some((t) => t.body.title === "Foreman paused"));
    f.setFail(false);
    await p["chat.message"]!(
      { sessionID: "s" } as any,
      {
        message: { id: "resume-user" },
        parts: [{ type: "text", text: "foreman resume" }],
      } as any,
    );
    assert.equal((await f.state()).status, "delivering");
    f.messages.push({
      info: {
        id: "delivered",
        parentID: "resume-user",
        role: "assistant",
        time: { completed: 1 },
      },
    });
    await p.event!({
      event: { type: "session.idle", properties: { sessionID: "s" } },
    } as any);
    await until(async () => (await f.state()).status === "complete");
  } finally {
    await p.dispose!();
  }
});

test("delivery claims serialize hosts and host errors cannot mark completion", async () => {
  const f = await setup();
  const claim = await f.c.claimDelivery("s");
  assert.ok(claim);
  const { Controller } = await import("../../src/core/runtime/controller.js");
  const { StateStore } = await import("../../src/core/persistence/store.js");
  const { chooser } = await import("../support/fixtures.js");
  const other = new Controller(new StateStore(f.root), chooser(), {
    workflow: sample,
  });
  assert.equal(await other.claimDelivery("s"), undefined);
  await f.c.received("s", f.pending.pending!.id);
  await f.c.finished(
    "s",
    "failed",
    f.pending.pending!.id,
    "Host response failed",
  );
  assert.equal((await f.state()).status, "paused");
  await f.c.admit("s", "foreman resume", "retry-final");
  await f.c.finished("s", "stale-result", f.pending.pending!.id);
  assert.equal((await f.state()).status, "delivering");
  await f.c.finished("s", "retried-result", "retry-final");
  assert.equal((await f.state()).status, "complete");
});

test("restart pauses an acknowledged final delivery with no completed host response", async () => {
  const f = await setup();
  await f.c.received("s", f.pending.pending!.id);
  f.messages.push({ info: { id: f.pending.pending!.id, role: "user" } });
  const p = await f.boot();
  try {
    await until(async () => (await f.state()).status === "paused");
    assert.match((await f.state()).pauseReason!, /no completed response/);
    assert.equal(f.sent.length, 0);
    assert.ok(f.toasts.length);
  } finally {
    await p.dispose!();
  }
});
