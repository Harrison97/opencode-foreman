import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import YAML from "yaml";
import {
  viewState,
  type Database,
  type Workflow,
  type WorkflowView,
} from "../../src/core/types.js";
import { sanitize } from "../../src/core/security.js";
import { UsageLog, summarizeUsage } from "../../src/jev/usage.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = await realpath(
  await mkdtemp(join(tmpdir(), "foreman-generic-smoke-")),
);
const modelName = process.env.FOREMAN_SMOKE_MODEL ?? "openai/gpt-5.6-luna";
const slash = modelName.indexOf("/");
const model = {
  providerID: modelName.slice(0, slash),
  modelID: modelName.slice(slash + 1),
};
const summary: Record<string, any> = {
  root,
  model: modelName,
  startedAt: new Date().toISOString(),
  runs: [],
};
let server: ChildProcess | undefined;
let url = "";
async function start() {
  const port = await new Promise<number>((res) => {
    const socket = createServer();
    socket.listen(0, "127.0.0.1", () => {
      const port = (socket.address() as { port: number }).port;
      socket.close(() => res(port));
    });
  });
  url = "http://127.0.0.1:" + port;
  server = spawn(
    "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: root,
      env: {
        ...process.env,
        FOREMAN_DISABLED: "0",
        OPENCODE_SERVER_PASSWORD: "",
        OPENCODE_SERVER_USERNAME: "",
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  for (let i = 0; i < 160; i++) {
    if (server.exitCode !== null) throw new Error("OpenCode startup failed");
    try {
      if ((await fetch(url + "/global/health")).ok) return;
    } catch {
      // The host may not have bound its port yet; poll until the startup deadline.
    }
    await delay(250);
  }
  throw new Error("Host health timeout");
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  for (let i = 0; i < 30 && server.exitCode === null; i++) await delay(100);
  if (server.exitCode === null) server.kill("SIGKILL");
}
async function api(path: string, dir: string, body?: unknown): Promise<any> {
  const response = await fetch(
    url + path + "?directory=" + encodeURIComponent(dir),
    {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  if (!response.ok)
    throw new Error("Host HTTP " + response.status + " at " + path);
  return response.status === 204 ? undefined : response.json();
}
async function state(dir: string): Promise<WorkflowView | undefined> {
  try {
    const db = JSON.parse(
      await readFile(join(dir, ".foreman/foreman-state.json"), "utf8"),
    ) as Database;
    return db.workflows[db.active!]
      ? viewState(db.workflows[db.active!]!)
      : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function waitFor(
  dir: string,
  predicate: (s: WorkflowView) => boolean,
  seconds = 360,
) {
  const until = Date.now() + seconds * 1000;
  let previous = "";
  while (Date.now() < until) {
    const s = await state(dir);
    if (s) {
      const display = s.capability + "/" + s.status + "/" + s.epoch;
      if (display !== previous) {
        console.log(dir.split("/").at(-1) + ": " + display);
        previous = display;
      }
      if (predicate(s)) return s;
      if (s.status === "paused")
        throw new Error(
          "Unexpected pause: " + s.pauseReason + " " + s.questions.join("; "),
        );
    }
    await delay(200);
  }
  throw new Error("Smoke timeout");
}
async function project(name: string, workflow?: Workflow) {
  const dir = join(root, name);
  await mkdir(dir);
  await writeFile(
    join(dir, "opencode.json"),
    JSON.stringify({
      model: modelName,
      permission: { "*": "allow", external_directory: "deny" },
      share: "disabled",
    }),
  );
  if (workflow)
    await writeFile(
      join(dir, "foreman.workflow.yaml"),
      YAML.stringify(workflow),
    );
  return dir;
}
async function submit(dir: string, sessionID: string, text: string) {
  await api("/session/" + sessionID + "/prompt_async", dir, {
    model,
    parts: [{ type: "text", text }],
  });
}
async function retain(dir: string, s: WorkflowView) {
  // Wait for final host delivery to include final-response usage.
  await delay(2000);
  const messages = await api("/session/" + s.sessionID + "/message", dir);
  await writeFile(
    join(dir, "smoke-transcript.json"),
    JSON.stringify(sanitize(messages), null, 2),
  );
  summary.runs.push({
    directory: dir,
    workflow: s.workflow.name,
    status: s.status,
    history: s.history,
    evidence: s.evidence,
    modelHistory: s.modelHistory,
    jev: summarizeUsage((await new UsageLog(dir).read()).records),
  });
}
try {
  await start();
  if (process.env.FOREMAN_SMOKE_SCENARIO === "interview") {
    const dir = await project("default-interview");
    const session = await api("/session", dir, {
      title: "Foreman ambiguous idea interview",
    });
    await submit(
      dir,
      session.id,
      "foreman: I want to build an app that helps people organize their lives. Interview me before deciding what to build.",
    );
    const paused = await waitFor(dir, (s) => s.status === "paused");
    assert.equal(paused.capability, "interview");
    assert.ok(paused.questions.length > 0);
    const brief = await readFile(join(dir, ".foreman/brief.md"), "utf8");
    assert.ok(
      brief.length > 200,
      "Expected a substantive durable partial brief",
    );
    assert.equal(paused.completed.interview, undefined);
    assert.equal(
      paused.history.some((t) => t.to === "build"),
      false,
    );
    await retain(dir, paused);
    console.log(
      "PASS: default Foreman asks product questions and persists a partial brief before implementation.",
    );
  } else {
    const custom: Workflow = {
      version: 1,
      name: "greeting-editor",
      admission: {
        when: "Requested greetings.",
        bypass: "Unrelated requests.",
        entries: ["compose"],
      },
      capabilities: {
        compose: {
          purpose: "Write the greeting artifact",
          instructions:
            "Write greeting.txt containing exactly Hello Foreman followed by a newline. On a return after a failed check, restore this same correct greeting. Do not modify contract.mjs or the smoke marker. Report ready.",
          tools: {
            allow: ["read", "write", "edit", "apply_patch", "glob", "grep"],
          },
          completion: "The greeting is written",
          gate: { files: ["greeting.txt"] },
          outputs: {
            type: "object",
            additionalProperties: false,
            required: ["commands", "criteria"],
            properties: {
              commands: { const: ["node contract.mjs"] },
              criteria: { const: ["Greeting is exact"] },
            },
          },
          next: {
            ready: ["inspect"],
            incomplete: ["compose"],
            blocked: ["compose"],
          },
        },
        inspect: {
          purpose: "Check the greeting",
          instructions:
            "Run node contract.mjs exactly. On failure report incomplete; compose will repair. On success report ready with covered containing Greeting is exact. Do not edit files.",
          completion: "Native check passes",
          dependsOn: ["compose"],
          tools: { allow: ["read", "bash", "shell"], declaredChecksOnly: true },
          gate: {
            commands: "compose.commands",
            acceptance: "compose.criteria",
          },
          next: {
            ready: ["hand_off"],
            incomplete: ["compose"],
            blocked: ["compose"],
          },
        },
        hand_off: {
          purpose: "Deliver greeting",
          instructions: "Give the greeting and confirm the check result.",
          completion: "Delivered",
          dependsOn: ["inspect"],
          terminal: true,
        },
      },
    };
    if (process.env.FOREMAN_SMOKE_SCENARIO !== "default") {
      const dir = await project("custom-repair", custom);
      await writeFile(
        join(dir, "contract.mjs"),
        `import {existsSync,writeFileSync,readFileSync} from 'node:fs';\nimport assert from 'node:assert/strict';\nif(!existsSync('.smoke-fault-injected')){writeFileSync('.smoke-fault-injected','once');writeFileSync('greeting.txt','Helo Foreman\\n');}\nassert.equal(readFileSync('greeting.txt','utf8'),'Hello Foreman\\n');\nconsole.log('PASS');\n`,
      );
      const session = await api("/session", dir, {
        title: "Foreman custom workflow smoke",
      });
      await submit(
        dir,
        session.id,
        "foreman: Produce the local greeting artifact and check it. Use the configured workflow; make routine decisions yourself.",
      );
      const end = await waitFor(dir, (s) => s.status === "complete");
      assert.ok(
        end.history.some((t) => t.from === "inspect" && t.to === "compose"),
      );
      assert.ok(end.evidence.some((e) => e.exit !== 0));
      assert.ok(end.evidence.some((e) => e.exit === 0));
      assert.equal(
        await readFile(join(dir, "greeting.txt"), "utf8"),
        "Hello Foreman\n",
      );
      assert.ok(
        summarizeUsage((await new UsageLog(dir).read()).records)
          .successfulRequests > 0,
      );
      await retain(dir, end);
    }
    // Same generic engine, bundled software workflow.
    const app = await project("default-software");
    await writeFile(
      join(app, "DESIGN.md"),
      "Implement sum(a,b) in sum.mjs; require finite numbers, otherwise throw TypeError. No dependencies. Add node:test tests, npm test, and README. Use node --test as the terminating verification command.",
    );
    const software = await api("/session", app, {
      title: "Foreman default YAML smoke",
    });
    await submit(
      app,
      software.id,
      "foreman: Implement the complete module specified in DESIGN.md, with tests and README. Make routine engineering decisions yourself.",
    );
    const delivered = await waitFor(app, (s) => s.status === "complete", 900);
    assert.ok(delivered.history.some((t) => t.to === "review"));
    assert.ok(delivered.history.some((t) => t.to === "verify"));
    assert.equal(delivered.workflow.name, "Foreman");
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import {sum} from './sum.mjs'; import assert from 'node:assert/strict'; assert.equal(sum(2,3),5); assert.throws(()=>sum(NaN,2),TypeError);",
      ],
      { cwd: app },
    );
    await retain(app, delivered);

    if (process.env.FOREMAN_SMOKE_SCENARIO !== "default") {
      // Actual human pause and host restart using arbitrary capability names.
      const human = structuredClone(custom);
      human.name = "greeting-with-user-decision";
      human.capabilities.compose!.instructions =
        "If progress contains no human guidance, report blocked with questions asking for the greeting text. Do not make the choice yourself. After guidance, write greeting.txt containing Hello Foreman and a newline and report ready with commands [node contract.mjs] and criteria [Greeting is exact].";
      const waitingDir = await project("human-resume", human);
      await writeFile(
        join(waitingDir, "contract.mjs"),
        "import {readFileSync} from 'node:fs'; import assert from 'node:assert/strict'; assert.equal(readFileSync('greeting.txt','utf8'),'Hello Foreman\\n');",
      );
      const humanSession = await api("/session", waitingDir, {
        title: "Foreman human resume smoke",
      });
      await submit(
        waitingDir,
        humanSession.id,
        "foreman: Prepare the greeting; ask me which greeting to use.",
      );
      const paused = await waitFor(waitingDir, (s) => s.status === "paused");
      assert.ok(paused.questions.length);
      await delay(1000);
      assert.equal((await state(waitingDir))!.epoch, paused.epoch);
      await stop();
      await start();
      assert.equal((await state(waitingDir))!.id, paused.id);
      await submit(
        waitingDir,
        humanSession.id,
        "Use exactly Hello Foreman followed by a newline.",
      );
      // Admission happens asynchronously; wait for it to consume human guidance.
      for (
        let i = 0;
        i < 100 && (await state(waitingDir))?.status === "paused";
        i++
      )
        await delay(100);
      const resumed = await waitFor(waitingDir, (s) => s.status === "complete");
      assert.equal(resumed.id, paused.id);
      await retain(waitingDir, resumed);
    }
  }
  summary.success = true;
  if (process.env.FOREMAN_SMOKE_SCENARIO === "default")
    console.log(
      "PASS: default Foreman campaign completed with native verification and real Jev.",
    );
  else if (process.env.FOREMAN_SMOKE_SCENARIO !== "interview")
    console.log(
      "PASS: custom capability repair, default Foreman YAML, human resume, host restart, and real Jev usage.",
    );
} catch (error) {
  summary.success = false;
  summary.error = error instanceof Error ? error.message : String(error);
  console.error(summary.error);
  process.exitCode = 1;
} finally {
  await stop();
  await mkdir(resolve("artifacts"), { recursive: true });
  await writeFile(
    join(root, "smoke-result.json"),
    JSON.stringify(sanitize(summary), null, 2),
  );
  await writeFile(
    resolve(
      process.env.FOREMAN_SMOKE_SCENARIO === "interview"
        ? "artifacts/foreman-interview-smoke.json"
        : process.env.FOREMAN_SMOKE_SCENARIO === "default"
          ? "artifacts/foreman-default-smoke.json"
          : "artifacts/foreman-generic-smoke.json",
    ),
    JSON.stringify(sanitize(summary), null, 2),
  );
  console.log("Smoke artifacts: " + root);
}
