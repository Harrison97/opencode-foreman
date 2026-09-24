import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fixture, sample, chooser, advance } from "../support/fixtures.js";
import { Controller } from "../../src/core/runtime/controller.js";
import {
  readRoutingDiagnostics,
  routingDiagnosticText,
} from "../../src/core/runtime/diagnostics.js";

test("routing diagnostics capture the sent payload, dependency exclusions and history correlation", async () => {
  const w = structuredClone(sample);
  w.capabilities.draft!.next!.ready!.push("publish");
  let sent: unknown;
  let correlation: string | undefined;
  const f = await fixture(w, {
    choose: async (state, criteria, instructions, context) => {
      sent = { state, criteria, instructions };
      correlation = context?.decisionID;
      return chooser("draft", 0.2).choose(state, criteria, instructions);
    },
  });
  const admission = (await readRoutingDiagnostics(f.store.dir, "s"))
    .records[0]!;
  assert.deepEqual(admission.input, sent);
  assert.equal(admission.id, correlation);
  assert.equal(admission.status, "applied");
  assert.equal(admission.answer?.confidence, 0.2);
  assert.equal(admission.answer?.probabilities.draft, 1);
  assert.equal(admission.answer?.providerChoice, "draft");
  assert.match(admission.excluded.BYPASS!, /Explicit/);
  assert.equal((await f.state()).history[0]!.decisionID, admission.id);
  assert.equal(
    JSON.parse(routingDiagnosticText(admission)).selectedProbability,
    1,
  );
  await advance(f.c);
  const records = (await readRoutingDiagnostics(f.store.dir, "s")).records;
  assert.equal(records.length, 2);
  assert.deepEqual(Object.keys(records[1]!.input.criteria), ["proof"]);
  assert.match(records[1]!.excluded.publish!, /Unfinished dependencies: proof/);
  assert.match(records[1]!.excluded.draft!, /Not allowed after ready/);
});

test("failed routing is recorded safely and a resumed decision keeps the failed attempt", async () => {
  const f = await fixture(sample, {
    choose: async () => {
      throw new Error("private provider body");
    },
  });
  let records = (await readRoutingDiagnostics(f.store.dir, "s")).records;
  assert.equal(records[0]!.status, "failed");
  assert.match(records[0]!.error!, /Jev decision failed/);
  assert.doesNotMatch(JSON.stringify(records), /private provider body/);
  const resumed = new Controller(f.store, chooser(), { workflow: sample });
  await resumed.admit("s", "foreman resume");
  records = (await readRoutingDiagnostics(f.store.dir, "s")).records;
  assert.deepEqual(
    records.map((r) => r.status),
    ["failed", "applied"],
  );
  assert.notEqual(records[0]!.id, records[1]!.id);
});

test("bypass decisions survive removal of workflow state and are scoped to their session", async () => {
  const f = await fixture();
  const bypass = new Controller(f.store, chooser("BYPASS"), {
    workflow: sample,
  });
  await bypass.admit("ordinary", "Explain this");
  assert.equal(await bypass.get("ordinary"), undefined);
  const records = (await readRoutingDiagnostics(f.store.dir, "ordinary"))
    .records;
  assert.equal(records.length, 1);
  assert.equal(records[0]!.status, "applied");
  assert.equal(records[0]!.answer?.choice, "BYPASS");
  assert.equal(
    (await readRoutingDiagnostics(f.store.dir, "missing")).records.length,
    0,
  );
});

test("diagnostic reads and CLI are read-only, redact secrets, and report damaged records", async () => {
  const old = process.env.FOREMAN_DIAGNOSTIC_TEST_SECRET;
  process.env.FOREMAN_DIAGNOSTIC_TEST_SECRET = "diagnostic-test-secret-value";
  try {
    const f = await fixture();
    await f.c.admit(
      "secret-session",
      "foreman: Draft with diagnostic-test-secret-value",
    );
    const path = join(f.store.dir, "routing.jsonl");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.doesNotMatch(
      await readFile(path, "utf8"),
      /diagnostic-test-secret-value/,
    );
    await appendFile(path, "broken JSON\n");
    const before = await readFile(f.store.path, "utf8");
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve("scripts/cli/routing-trace.ts"),
          f.root,
          "secret-session",
        ],
        { encoding: "utf8" },
      ),
    );
    assert.equal(output.records.length, 1);
    assert.equal(output.unreadableLines, 1);
    assert.match(output.records[0].input.state.goal, /REDACTED/);
    assert.equal(await readFile(f.store.path, "utf8"), before);
    assert.doesNotMatch(
      f.c.instructions(await f.state()),
      /routing\.jsonl|stateVersion|selectedProbability/,
    );
  } finally {
    if (old === undefined) delete process.env.FOREMAN_DIAGNOSTIC_TEST_SECRET;
    else process.env.FOREMAN_DIAGNOSTIC_TEST_SECRET = old;
  }
});
