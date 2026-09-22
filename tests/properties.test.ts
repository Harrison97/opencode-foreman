import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { WorkflowCompiler } from "../src/core/compiled.js";
import { mergeOutput } from "../src/core/output.js";
import { reduceRun, type Event } from "../src/core/engine.js";
import { invalidateCompleted, nextCapabilities } from "../src/core/graph.js";
import { checkWorkflow } from "../src/core/checker.js";
import { fixture, sample } from "./fixtures.js";

test("property: append preserves JSON-value uniqueness and valid final schemas", async () => {
  const w = structuredClone(sample);
  w.capabilities.draft!.outputs = {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        uniqueItems: true,
        items: {
          type: "object",
          required: ["value"],
          properties: { value: { type: "integer" } },
        },
      },
    },
  };
  w.capabilities.draft!.append = ["items"];
  delete w.capabilities.proof!.gate;
  delete w.capabilities.proof!.tools;
  const f = await fixture(w),
    base = await f.state(),
    compiled = new WorkflowCompiler().compile(w);
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: -10, max: 10 })),
      fc.array(fc.integer({ min: -10, max: 10 })),
      (old, added) => {
        const s = structuredClone(base);
        s.capabilityOutputs.draft = { items: old.map((value) => ({ value })) };
        const result = mergeOutput(compiled, s, {
          items: added.map((value) => ({ value })),
        });
        assert.deepEqual(
          result.items,
          [...new Set([...old, ...added])].map((value) => ({ value })),
        );
        assert.ok(compiled.capabilities.get("draft")!.validate!(result));
        assert.deepEqual(
          s.capabilityOutputs.draft.items,
          old.map((value) => ({ value })),
        );
      },
    ),
    { numRuns: 250, seed: 76123 },
  );
});

test("property: arbitrary runtime events cannot mutate input or falsely complete delivery", async () => {
  const f = await fixture();
  const initial = (await f.store.read()).workflows[(await f.state()).id]!;
  fc.assert(
    fc.property(
      fc.array(
        fc.constantFrom(
          "pause",
          "resume",
          "idle",
          "received",
          "finished",
          "lateDecision",
        ),
        { maxLength: 60 },
      ),
      (events) => {
        let s = structuredClone(initial);
        for (const [i, name] of events.entries()) {
          const before = structuredClone(s);
          const event: Event =
            name === "pause"
              ? { type: "pause", reason: "stop" }
              : name === "resume"
                ? { type: "resume" }
                : name === "idle"
                  ? { type: "idle", messageID: "assistant-" + i, maxTurns: 40 }
                  : name === "received"
                    ? { type: "received", messageID: "unrelated" }
                    : name === "finished"
                      ? {
                          type: "finished",
                          messageID: "unrelated",
                          parentID: "unrelated",
                        }
                      : {
                          type: "decision",
                          id: "stale",
                          version: -1,
                          answer: {
                            choice: "publish",
                            confidence: 1,
                            probabilities: { publish: 1 },
                          },
                        };
          const result = reduceRun(s, event, {
            at: "2026-01-01T00:00:00.000Z",
            decisionID: "decision-" + i,
            messageID: "msg_" + i,
          });
          assert.deepEqual(s, before);
          assert.ok(result.state.version >= s.version);
          assert.notEqual(result.state.phase.kind, "complete");
          s = result.state;
        }
      },
    ),
    { numRuns: 250, seed: 76124 },
  );
});

test("property: shared graph functions agree with checker on generated dependency chains", () => {
  fc.assert(
    fc.property(fc.integer({ min: 2, max: 12 }), (length) => {
      const w = {
        version: 1 as const,
        name: "chain",
        admission: { instructions: "run", entries: ["c0"] },
        capabilities: Object.fromEntries(
          Array.from({ length }, (_, i) => [
            "c" + i,
            {
              purpose: "work",
              instructions: "work",
              completion: "done",
              ...(i ? { dependsOn: ["c" + (i - 1)] } : {}),
              ...(i === length - 1
                ? { terminal: true }
                : { next: { ready: ["c" + (i + 1)], incomplete: ["c" + i] } }),
            },
          ]),
        ),
      };
      assert.ok(!checkWorkflow(w).some((d) => d.severity === "error"));
      let done = new Set<string>();
      for (let i = 0; i < length - 1; i++) {
        done.add("c" + i);
        assert.deepEqual(nextCapabilities(w, "c" + i, "ready", done), [
          "c" + (i + 1),
        ]);
        done = invalidateCompleted(w, done, "c" + (i + 1));
      }
      assert.deepEqual([...invalidateCompleted(w, done, "c0")], []);
    }),
    { numRuns: 100, seed: 76125 },
  );
});

test("compiled workflows are cached and definitions are immutable", () => {
  const compiler = new WorkflowCompiler();
  const first = compiler.compile(sample);
  assert.equal(compiler.compile(structuredClone(sample)), first);
  assert.throws(() => {
    first.definition.capabilities.draft!.purpose = "mutated";
  });
});
