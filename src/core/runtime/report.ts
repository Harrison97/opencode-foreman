import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { Report, WorkflowState } from "../types.js";
import type {
  CompiledCapability,
  CompiledWorkflow,
} from "../workflow/compiled.js";
import { sanitize } from "../security.js";
import { mergeOutput, resolvedOutput } from "./output.js";

export function validateReport(input: Report): Report {
  const report = sanitize(input);

  if (Buffer.byteLength(JSON.stringify(report)) > 64000) {
    throw new Error("Report exceeds 64 KB");
  }

  if (
    !report.summary?.trim() ||
    !["ready", "incomplete", "blocked"].includes(report.outcome)
  ) {
    throw new Error("Invalid capability report");
  }

  if (report.outcome === "ready" && report.questions?.length) {
    throw new Error("Ready report cannot contain unresolved questions");
  }

  return report;
}

function artifactPaths(
  files: NonNullable<CompiledCapability["files"]>,
  state: WorkflowState,
  output: Record<string, unknown>,
): unknown {
  if (Array.isArray(files)) return files;

  if (!("producer" in files)) return undefined;

  return files.producer === state.capability
    ? output[files.field]
    : resolvedOutput(state, files);
}

async function verifyArtifacts(projectDirectory: string, paths: unknown) {
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    paths.some((path) => typeof path !== "string" || !path.trim())
  ) {
    throw new Error("Required artifact path list is missing or invalid");
  }

  const root = await realpath(projectDirectory);

  for (const name of paths) {
    const file = await realpath(resolve(root, name)).catch(() => undefined);
    const relativePath = file ? relative(root, file) : "..";
    const outsideProject =
      isAbsolute(name) ||
      relativePath === ".." ||
      relativePath.startsWith("../") ||
      isAbsolute(relativePath);

    if (!file || outsideProject || !(await stat(file)).isFile()) {
      throw new Error("Required artifact missing or outside project: " + name);
    }
  }
}

function verifyCommands(state: WorkflowState, commands: unknown) {
  if (
    !Array.isArray(commands) ||
    !commands.length ||
    commands.some((command) => typeof command !== "string" || !command.trim())
  ) {
    throw new Error("Required command list is missing");
  }

  for (const command of commands) {
    const latest = state.evidence.findLast(
      (evidence) =>
        evidence.command === command &&
        evidence.epoch === state.epoch &&
        evidence.revision === state.revision,
    );

    if (latest?.exit !== 0) {
      throw new Error(
        "Missing fresh passing native evidence for: " +
          command +
          ". Report incomplete to request repair.",
      );
    }
  }
}

function verifyAcceptance(report: Report, labels: unknown) {
  if (
    !Array.isArray(labels) ||
    !labels.length ||
    labels.some((label) => typeof label !== "string")
  ) {
    throw new Error("Missing coverage contract");
  }

  if (labels.some((label) => !report.covered?.includes(label))) {
    throw new Error(
      "Missing exact coverage. Correct the report; fresh checks do not need to be rerun.",
    );
  }
}

/** Validate the final snapshot before the controller publishes it atomically. */
export async function validateReportOutput(
  compiled: CompiledWorkflow,
  state: WorkflowState,
  report: Report,
  projectDirectory: string,
): Promise<Record<string, unknown> | undefined> {
  if (report.outcome !== "ready") {
    if (Object.keys(report.data ?? {}).length) {
      throw new Error("Incomplete reports cannot publish outputs");
    }

    return undefined;
  }

  const capability = compiled.capabilities.get(state.capability)!;
  const output = mergeOutput(compiled, state, report.data ?? {});

  if (capability.files) {
    await verifyArtifacts(
      projectDirectory,
      artifactPaths(capability.files, state, output),
    );
  }

  if (capability.commands) {
    verifyCommands(state, resolvedOutput(state, capability.commands));
  }

  if (capability.acceptance) {
    verifyAcceptance(report, resolvedOutput(state, capability.acceptance));
  }

  return output;
}
