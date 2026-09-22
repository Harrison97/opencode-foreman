# Foreman runtime

See [the runtime design](runtime.md) and
[the workflow authoring contract](../workflows.md).

The core receives a validated workflow; it imports no bundled workflow.
Capabilities are the only authored work units. The OpenCode adapter loads
project YAML or the bundled default and injects it into the controller.

The adapter observes initial messages, injects current instructions into system
and compaction hooks, enforces tool filters in before-tool hooks, captures native
command exit metadata after execution, and dispatches synthetic continuations
after completed idle turns. Synthetic IDs and native child sessions cannot
admit recursive projects. Error/cancel events pause the durable run.

Jev transport and request accounting remain separate from workflow persistence.
All model reasoning and normal tool execution remain the host's responsibility.
