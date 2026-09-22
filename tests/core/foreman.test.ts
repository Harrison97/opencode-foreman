import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadWorkflowFile } from "../../src/core/workflow/loader.js";
import { checkWorkflow } from "../../src/core/workflow/checker.js";
import { Controller } from "../../src/core/runtime/controller.js";
import { StateStore } from "../../src/core/persistence/store.js";
import { fixture } from "../support/fixtures.js";
import type { Report } from "../../src/core/types.js";

const workflow = await loadWorkflowFile(
  resolve("src/workflows/software-engineer/workflow.yaml"),
);
const artifacts = [".foreman/campaign.json", ".foreman/checkpoint.md"];
const acceptance = ["The user can save and reload a record"];
const commands = ["node --test"];

async function campaign(maxTurns = 40) {
  let choice = "interview";
  const chooser = {
    choose: async (_state: unknown, criteria: Record<string, string>) => {
      assert.ok(
        Object.hasOwn(criteria, choice),
        `Ineligible choice: ${choice}`,
      );
      return {
        choice,
        confidence: 1,
        probabilities: Object.fromEntries(
          Object.keys(criteria).map((key) => [key, key === choice ? 1 : 0]),
        ),
      };
    },
  };
  const f = await fixture(workflow, chooser);
  const c = new Controller(f.store, chooser, { workflow, maxTurns });
  let turn = 0;
  const enter = async (target: string, report: Report) => {
    choice = target;
    await c.report("s", report);
    const next = (await c.gate("s", `assistant-${++turn}`))!;
    if (next.pending && next.status !== "paused")
      await c.received("s", next.pending.id);
    return (await c.get("s"))!;
  };
  const file = async (path: string, content = "Evidence and decisions") => {
    await mkdir(dirname(join(f.root, path)), { recursive: true });
    await writeFile(join(f.root, path), content);
  };
  const brief = {
    summary: "User supplied the complete spec and delegated routine decisions",
    outcome: "ready" as const,
    data: {
      artifacts: [".foreman/brief.md"],
      acceptance,
      blockingQuestions: [],
      proceedingBasis:
        "User explicitly confirmed local storage and the save/reload scenario",
    },
  };
  const planned = {
    summary: "Graph checked; independent box storage is ready",
    outcome: "ready" as const,
    data: {
      artifacts,
      assignment: "storage",
      nextAction: "execute",
      remainingLimits: "Two attempts remain; no user spending cap",
    },
  };
  const built = {
    summary: "Storage implemented; behavioral checks ready",
    outcome: "ready" as const,
    data: { artifacts, boxId: "storage", commands, acceptance },
  };
  const start = async () => {
    await file(".foreman/brief.md");
    await enter("design", brief);
    await file(".foreman/contracts.md");
    await enter("plan", {
      summary: "Reviewed design and storage contracts",
      outcome: "ready",
      data: { artifacts: [".foreman/contracts.md"] },
    });
    for (const path of artifacts) await file(path);
    await enter("build", planned);
  };
  const evidence = (exit: number, callID = "check") =>
    c.evidence("s", {
      callID,
      command: commands[0]!,
      exit,
      output: "Native result",
    });
  return {
    ...f,
    c,
    chooser,
    enter,
    file,
    brief,
    planned,
    built,
    start,
    evidence,
  };
}

test("Foreman default has valid repair paths and only final verification can deliver", () => {
  assert.deepEqual(checkWorkflow(workflow), []);
  assert.deepEqual(workflow.admission.entries, ["interview"]);
  for (const [id, c] of Object.entries(workflow.capabilities)) {
    if (
      Object.values(c.next ?? {})
        .flat()
        .includes("deliver")
    )
      assert.equal(id, "verify");
  }
  assert.equal(
    workflow.capabilities.verify!.gate!.commands,
    "release.commands",
  );
});

test("interview requires a durable brief, resolved questions and proceeding basis", async () => {
  const f = await campaign();
  await assert.rejects(f.c.report("s", f.brief), /artifact missing/);
  await assert.rejects(f.c.beforeTool("s", "question"), /Tool unavailable/);
  await f.c.beforeTool("s", "foreman_report");
  await f.file(
    ".foreman/brief.md",
    "Users and acceptance still need agreement",
  );
  await assert.rejects(
    f.c.report("s", {
      ...f.brief,
      data: { ...f.brief.data, blockingQuestions: ["Who is it for?"] },
    }),
    /output/i,
  );
  const paused = await f.enter("interview", {
    summary: "Partial brief saved; audience changes the build",
    outcome: "blocked",
    questions: ["Is this for a single user or a shared team?"],
  });
  assert.equal(paused.status, "paused");
  const restored = new Controller(new StateStore(f.root), f.chooser, {
    workflow,
  });
  await restored.admit(
    "s",
    "Single user. Local only; proceed with routine choices.",
    "answer",
  );
  assert.equal((await restored.get("s"))!.capability, "interview");
  assert.match((await restored.get("s"))!.guidance.join(" "), /Single user/);
  await f.enter("design", f.brief);
});

