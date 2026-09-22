import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { sanitize } from "../core/security.js";

export interface JevUsage {
  schema: 1;
  requestID: string;
  decisionID?: string;
  attempt?: number;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  sessionID: string | null;
  startedAt: string;
  finishedAt: string | null;
  requestedModel: string;
  model: string | null;
  status:
    | "pending"
    | "success"
    | "http_error"
    | "invalid_response"
    | "transport_error";
  httpStatus: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

// Separate from state.json: a Jev call runs inside a workflow transaction, and
// recording accounting data must not recursively acquire that transaction's lock.
export class UsageLog {
  readonly path: string;

  constructor(readonly root: string) {
    this.path = join(root, ".jev", "usage.jsonl");
  }

  async append(record: JevUsage): Promise<void> {
    const dir = join(this.root, ".jev");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await writeFile(join(dir, ".gitignore"), "*\n", { mode: 0o600 });
    // One small append per event; never rewrite a log another session is using.
    await appendFile(this.path, JSON.stringify(sanitize(record)) + "\n", {
      mode: 0o600,
    });
    await chmod(this.path, 0o600);
  }

  async read(): Promise<{ records: JevUsage[]; unreadableLines: number }> {
    let text: string;

    try {
      text = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { records: [], unreadableLines: 0 };

      throw e;
    }

    const records: JevUsage[] = [];
    let unreadableLines = 0;

    for (const line of text.split("\n").filter(Boolean)) {
      try {
        const value = JSON.parse(line) as JevUsage;

        if (
          value.schema !== 1 ||
          typeof value.requestID !== "string" ||
          ![
            "pending",
            "success",
            "http_error",
            "invalid_response",
            "transport_error",
          ].includes(value.status)
        )
          throw new Error("Invalid usage record");

        records.push(value);
      } catch {
        unreadableLines++;
      }
    }

    return { records, unreadableLines };
  }
}

export function summarizeUsage(records: JevUsage[]) {
  const latest = new Map<string, JevUsage>();

  for (const record of records) latest.set(record.requestID, record);

  const requests = [...latest.values()];
  const totals = (items: JevUsage[]) => ({
    requests: items.length,
    successfulRequests: items.filter((r) => r.status === "success").length,
    pendingRequests: items.filter((r) => r.status === "pending").length,
    failedRequests: items.filter(
      (r) => r.status !== "success" && r.status !== "pending",
    ).length,
    inputTokens: items.reduce(
      (sum, r) => sum + (tokenCount(r.inputTokens) ?? 0),
      0,
    ),
    outputTokens: items.reduce(
      (sum, r) => sum + (tokenCount(r.outputTokens) ?? 0),
      0,
    ),
    unknownInputRequests: items.filter(
      (r) => tokenCount(r.inputTokens) === null,
    ).length,
    unknownOutputRequests: items.filter(
      (r) => tokenCount(r.outputTokens) === null,
    ).length,
  });
  const models = [...new Set(requests.map((r) => r.model))].map((model) => ({
    model,
    requestedModels: [
      ...new Set(
        requests.filter((r) => r.model === model).map((r) => r.requestedModel),
      ),
    ],
    ...totals(requests.filter((r) => r.model === model)),
  }));
  const sessions = [...new Set(requests.map((r) => r.sessionID))].map(
    (sessionID) => ({
      sessionID,
      ...totals(requests.filter((r) => r.sessionID === sessionID)),
    }),
  );

  return { ...totals(requests), models, sessions };
}
