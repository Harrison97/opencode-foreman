import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkflowFile } from "../core/workflow/loader.js";
export async function loadWorkflowConfig(directory: string) {
  const file = join(directory, "jev.workflow.yaml");
  let exists = true;
  try {
    await access(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
  }
  if (exists) return loadWorkflowFile(file);
  try {
    await access(join(directory, "jev.workflow.json"));
    throw new Error(
      "Legacy jev.workflow.json is model-only. Migrate to jev.workflow.yaml; see docs/workflows.md.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return loadWorkflowFile(
    fileURLToPath(
      new URL("../workflows/software-engineer/workflow.yaml", import.meta.url),
    ),
  );
}
