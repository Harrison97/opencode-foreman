import { randomUUID } from "node:crypto";
import { appendFile, chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Decision, WorkflowState } from "../types.js";
import { sanitize } from "../security.js";

export interface RoutingDiagnostic {
  schema: 1;
  id: string;
  requestID: string;
  workflowID: string;
  workflowHash: string;
  stateVersion: number;
  sessionID: string;
  gate: "admission" | "transition";
  from: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: "pending" | "applied" | "stale" | "cancelled" | "failed";
  input: {
    state: Record<string, unknown>;
    instructions: string;
    criteria: Record<string, string>;
  };
  excluded: Record<string, string>;
  answer?: Decision;
  error?: string;
}

export function routingDiagnostic(
  state: WorkflowState,
  input: RoutingDiagnostic["input"],
): RoutingDiagnostic {
  if (state.phase.kind !== "deciding")
    throw new Error("No routing decision pending");
  const request = state.phase.request;
  const allowed =
    request.gate === "admission"
      ? state.workflow.admission.entries
      : (state.workflow.capabilities[state.capability]!.next?.[
          request.report!.outcome
        ] ?? []);
  const excluded: Record<string, string> = {};
  for (const [id, capability] of Object.entries(state.workflow.capabilities)) {
    if (request.choices.includes(id)) continue;
    const missing = (capability.dependsOn ?? []).filter(
      (dep) => !Object.hasOwn(state.completed, dep),
    );
    excluded[id] = !allowed.includes(id)
      ? request.gate === "admission"
        ? "Not an admission entry"
        : `Not allowed after ${request.report!.outcome}`
      : missing.length
        ? `Unfinished dependencies: ${missing.join(", ")}`
        : capability.terminal && request.report?.outcome !== "ready"
          ? "Terminal entry requires a ready report"
          : "Not eligible";
  }
  if (request.gate === "admission" && !request.choices.includes("BYPASS"))
    excluded.BYPASS = "Explicit workflow request excludes bypass";
  return sanitize({
    schema: 1,
    id: randomUUID(),
    requestID: request.id,
    workflowID: state.id,
    workflowHash: state.workflowHash,
    stateVersion: state.version,
    sessionID: state.sessionID,
    gate: request.gate,
    from: request.gate === "admission" ? null : state.capability,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "pending",
    input,
    excluded,
  });
}

// Diagnostics never enter model context or acquire the workflow-state lock.
export async function appendRoutingDiagnostic(
  directory: string,
  record: RoutingDiagnostic,
) {
  const path = join(directory, "routing.jsonl");
  await appendFile(path, JSON.stringify(sanitize(record)) + "\n", {
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

export async function readRoutingDiagnostics(
  directory: string,
  sessionID?: string,
) {
  let text: string;
  try {
    text = await readFile(join(directory, "routing.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { records: [], unreadableLines: 0 };
    throw error;
  }
  const latest = new Map<string, RoutingDiagnostic>();
  let unreadableLines = 0;
  for (const line of text.split("\n").filter(Boolean)) {
    try {
      const record = JSON.parse(line) as RoutingDiagnostic;
      if (
        record.schema !== 1 ||
        typeof record.id !== "string" ||
        typeof record.sessionID !== "string" ||
        !["pending", "applied", "stale", "cancelled", "failed"].includes(
          record.status,
        ) ||
        !record.input?.criteria ||
        !record.excluded
      )
        throw new Error("Invalid routing diagnostic");
      if (!sessionID || record.sessionID === sessionID)
        latest.set(record.id, sanitize(record));
    } catch {
      unreadableLines++;
    }
  }
  return { records: [...latest.values()], unreadableLines };
}

export function routingDiagnosticText(record: RoutingDiagnostic) {
  return JSON.stringify(
    sanitize({
      ...record,
      selectedProbability: record.answer?.probabilities[record.answer.choice],
      note: "Confidence is Jev's reported confidence in its providerChoice. Probability belongs to the selected option. Pending records may indicate an interrupted call. Input is the bounded, redacted routing payload, not the full conversation.",
    }),
    null,
    2,
  );
}
