import { resolve } from 'node:path';
import { loadWorkflowFile } from '../src/core/loader.js';
import { workflowHash } from '../src/core/workflow.js';
import { redact } from '../src/core/security.js';
try {
  const workflow = await loadWorkflowFile(resolve(process.argv[2] ?? 'jev.workflow.yaml'));
  console.log(redact(JSON.stringify({ valid: true, name: workflow.name, hash: workflowHash(workflow),
    entries: workflow.admission.entries, capabilities: Object.keys(workflow.capabilities) }, null, 2)));
} catch (error) {
  console.error(redact(error instanceof Error ? error.message : 'Workflow validation failed'));
  process.exitCode = 1;
}
