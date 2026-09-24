import { viewState, type WorkflowState, type WorkflowView } from "../types.js";
import { sanitize } from "../security.js";
import { outputReference } from "../workflow/references.js";
import { resolvedOutput } from "./output.js";

export function gateInputs(state: WorkflowState) {
  const gate = state.workflow.capabilities[state.capability]!.gate ?? {};
  return Object.fromEntries(
    Object.entries(gate).map(([key, value]) => {
      const ref =
        typeof value === "string" ? outputReference(value) : undefined;
      return [key, ref ? resolvedOutput(state, ref) : value];
    }),
  );
}

export function workflowInstructions(state: WorkflowState) {
  const capability = state.workflow.capabilities[state.capability]!;
  const view = viewState(state);
  const outputProperties = capability.outputs?.properties;
  const commandsAreGated =
    outputProperties &&
    typeof outputProperties === "object" &&
    Object.hasOwn(outputProperties, "commands") &&
    Object.values(state.workflow.capabilities).some((candidate) => {
      const reference = candidate.gate?.commands
        ? outputReference(candidate.gate.commands)
        : undefined;
      return (
        reference?.producer === state.capability &&
        reference.field === "commands"
      );
    });

  return [
    "Foreman workflow: " + state.workflow.name,
    "CURRENT CAPABILITY: " + state.capability,
    "Runtime phase: " + state.phase.kind,
    "Purpose: " + capability.purpose,
    capability.instructions,
    "Completion: " + capability.completion,
    "Output JSON schema: " + JSON.stringify(capability.outputs ?? null),
    "Tool rules: " + JSON.stringify(capability.tools ?? {}),
    commandsAreGated
      ? "Commands contract: every commands item is a finite, directly runnable shell command from the project root. Put manual actions such as opening or visually inspecting a page in acceptance or documentation, not commands. Do not put prose instructions in commands."
      : undefined,
    "Required gates: " + JSON.stringify(capability.gate ?? {}),
    "Required gate inputs: " + JSON.stringify(gateInputs(state)),
    capability.outputs
      ? "Publish only this capability’s declared data."
      : "This capability declares no output data. Omit data from foreman_report; a report is still required. This does not mean the workflow is complete.",
    taskInstructions(view.status),
    "Use foreman_status with producer to read earlier outputs as needed. Outputs are scoped by producer. Reference capabilityOutputs[capability][field]. Carry forward earlier criteria explicitly when producing your own contract. Never edit Foreman state/config to bypass gates or expose credentials.",
    JSON.stringify(
      sanitize({
        goal: state.goal,
        guidance: state.guidance,
        availableOutputs: Object.keys(state.capabilityOutputs),
        completed: state.completed,
        progress: state.progress.slice(-3),
        questions: view.questions,
        pauseReason: view.pauseReason,
        reportAccepted: state.phase.kind === "reported",
      }),
    ),
  ].join("\n");
}

function taskInstructions(status: WorkflowView["status"]): string {
  if (status === "paused") {
    return "Present the pause reason and questions; wait for real user input. Do not use tools.";
  }

  if (status === "delivering" || status === "complete") {
    return "Deliver this capability’s final response. Do not use tools.";
  }

  return "Perform only the current capability. Call foreman_report with summary, outcome and workflow-defined data. Incomplete/blocked reports cannot publish outputs. Questions are essential human decisions only. Correct rejected reports; finish your response after acceptance. Foreman chooses the next capability.";
}
