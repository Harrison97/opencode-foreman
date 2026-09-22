import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { parse } from "jsonc-parser";
import { fixture, advance } from "../support/fixtures.js";
import {
  projectTrace,
  readTrace,
  recentSteps,
} from "../../src/opencode/trace.js";

test("trace follows the exact session, retains repair visits, and reads without changing state", async () => {
  const f = await fixture();
  await advance(f.c);
  await f.c.report("s", { outcome: "incomplete", summary: "Repair needed" });
  await f.c.gate("s", "repair");
  const before = await readFile(f.store.path, "utf8");
  const trace = (await readTrace(f.root, "s"))!;
  assert.equal(trace.capability, "draft");
  assert.deepEqual(
    recentSteps(trace).map((s) => s.text),
    ["draft", "draft → proof", "proof → draft"],
  );
  assert.deepEqual(recentSteps(trace, 1), [
    { number: 3, text: "proof → draft" },
  ]);
  assert.equal(await readTrace(f.root, "unrelated-session"), undefined);
  assert.equal(await readFile(f.store.path, "utf8"), before);
  await f.c.pause("s", "Human decision needed");
  assert.equal((await readTrace(f.root, "s"))!.status, "paused");
  assert.equal(
    (await readTrace(f.root, "s"))!.pauseReason,
    "Human decision needed",
  );
});

test("trace represents completion and filters terminal controls, bypass, and missing state", async () => {
  const f = await fixture();
  const db = await f.store.read();
  const state = db.workflows[db.active!]!;
  state.phase = { kind: "complete", messageID: "final" };
  state.workflow.name = "Name\u001b[31m\nInjected";
  const trace = projectTrace(db, "s")!;
  assert.equal(trace.status, "complete");
  assert.ok(!trace.name.includes("\u001b"));
  assert.ok(!trace.name.includes("\n"));
  state.phase = { kind: "bypassed" };
  assert.equal(projectTrace(db, "s"), undefined);
  const empty = await mkdtemp(join(tmpdir(), "foreman-trace-"));
  assert.equal(await readTrace(empty, "s"), undefined);
  await mkdir(join(empty, ".foreman"));
  await writeFile(join(empty, ".foreman/foreman-state.json"), "broken");
  await assert.rejects(readTrace(empty, "s"));
});

test("installer preserves TUI comments, other plugins and disabled state; repeated install is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "foreman-install-"));
  const configDir = join(root, "opencode");
  await mkdir(configDir);
  const file = join(configDir, "tui.jsonc");
  await writeFile(
    file,
    '{\n// keep this comment\n"theme":"custom", "plugin":["other"], "plugin_enabled":{"foreman.trace":false},\n}\n',
  );
  const run = () =>
    execFileSync(process.execPath, [resolve("scripts/install.mjs")], {
      env: { ...process.env, XDG_CONFIG_HOME: root },
      stdio: "pipe",
    });
  run();
  const first = await readFile(file, "utf8");
  run();
  assert.equal(await readFile(file, "utf8"), first);
  assert.ok(first.includes("// keep this comment"));
  const config = parse(first);
  assert.equal(config.theme, "custom");
  assert.equal(config.plugin[0], "other");
  assert.equal(config.plugin.length, 2);
  assert.equal(config.plugin_enabled["foreman.trace"], false);
});
