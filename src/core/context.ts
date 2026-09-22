import type { WorkflowState } from "./types.js";

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
export function decisionContext(s: WorkflowState): Record<string, unknown> {
  const p = s.phase.kind === "paused" ? s.phase.resume : s.phase;
  const report =
    p.kind === "deciding"
      ? p.request.report
      : p.kind === "reported"
        ? p.report
        : undefined;
  const context: Record<string, unknown> = {
    gate: p.kind === "deciding" ? p.request.gate : "transition",
    goal: preview(s.goal),
    capability: s.capability,
    guidance: s.guidance.slice(-4).map((g) => preview(g)),
    report: preview(report),
    progress: s.progress.slice(-4).map((g) => preview(g)),
    evidence: s.evidence
      .filter((e) => e.epoch === s.epoch)
      .slice(-10)
      .map((e) => ({ command: preview(e.command), exit: e.exit })),
    outputs: {},
    note: "Bounded routing context. Full outputs/evidence remain in local state; omitted content is not evidence of completion.",
  };
  const outputs = context.outputs as Record<string, unknown>;
  const entries = Object.entries(s.capabilityOutputs).sort(
    ([a], [b]) => Number(b === s.capability) - Number(a === s.capability),
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
      goal: preview(s.goal),
      capability: s.capability,
      guidance: s.guidance.slice(-1).map((g) => preview(g)),
      summary: report?.summary.slice(0, 400),
      outcome: report?.outcome,
      detailsOmitted: true,
    };
  return context;
}
