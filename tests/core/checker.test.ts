import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import YAML from "yaml";
import { sample } from "../support/fixtures.js";
import { checkWorkflow, checkHost } from "../../src/core/workflow/checker.js";
import { parseWorkflow } from "../../src/core/workflow/schema.js";

test("missing, mistyped, optional and self-produced gate contracts fail at load time", () => {
  const cases: [(w: any) => void, RegExp][] = [
    [
      (w) => (w.capabilities.proof.gate.commands = "draft.typo"),
      /proof.gate.commands.*No declared output draft.typo/,
    ],
    [
      (w) =>
        (w.capabilities.draft.outputs.properties.checks = { type: "number" }),
      /must be an array of strings/,
    ],
    [
      (w) =>
        (w.capabilities.draft.outputs.properties.checks.items = {
          type: "number",
        }),
      /must be an array of strings/,
    ],
    [
      (w) => (w.capabilities.draft.outputs.required = ["labels"]),
      /not guaranteed on every entry path/,
    ],
    [
      (w) => {
        w.capabilities.proof.dependsOn = [];
        w.admission.entries.push("proof");
      },
      /not guaranteed on every entry path/,
    ],
    [
      (w) => (w.capabilities.draft.append = ["missing"]),
      /Declare missing as an array/,
    ],
    [
      (w) => {
        delete w.capabilities.proof.gate;
      },
      /Set gate.commands/,
    ],
    [
      (w) => (w.capabilities.proof.tools.allow = ["read"]),
      /requires an allowed bash or shell/,
    ],
  ];
  for (const [mutate, expected] of cases) {
    const w = structuredClone(sample);
    mutate(w);
    assert.throws(() => parseWorkflow(w), expected);
  }
});

test("dependency-aware exploration catches deadlocks while preserving valid repair cycles", () => {
  assert.deepEqual(checkWorkflow(sample), []);
  const dead = structuredClone(sample);
  dead.capabilities.proof!.dependsOn = ["publish"];
  dead.capabilities.publish!.dependsOn = ["draft"];
  assert.throws(
    () => parseWorkflow(dead),
    /unreachable with completion prerequisites/,
  );
  // A different producer with identically named outputs cannot satisfy draft's contract.
  const branched = structuredClone(sample);
  branched.capabilities.alternate = structuredClone(
    branched.capabilities.draft!,
  );
  branched.admission.entries.push("alternate");
  branched.capabilities.proof!.dependsOn = [];
  assert.throws(
    () => parseWorkflow(branched),
    /not guaranteed on every entry path/,
  );
  branched.capabilities.alternate!.next!.ready = ["draft"];
  assert.doesNotThrow(() => parseWorkflow(branched));
  (branched.capabilities.draft!.outputs!.required as string[]) = ["labels"];
  assert.throws(
    () => parseWorkflow(branched),
    /not guaranteed on every entry path/,
  );
});

test("producer-scoped output types are independent; tool overlap and intentional pauses warn", () => {
  const w = structuredClone(sample);
  w.capabilities.proof!.outputs = {
    type: "object",
    properties: { labels: { type: "number" } },
  };
  assert.doesNotThrow(() => parseWorkflow(w));
  delete w.capabilities.proof!.outputs;
  w.capabilities.proof!.tools!.deny = ["read", "jev_report"];
  w.capabilities.draft!.next!.incomplete = ["publish"];
  assert.doesNotThrow(() => parseWorkflow(w));
  const warnings = checkWorkflow(w);
  assert.ok(warnings.some((d) => d.message.includes("deny wins")));
  assert.ok(warnings.some((d) => d.message.includes("exempt")));
  assert.ok(
    warnings.some(
      (d) => d.path.endsWith("next.incomplete") && d.message.includes("pauses"),
    ),
  );
  assert.ok(warnings.every((d) => d.severity === "warning"));
});

test("bounded analysis reports incomplete proof instead of inventing unreachable nodes", () => {
  const diagnostics = checkWorkflow(sample, 1);
  assert.ok(diagnostics.some((d) => d.message.includes("state limit")));
  assert.ok(!diagnostics.some((d) => d.severity === "error"));
});

test("host inventory checks model and tool identifiers without claiming availability guarantees", () => {
  const w = structuredClone(sample);
  w.capabilities.draft!.model = "provider/model";
  assert.deepEqual(checkHost(w, ["provider/model"], ["read", "bash"]), []);
  assert.equal(checkHost(w, [], []).length, 3);
});

test("CLI reports warnings, rejects bad contracts, and optionally queries host inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "foreman-checker-"));
  const file = join(root, "workflow.yaml");
  await writeFile(file, YAML.stringify(sample));
  const run = promisify(execFile);
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    requests.push(path);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        path === "/provider" ? { all: [], connected: [] } : ["read", "bash"],
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const result = await run(process.execPath, [
      "--import",
      "tsx",
      "scripts/cli/check-workflow.ts",
      file,
      "--host",
      `http://127.0.0.1:${address.port}`,
    ]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.valid, true);
    assert.equal(report.hostChecked, true);
    assert.deepEqual(report.diagnostics, []);
    assert.deepEqual(requests.sort(), ["/experimental/tool/ids", "/provider"]);
    const bad = structuredClone(sample);
    bad.capabilities.proof!.gate!.commands = "missing";
    await writeFile(file, YAML.stringify(bad));
    await assert.rejects(
      run(process.execPath, [
        "--import",
        "tsx",
        "scripts/cli/check-workflow.ts",
        file,
      ]),
      (error: any) =>
        error.code === 1 && error.stderr.includes("proof.gate.commands"),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
