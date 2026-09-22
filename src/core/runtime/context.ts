import type { WorkflowState, Workflow, DecisionRequest } from "../types.js";

// A bounded projection, not a second copy of persisted state. Every omission is marked.
function preview(value: unknown, depth = 0): unknown {
  if (typeof value === "string")
    return value.length > 600
      ? value.slice(0, 600) + `… [${value.length - 600} characters omitted]`
      : value;

  if (!value || typeof value !== "object") return value;

  if (depth >= 4) return "[nested value omitted; inspect saved outputs]";

  if (Array.isArray(value))
    return [
      ...value.slice(0, 8).map((v) => preview(v, depth + 1)),
      ...(value.length > 8 ? [`[${value.length - 8} entries omitted]`] : []),
    ];

  const entries = Object.entries(value);

  return {
    ...Object.fromEntries(
      entries.slice(0, 12).map(([k, v]) => [k, preview(v, depth + 1)]),
    ),
    ...(entries.length > 12 ? { _omittedFields: entries.length - 12 } : {}),
  };
}

export function decisionContext(state: WorkflowState): Record<string, unknown> {
  const phase =
    state.phase.kind === "paused" ? state.phase.resume : state.phase;
  const report =
    phase.kind === "deciding"
      ? phase.request.report
      : phase.kind === "reported"
        ? phase.report
        : undefined;
  const context: Record<string, unknown> = {
    gate: phase.kind === "deciding" ? phase.request.gate : "transition",
    goal: preview(state.goal),
    capability: state.capability,
    guidance: state.guidance.slice(-4).map((g) => preview(g)),
    report: preview(report),
    progress: state.progress.slice(-4).map((g) => preview(g)),
    evidence: state.evidence
      .filter((e) => e.epoch === state.epoch)
      .slice(-10)
      .map((e) => ({ command: preview(e.command), exit: e.exit })),
    outputs: {},
    note: "Bounded routing context. Full outputs/evidence remain in local state; omitted content is not evidence of completion.",
  };
  const outputs = context.outputs as Record<string, unknown>;
  const entries = Object.entries(state.capabilityOutputs).sort(
    ([a], [b]) =>
      Number(b === state.capability) - Number(a === state.capability),
  );

  for (const [id, output] of entries) {
    outputs[id] = preview(output);

    if (Buffer.byteLength(JSON.stringify(context)) > 12000) {
      delete outputs[id];
      context.outputsOmitted = true;
      break;
    }
  }

  // Very long property names and unusual JSON still cannot break the request envelope.
  if (Buffer.byteLength(JSON.stringify(context)) > 14000)
    return {
      gate: context.gate,
      goal: preview(state.goal),
      capability: state.capability,
      guidance: state.guidance.slice(-1).map((g) => preview(g)),
      summary: report?.summary.slice(0, 400),
      outcome: report?.outcome,
      detailsOmitted: true,
    };

  return context;
}

// Budget the encoded JSON string, including escaping and multi-byte characters.
function boundedText(value: string, limit: number): string {
  let low = 0,
    high = value.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);

    if (Buffer.byteLength(JSON.stringify(value.slice(0, mid))) - 2 <= limit)
      low = mid;
    else high = mid - 1;
  }

  return value.slice(0, low);
}

export function decisionPrompt(workflow: Workflow, request: DecisionRequest) {
  const emptyCriteria = Object.fromEntries(
    request.choices.map((id) => [id, ""]),
  );
  const each = Math.max(
    0,
    Math.floor(
      (8000 - Buffer.byteLength(JSON.stringify(emptyCriteria))) /
        request.choices.length,
    ),
  );
  const criteria = Object.fromEntries(
    request.choices.map((id) => [
      id,
      boundedText(
        id === "BYPASS"
          ? "Handle normally without this workflow"
          : workflow.capabilities[id]!.purpose,
        each,
      ),
    ]),
  );
  const instructions = boundedText(
    request.gate === "admission"
      ? workflow.admission.instructions
      : "Choose the next useful capability among ONLY the eligible options. Use the latest user guidance, outcome and evidence. Avoid repeating unchanged work.",
    2000,
  );

  return { criteria, instructions };
}
