# Generic Foreman runtime

Foreman has one workflow layer: named capabilities. A workflow defines their
instructions, output schemas, dependencies, transitions, model selections, tool
restrictions, and completion gates. The engine has no domain-specific names,
admission classifier, report fields, repair categories, or stage kinds.

`jev.workflow.yaml` is either a complete workflow or a local `source` reference
to one. The bundled software-engineer YAML uses the same parser and engine.
Workflow repositories can be cloned and referenced locally; automatic remote
download and package dependency installation are out of scope for this change.

Generic runtime primitives: validated JSON outputs, declared dependency completion,
required local files, native command evidence, coverage of stored strings,
tool allow/deny lists, finite transition budgets, human pause/resume, and terminal
delivery. Tool filters are host hooks, not an operating-system sandbox. A command
may mutate files; allowing a command is not proof it is read-only.

Each run snapshots its resolved workflow so config edits cannot silently change
an in-progress contract. State version 2 is stored separately from old version 1
state. Old state remains untouched and is not silently
interpreted as new workflows. Explicit `foreman:` admission always works;
automatic admission is decided using the workflow's own admission instructions.

Jev only receives eligible choices from the configured outcome transitions and
dependency graph. Low confidence uses an explicitly configured eligible fallback
or pauses. Ready reports are validated atomically; passing evidence is reused
when merely correcting a report. Failed checks permit configured backward
transitions. Revisiting a capability invalidates its completion and dependent
completions. Evidence is bound to a capability visit and data revision.

Validation: retain Jev transport/accounting tests; replace domain-coupled runtime
tests with generic state, graph, report, evidence, pause, and adapter tests; test
the bundled YAML and a non-software workflow through the same host adapter.
