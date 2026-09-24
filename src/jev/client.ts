import {
  APIError,
  TypeSafeClient,
  type SystemOneRequest,
} from "@typesafe-ai/sdk";
import type { Chooser, Decision } from "../core/types.js";
import { DecisionError, highestDecision } from "../core/runtime/decision.js";
import { sanitize } from "../core/security.js";
import { randomUUID } from "node:crypto";
import { tokenCount, type JevUsage } from "./usage.js";

export function parseDecision(payload: unknown, legal: string[]): Decision {
  const obj = payload as {
    model?: string;
    answers?: { next?: Partial<Decision> & { type?: string } };
  };
  const answer = obj?.answers?.next;

  if (
    !answer ||
    answer.type !== "choice" ||
    !legal.includes(answer.choice ?? "") ||
    typeof answer.confidence !== "number" ||
    !Number.isFinite(answer.confidence) ||
    answer.confidence < 0 ||
    answer.confidence > 1 ||
    !answer.probabilities ||
    typeof answer.probabilities !== "object"
  )
    throw new DecisionError("Invalid Jev Choice response");

  return highestDecision(
    {
      choice: answer.choice!,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      model: typeof obj.model === "string" ? obj.model : undefined,
    },
    legal,
  );
}

export class JevClient implements Chooser {
  constructor(
    private options: {
      key?: string;
      model?: string;
      timeoutMs?: number;
      fetch?: typeof fetch;
      onUsage?: (record: JevUsage) => Promise<void>;
      sleep?: (ms: number) => Promise<void>;
      onNotice?: (notice: {
        type: "retry" | "connected";
        message: string;
      }) => Promise<void>;
    } = {},
  ) {}

  private async notice(type: "retry" | "connected", message: string) {
    await this.options.onNotice?.({ type, message }).catch(() => {});
  }

  async choose(
    state: unknown,
    criteria: Record<string, string>,
    instructions: string,
    context?: { sessionID: string; signal?: AbortSignal; decisionID?: string },
  ): Promise<Decision> {
    context?.signal?.throwIfAborted();
    const key = this.options.key ?? process.env.TYPESAFE_API_KEY;

    if (!key)
      throw new DecisionError(
        "Jev credential unavailable. Set TYPESAFE_API_KEY and resume.",
      );

    const requestedModel =
      this.options.model ?? process.env.JEV_MODEL ?? "jev-latest";
    const body = JSON.stringify(
      sanitize({
        model: requestedModel,
        state,
        questions: { next: { type: "choice", instructions, criteria } },
      }),
    );

    if (Buffer.byteLength(body) > 28_000)
      throw new DecisionError(
        "Jev decision context exceeds budget. Reduce the workflow context before resuming.",
      );

    const client = new TypeSafeClient({
      apiKey: key,
      baseURL: "https://api.typesafe.ai",
      timeout: this.options.timeoutMs ?? 12_000,
      retry: { maxRetries: 0 }, // Foreman accounts for and controls every attempt.
      logLevel: "off", // SDK debug logging may include request/response bodies.
      fetch: (url, init) =>
        (this.options.fetch ?? fetch)(url, { ...init, redirect: "error" }),
    });
    const request = JSON.parse(body) as SystemOneRequest;
    const decisionID = context?.decisionID ?? randomUUID();

    for (let attempt = 1; attempt <= 6; attempt++) {
      context?.signal?.throwIfAborted();
      const usage: JevUsage = {
        schema: 1,
        requestID: randomUUID(),
        decisionID,
        attempt,
        sessionID: context?.sessionID ?? null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        requestedModel,
        model: null,
        status: "pending",
        httpStatus: null,
        inputTokens: null,
        outputTokens: null,
      };
      const record = async () => {
        try {
          await this.options.onUsage?.({ ...usage });
        } catch {
          throw new DecisionError(
            "Jev usage accounting could not be persisted. Repair local storage and resume.",
          );
        }
      };
      await record(); // Never send an unaccounted request.
      let result: Decision | undefined;
      let failure = "Jev connection failed or timed out";
      let retry = true;
      let delay = Math.min(1000 * 2 ** (attempt - 1), 16000);

      try {
        // Keep raw response access so malformed decisions still retain billed usage.
        const response = await client
          .systemOne(request, { signal: context?.signal })
          .asResponse();
        usage.httpStatus = response.status;
        usage.status = "invalid_response";
        const payload = await response.json();
        usage.model = typeof payload?.model === "string" ? payload.model : null;
        usage.inputTokens = tokenCount(payload?.usage?.input_tokens);
        usage.outputTokens = tokenCount(payload?.usage?.output_tokens);
        result = parseDecision(payload, Object.keys(criteria));
        usage.status = "success";
        usage.choice = result.choice;
        usage.providerChoice = result.providerChoice;
        usage.confidence = result.confidence;
        usage.probabilities = result.probabilities;
      } catch (error) {
        if (error instanceof APIError) {
          const status = error.status;
          usage.httpStatus = status;
          usage.status = "http_error";
          retry = [408, 429].includes(status) || status >= 500;
          failure = [401, 403].includes(status)
            ? `Jev authentication rejected (HTTP ${status}). Check your API key and access`
            : `Jev HTTP ${status}`;
          const header = error.headers.get("retry-after");
          if (header && retry) {
            const ms = /^\d+(\.\d+)?$/.test(header)
              ? Number(header) * 1000
              : Date.parse(header) - Date.now();
            if (Number.isFinite(ms)) delay = Math.max(delay, ms);
            if (delay > 30000) {
              retry = false;
              failure +=
                ". Server requested a retry delay longer than 30 seconds; wait before resuming";
            }
          }
        } else if (usage.status === "pending") usage.status = "transport_error";
        else if (usage.status === "invalid_response")
          failure = "Invalid Jev response";
        // No SDK error bodies, request objects, or arbitrary errors reach logs or state.
      }

      usage.finishedAt = new Date().toISOString();
      await record();
      context?.signal?.throwIfAborted();

      if (result) {
        await this.notice(
          "connected",
          "Jev connected; highest-ranked legal choice accepted.",
        );

        return result;
      }

      if (!retry || attempt === 6)
        throw new DecisionError(
          `${failure}. Paused after ${attempt} attempt(s). Resolve the issue and send foreman resume.`,
        );

      await this.notice(
        "retry",
        `${failure}. Retry ${attempt}/5 in ${delay / 1000}s.`,
      );
      await cancellableDelay(delay, context?.signal, this.options.sleep);
    }

    throw new DecisionError(
      "Jev retries exhausted. Send foreman resume to retry.",
    );
  }
}

function cancellableDelay(
  ms: number,
  signal?: AbortSignal,
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clean = () => {
      if (timer) clearTimeout(timer);

      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      clean();
      reject(new DecisionError("Jev request cancelled"));
    };
    const finish = () => {
      clean();
      resolve();
    };
    signal?.addEventListener("abort", abort, { once: true });

    if (sleep)
      sleep(ms).then(finish, (error) => {
        clean();
        reject(error);
      });
    else timer = setTimeout(finish, ms);
  });
}
