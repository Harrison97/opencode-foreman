import { resolve } from "node:path";
import { loadWorkflowFile } from "../../src/core/workflow/loader.js";
import { workflowHash } from "../../src/core/workflow/schema.js";
import { redact } from "../../src/core/security.js";
import { checkWorkflow, checkHost } from "../../src/core/workflow/checker.js";
try {
  const args = process.argv.slice(2);
  const file =
    args[0] && !args[0].startsWith("--") ? args.shift()! : "jev.workflow.yaml";
  let host: string | undefined;
  if (args[0] === "--host" && args[1] && args.length === 2) host = args[1];
  else if (args.length)
    throw new Error(
      "Usage: workflow:check -- [workflow.yaml] [--host http://localhost:4096]",
    );
  const workflow = await loadWorkflowFile(resolve(file));
  const diagnostics = checkWorkflow(workflow);
  if (host) {
    const url = new URL(host);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error(
        "Host must be an HTTP(S) URL without embedded credentials",
      );
    const get = async (path: string) => {
      const target = new URL(path, url);
      target.searchParams.set("directory", process.cwd());
      const response = await fetch(target, {
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      if (!response.ok)
        throw new Error(
          `Host inventory request failed (${response.status}); check the server URL and access configuration`,
        );
      return response.json();
    };
    const [providers, tools] = await Promise.all([
      get("/provider"),
      get("/experimental/tool/ids"),
    ]);
    if (
      !Array.isArray(providers?.all) ||
      !Array.isArray(providers?.connected) ||
      !Array.isArray(tools) ||
      tools.some((t: unknown) => typeof t !== "string")
    )
      throw new Error("Unsupported host inventory response");
    const models = providers.all
      .filter((p: any) => providers.connected.includes(p.id))
      .flatMap((p: any) =>
        Object.keys(p.models ?? {}).map((m) => `${p.id}/${m}`),
      );
    diagnostics.push(...checkHost(workflow, models, tools));
  }
  console.log(
    redact(
      JSON.stringify(
        {
          valid: true,
          name: workflow.name,
          hash: workflowHash(workflow),
          entries: workflow.admission.entries,
          capabilities: Object.keys(workflow.capabilities),
          diagnostics,
          hostChecked: Boolean(host),
        },
        null,
        2,
      ),
    ),
  );
} catch (error) {
  console.error(
    redact(
      error instanceof Error ? error.message : "Workflow validation failed",
    ),
  );
  process.exitCode = 1;
}
