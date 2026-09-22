import { viewState, type WorkflowState } from "../types.js";
import { sanitize } from "../security.js";

export function workflowInstructions(state: WorkflowState) {
  const capability = state.workflow.capabilities[state.capability]!;
  const view = viewState(state);

  return [
    "Foreman workflow: " + state.workflow.name,
    "CURRENT CAPABILITY: " + state.capability,
    "Runtime phase: " + state.phase.kind,
    "Purpose: " + capability.purpose,
    capability.instructions,
    "Completion: " + capability.completion,
    "Output JSON schema: " + JSON.stringify(capability.outputs ?? null),
    "Tool rules: " + JSON.stringify(capability.tools ?? {}),
    "Required gates: " + JSON.stringify(capability.gate ?? {}),
    view.status === "paused"
      ? "Present the pause reason and questions; wait for real user input. Do not use tools."
      : view.status === "delivering" || view.status === "complete"
        ? "Deliver this capability’s final response. Do not use tools."
        : "Perform only the current capability. Call jev_report with summary, outcome and workflow-defined data. Incomplete/blocked reports cannot publish outputs. Questions are essential human decisions only. Correct rejected reports; finish your response after acceptance. Foreman chooses the next capability.",
    "Outputs are scoped by producer. Reference capabilityOutputs[capability][field]. Carry forward earlier criteria explicitly when producing your own contract. Never edit Foreman state/config to bypass gates or expose credentials.",
    JSON.stringify(
      sanitize({
        goal: state.goal,
        guidance: state.guidance,
        capabilityOutputs: state.capabilityOutputs,
        completed: state.completed,
        progress: state.progress.slice(-8),
        questions: view.questions,
        pauseReason: view.pauseReason,
        reportAccepted: state.phase.kind === "reported",
      }),
    ),
  ].join("\n");
}
