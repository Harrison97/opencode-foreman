import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkflowFile } from "../core/workflow/loader.js";

export async function loadWorkflowConfig(directory: string) {
  const file = join(directory, "foreman.workflow.yaml");
  let exists = true;

  try {
    await access(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;

    exists = false;
  }

  if (exists) return loadWorkflowFile(file);

  return loadWorkflowFile(
    fileURLToPath(
      new URL("../workflows/software-engineer/workflow.yaml", import.meta.url),
    ),
  );
}
