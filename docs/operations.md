# Operations and recovery

Foreman validates workflow schemas and references, filters unmet dependencies,
enforces configured tool-name lists, validates declared JSON outputs, checks
required project files, and gates on fresh native exit codes and exact coverage
labels when configured. Jev can choose only eligible transitions.

Ready reports validate the final merged output and artifact paths before committing.
Append fields use JSON-value uniqueness within their own producer snapshot.
There is no shared, last-writer-wins output object. Ready reports are atomic. Correcting a rejected coverage report does not rerun
fresh checks. Failed work follows the workflow's incomplete/blocked transitions.
Jev's highest-ranked legal choice is accepted regardless of its score. Scores
and distributions are recorded for inspection, not used as a confidence cutoff.
Transient request failures retry up to five times, then pause visibly.
Three consecutive repeats or the work-unit limit pause for guidance.

Human pause and completion are runtime statuses, not mandatory capabilities.
The workflow chooses which capability delivers its final response. A run becomes
complete only after OpenCode records a successful response to that delivery.
Dispatch failures pause visibly and preserve the pending work.

Foreman reads only `foreman.workflow.yaml` and `.foreman/`; old Jev-named config,
state directories, tool names, command prefixes and plugin settings are not supported.
Existing projects are not automatically moved or rewritten.

State lives in private atomic `.foreman/foreman-state.json` files. Each run pins
the fully resolved workflow in its state, so editing configuration affects new
runs, not a running contract. Evidence is bound to a capability visit and state
revision. Re-entering a capability invalidates its completion and dependent
completions. Persisted decisions and undelivered prompts recover on host startup;
saved message IDs reconcile prompts already received by OpenCode. An accepted
prompt with an interrupted response may pause until you reply in that conversation
or send `foreman resume`; Foreman does not blindly repeat tools. New guidance invalidates accepted work before reconsideration.

Jev requests run outside state locks and can be cancelled. Versioned decisions
discard late results. Routing uses a bounded, explicitly truncated projection of
state; full outputs remain durable and available to the working agent.

Tool restrictions are host-level controls, not an OS sandbox. A permitted shell
command or MCP tool can modify files. A passing check proves only what that
command tests; coverage labels remain agent attestations. Foreman does not
guarantee semantic correctness or detect arbitrary external filesystem changes.
Native child sessions are not independently supervised.

## Usage and configuration

```sh
npm run usage:jev -- /path/to/project
npm run usage:jev -- /path/to/project SESSION_ID
```

The private `.foreman/usage.jsonl` ledger records each real Jev request, model,
status, and returned input/output tokens. Pending and unknown usage remain
visible. Coding-model usage remains in OpenCode transcripts. No prices are
assumed.

Environment options:

- `FOREMAN_DISABLED=1`: disable the plugin.
- `JEV_MODEL`: Jev model, default `jev-latest`.
- `FOREMAN_MAX_TURNS`: optional positive-integer work-unit cap. Unset or `unlimited`
  means no work-unit limit (the default); not a spending limit.

## Version 0.4 migration

Current workflows no longer support `fallback` fields or a confidence threshold.
Remove admission/capability `fallback` fields from custom YAML; the checker
rejects them. Pinned snapshots containing removed fields cannot resume until migrated to the
current workflow contract; Foreman fails explicitly without overwriting them.

Network failures, timeouts, HTTP 408/429/5xx, and malformed decisions get up to
five retries after the initial attempt (six attempts total). Backoff is 1, 2,
4, 8, and 16 seconds; longer `Retry-After` delays are honored up to 30 seconds.
If the server requests a longer wait, Foreman pauses rather than retrying early.
Missing/rejected credentials and other permanent HTTP errors pause immediately.
Send `foreman resume` after resolving the issue. A pending routing decision is
retried without discarding accepted reports or rerunning their checks.

OpenCode shows retry notices, a first-success **Jev connected** toast, and the
reason when supervision pauses. API failure during admission pauses rather than
silently bypassing supervision. Every HTTP attempt has its own usage record,
linked by decision ID and attempt number; successful records include the choice,
score, and probability distribution. Unknown token usage remains unknown.

Version 0.4 stores explicit runtime phases in schema-3 state. Supported schema-2
runs with producer snapshots migrate automatically on the next write; the
original is backed up privately as `.foreman/foreman-state.v2.json`. No shared output
object is migrated. Append now preserves only that capability’s own previous
values: instructions must explicitly carry forward another producer’s criteria.

Old `.foreman/state.json` files remain untouched. Unsupported workflows or snapshots
without output provenance fail explicitly; preserve the original state file
outside `.foreman/foreman-state.json` and start a new run using existing project
files, or resume with the matching older Foreman version.
