import type { Outcome, Workflow } from "./types.js";

export function invalidated(
  workflow: Workflow,
  capability: string,
): Set<string> {
  const result = new Set([capability]);
  for (const id of result)
    for (const [other, c] of Object.entries(workflow.capabilities))
      if (c.dependsOn?.includes(id)) result.add(other);
  return result;
}
export function invalidateCompleted(
  workflow: Workflow,
  completed: Iterable<string>,
  capability: string,
): Set<string> {
  const invalid = invalidated(workflow, capability);
  return new Set([...completed].filter((id) => !invalid.has(id)));
}
export function eligibleCapabilities(
  workflow: Workflow,
  completed: ReadonlySet<string>,
  ids: string[],
): string[] {
  return ids.filter(
    (id) =>
      Object.hasOwn(workflow.capabilities, id) &&
      (workflow.capabilities[id]!.dependsOn ?? []).every((dep) =>
        completed.has(dep),
      ),
  );
}
export function nextCapabilities(
  workflow: Workflow,
  capability: string,
  outcome: Outcome,
  completed: ReadonlySet<string>,
): string[] {
  return eligibleCapabilities(
    workflow,
    completed,
    workflow.capabilities[capability]!.next?.[outcome] ?? [],
  ).filter((id) => outcome === "ready" || !workflow.capabilities[id]!.terminal);
}
