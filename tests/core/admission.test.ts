import { test } from "node:test";
import assert from "node:assert/strict";
import { decisionPrompt } from "../../src/core/runtime/context.js";
import { parseWorkflow } from "../../src/core/workflow/schema.js";
import { sample } from "../support/fixtures.js";

test("admission separates entry conditions, bypass criteria and optional routing guidance", () => {
  const w = structuredClone(sample);
  w.admission.instructions = "Prefer draft for new documents.";
  const prompt = decisionPrompt(parseWorkflow(w), {
    id: "admit",
    gate: "admission",
    choices: ["draft", "BYPASS"],
  });
  assert.match(prompt.instructions, /Substantial writing requests/);
  assert.match(prompt.instructions, /Prefer draft for new documents/);
  assert.equal(prompt.criteria.BYPASS, "Casual questions.");
  assert.equal(prompt.criteria.draft, w.capabilities.draft!.purpose);

  delete w.admission.instructions;
  delete w.admission.bypass;
  const defaults = decisionPrompt(parseWorkflow(w), {
    id: "admit",
    gate: "admission",
    choices: ["draft", "BYPASS"],
  });
  assert.match(defaults.instructions, /Substantial writing requests/);
  assert.doesNotMatch(defaults.instructions, /undefined|Routing guidance/);
  assert.equal(
    defaults.criteria.BYPASS,
    "Handle normally without this workflow",
  );
});

test("explicit admission excludes bypass guidance and transitions ignore admission policy", () => {
  const w = structuredClone(sample);
  w.admission.bypass = "BYPASS_MARKER";
  w.admission.instructions = "ROUTING_MARKER";
  const forced = decisionPrompt(w, {
    id: "admit",
    gate: "admission",
    choices: ["draft"],
  });
  assert.deepEqual(Object.keys(forced.criteria), ["draft"]);
  assert.match(forced.instructions, /explicitly requested/);
  assert.doesNotMatch(JSON.stringify(forced), /BYPASS_MARKER/);
  const transition = decisionPrompt(w, {
    id: "next",
    gate: "transition",
    choices: ["proof"],
  });
  assert.doesNotMatch(
    JSON.stringify(transition),
    /BYPASS_MARKER|ROUTING_MARKER|Substantial writing/,
  );
});

test("legacy instructions-only definitions remain valid without rewriting saved workflows", () => {
  const w = structuredClone(sample);
  w.admission = {
    instructions: "Use draft for writing; bypass casual chat.",
    entries: ["draft"],
  };
  const parsed = parseWorkflow(w);
  assert.deepEqual(parsed.admission, w.admission);
  assert.equal(
    decisionPrompt(parsed, {
      id: "admit",
      gate: "admission",
      choices: ["draft", "BYPASS"],
    }).instructions,
    w.admission.instructions,
  );
});

test("admission rejects missing conditions and malformed new fields", () => {
  for (const admission of [
    { entries: ["draft"] },
    { entries: ["draft"], bypass: "Everything" },
    { ...sample.admission, when: "" },
    { ...sample.admission, when: true },
    { ...sample.admission, bypass: false },
    { ...sample.admission, instructions: [] },
  ]) {
    assert.throws(
      () => parseWorkflow({ ...sample, admission }),
      /Invalid workflow/,
    );
  }
});

test("long admission fields stay bounded without starving optional routing guidance", () => {
  const w = structuredClone(sample);
  w.admission.when = "\u0001".repeat(24000);
  w.admission.bypass = "\u0001".repeat(24000);
  w.admission.instructions = "ROUTING_MARKER " + "\u0001".repeat(23000);
  const prompt = decisionPrompt(w, {
    id: "admit",
    gate: "admission",
    choices: ["draft", "BYPASS"],
  });
  assert.ok(Buffer.byteLength(JSON.stringify(prompt.instructions)) <= 2002);
  assert.ok(Buffer.byteLength(JSON.stringify(prompt.criteria)) <= 8000);
  assert.match(prompt.instructions, /ROUTING_MARKER/);
});
