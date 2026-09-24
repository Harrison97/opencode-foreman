import { resolve, join } from "node:path";
import { readRoutingDiagnostics } from "../../src/core/runtime/diagnostics.js";

const project = resolve(process.argv[2] ?? ".");
const sessionID = process.argv[3];
const result = await readRoutingDiagnostics(
  join(project, ".foreman"),
  sessionID,
);
console.log(JSON.stringify({ project, ...result }, null, 2));
