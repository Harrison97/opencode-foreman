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
an in-progress contract. State version 3 uses an explicit phase union: working,
reported, deciding, dispatching, delivering, paused, complete, or bypassed.
Supported version-2 state migrates with an original backup; unsupported legacy
state fails explicitly without being overwritten. Explicit `foreman:` admission excludes bypass from Jev’s choices;
automatic admission is decided using the workflow's own admission instructions.

Jev only receives eligible choices from the configured outcome transitions and
dependency graph. The highest-probability legal option wins without a confidence
cutoff. Transient failures retry five times before pausing; authentication errors
pause immediately. Pending decisions survive reload and resume without repeating
accepted work. Ready reports are validated atomically; passing evidence is reused
when merely correcting a report. Failed checks permit configured backward
transitions. Revisiting a capability invalidates its completion and dependent
completions. Evidence is bound to a capability visit and data revision.

Validation includes Jev transport/accounting tests, generic state, graph, report,
evidence, pause, and adapter tests. Live smoke tests exercise the bundled YAML
and a non-software workflow through the same host adapter.

The transition function takes saved state, an event, and timestamps/message IDs.
It returns updated state, or the original state when an event is stale or irrelevant.
The controller saves changes in a short transaction, then calls Jev if a decision
is pending. Delivery and notifications remain the host adapter’s responsibility. Jev
requests execute outside locks with cancellation and version checks; process
leases prevent concurrent decision/dispatch ownership. Accepted output merging
and gate validation precede atomic report publication.

Workflow compilation caches validation and resolved output references by content
hash. The checker and runtime share dependency eligibility and invalidation
functions. Outputs have one source of truth: the producing capability’s snapshot.
Routing projections are bounded and mark omissions rather than duplicating whole
reports; full artifacts remain in state.

The host adapter replays persisted unsent prompts and reconciles saved IDs
against OpenCode history. Terminal selection is not completion: only a matching
successful final response completes the run. Interrupted accepted responses pause
until a real user reply resumes the conversation, avoiding blind repetition of
tool execution. The optional chat message `foreman resume` retries without new
guidance or attaches the latest paused workflow to a new session in the same project.