test("implementation can discover deeper design, invalidate dependents and resume a bounded box", async () => {
  const f = await campaign();
  await f.start();
  const design = await f.enter("design", {
    summary:
      "Storage contract lacks conflict semantics; box marked needs-design",
    outcome: "incomplete",
  });
  assert.equal(design.capability, "design");
  assert.equal(design.completed.plan, undefined);
  await f.enter("plan", {
    summary:
      "Conflict contract reviewed; downstream boxes invalidated in ledger",
    outcome: "ready",
    data: { artifacts },
  });
  assert.equal((await f.enter("build", f.planned)).capability, "build");
});

test("failed box verification requires repair and fresh re-verification", async () => {
  const f = await campaign();
  await f.start();
  await f.enter("review", f.built);
  const checked: Report = {
    summary: "Behavior inspected",
    outcome: "ready",
    covered: acceptance,
  };
  await f.evidence(1);
  await assert.rejects(f.c.report("s", checked), /fresh passing/);
  await f.enter("build", {
    summary: "Reload loses records: implementation defect",
    outcome: "incomplete",
  });
  await f.enter("review", f.built);
  await assert.rejects(f.c.report("s", checked), /fresh passing/);
  await f.evidence(0, "recheck");
  assert.equal((await f.enter("checkpoint", checked)).capability, "checkpoint");
});

test("a branch blocker can return to planning without globally pausing; essential questions do pause", async () => {
  const f = await campaign();
  await f.start();
  const replanned = await f.enter("plan", {
    summary:
      "Sharing needs a product decision, stored on that branch; local storage is independent",
    outcome: "incomplete",
  });
  assert.equal(replanned.status, "running");
  const paused = await f.enter("plan", {
    summary: "All independent work exhausted; sharing remains blocked",
    outcome: "blocked",
    questions: ["Should sharing be public or invitation-only?"],
  });
  assert.equal(paused.status, "paused");
  // Branch scheduling itself is agent-managed; this test proves only the host pause contract.
});

test("work-unit exhaustion persists a resumable stop instead of losing the accepted report", async () => {
  const f = await campaign(1);
  await f.file(".foreman/brief.md");
  const paused = await f.enter("design", f.brief);
  assert.equal(paused.status, "paused");
  assert.match(paused.pauseReason!, /limit/);
  const restored = new Controller(new StateStore(f.root), f.chooser, {
    workflow,
  });
  assert.equal((await restored.get("s"))!.report!.outcome, "ready");
  await restored.admit("s", "continue", "renew");
  assert.equal((await restored.get("s"))!.status, "running");
});

test("interrupted box reconstructs from pinned state and whole-product verification ends the campaign", async () => {
  const f = await campaign();
  await f.start();
  await f.c.pause(
    "s",
    "Interrupted while storage box was running; reconcile before replay",
  );
  const restored = new Controller(new StateStore(f.root), f.chooser, {
    workflow,
  });
  await restored.admit("fresh-session", "foreman resume", "resume");
  const resumed = (await restored.get("fresh-session"))!;
  assert.equal(resumed.id, (await f.c.list())[0]!.id);
  assert.equal(resumed.capability, "build");
  assert.deepEqual(resumed.capabilityOutputs.plan!.artifacts, artifacts);
  // Return ownership to the test session using the supported pause/resume path.
  await restored.pause("fresh-session", "Move host session");
  await f.c.admit("s", "foreman resume", "resume-again");
  await f.enter("review", f.built);
  await f.evidence(0);
  await f.enter("checkpoint", {
    summary: "Box verified",
    outcome: "ready",
    covered: acceptance,
  });
  await f.enter("plan", {
    summary: "Box and stage evidence checkpointed",
    outcome: "ready",
    data: { artifacts },
  });
  await f.enter("release", {
    ...f.planned,
    data: { ...f.planned.data, nextAction: "final-verification" },
  });
  await assert.rejects(
    f.c.report("s", {
      summary: "Premature release",
      outcome: "ready",
      data: { artifacts, commands, acceptance, allRequiredWorkVerified: false },
    }),
    /output/i,
  );
  await f.enter("verify", {
    summary: "All required work and integration verified",
    outcome: "ready",
    data: { artifacts, commands, acceptance, allRequiredWorkVerified: true },
  });
  await assert.rejects(
    f.c.report("s", { summary: "Done", outcome: "ready", covered: acceptance }),
    /fresh passing/,
  );
  await f.evidence(0, "final-check");
  const delivery = await f.enter("deliver", {
    summary: "Original goals verified",
    outcome: "ready",
    covered: acceptance,
  });
  assert.equal(delivery.phase.kind, "delivering");
  if (delivery.phase.kind !== "delivering")
    throw new Error("Expected delivery");
  await f.c.finished("s", "final", delivery.phase.delivery.id);
  assert.equal((await f.c.get("s"))!.status, "complete");
  assert.equal(await f.c.gate("s", "extra-turn"), undefined);
});
