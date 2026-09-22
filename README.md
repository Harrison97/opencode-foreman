# Foreman

Define how your OpenCode agent works using portable YAML workflows.

A workflow is a collection of **capabilities**. Each capability defines its
instructions, model, outputs, dependencies, legal next choices, and optional
runtime gates. Jev selects the next eligible capability; OpenCode does the work
with its normal agent/tool loop. There is no separate stage or capability-kind
layer, and no software-specific behavior in the core.

## Install

Requires Node.js 22.13+ (22.x) or 24+ and an installed OpenCode. This adapter is tested with
OpenCode 1.18.31 and uses plugin SDK 1.18.30.

```sh
npm ci
npm run check
npm run install:local
```

Restart OpenCode. Installation writes an import shim to
`~/.config/opencode/plugins/foreman.js` (honoring `XDG_CONFIG_HOME`).
It points at this checkout's compiled output. Remove that shim to uninstall.
Model credentials stay in OpenCode. Jev uses `JEV_API_KEY`, falling back to
`TYPESAFE_API_KEY`; neither is written to workflow configuration.

## Use

Without project configuration, Foreman loads the bundled
[Foreman engineering workflow](src/workflows/software-engineer/workflow.yaml):
interview, investigate, design, plan, build, review, checkpoint, release, verify,
deliver. These names and behaviors exist only in YAML. Jev admits substantial
work to interview and routes later work and repairs among eligible capabilities.

Ask for work normally. The workflow's admission instructions tell Jev when to
bypass supervision. Prefix a request with `foreman:` to explicitly opt in:

```text
foreman: Build a local issue tracker with persistent storage, tests, and setup instructions.
```

- `foreman bypass: ...` uses normal OpenCode and detaches supervision.
- `foreman resume` resumes this run or attaches the latest paused run to the current session.
- `stop`, `pause`, or `cancel` pauses an active run.
- Reply normally to answer a question and resume.
- `foreman_status` shows the current assignment and gate inputs; pass `producer` to read saved outputs.
- The [terminal sidebar](docs/sidebar.md) shows a persistent capability trace;
  `/foreman-trace` opens the full history. Requires OpenCode 1.18.30+ (1.x).

These prefixes are messages typed into OpenCode chat, not terminal commands.
Continuing the same conversation resumes its paused workflow; you do not need
to type `foreman resume`. Use that message to retry without adding instructions,
or to attach the latest paused workflow in a new conversation in the same project.
`foreman_status` is an agent tool, not a terminal command.

## Define a workflow

Put a complete workflow in `foreman.workflow.yaml` at the project directory where
OpenCode starts. To customize the default:

```sh
cp /path/to/foreman/src/workflows/software-engineer/workflow.yaml ./foreman.workflow.yaml
```

Or reference a workflow from another local or cloned repository:

```yaml
source: ../my-workflows/editorial/foreman.yaml
```

Use local capability-library imports and Markdown/JSON asset files to organize a
package. See [the configuration guide](docs/workflows.md).

Validate a definition without running a model:

```sh
npm run workflow:check -- /path/to/foreman.workflow.yaml
```

The checker rejects broken references, missing output contracts, incompatible
types, and dependency deadlocks. It reports warnings for ambiguous settings.
Add `--host http://127.0.0.1:4096` to compare model and tool names with a running
OpenCode server. See the configuration guide for analysis limits.

Gate output references must include the producer, for example
`commands: build.commands` and `acceptance: build.acceptance`. Bare output names are
rejected. Gates read the named capability's saved outputs, not whichever
capability last wrote a shared field. Older runs without producer snapshots
must be restarted from their existing project files; see the migration notes
in the configuration guide.

There are no fixed capability names, report fields, admission categories,
recovery labels, or required software-engineering steps. Set `model:
provider/model` on any capability to override the user's selected OpenCode
model. All capabilities share the host conversation.

## Runtime guarantees and boundaries

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

## Development and tests

```sh
npm run check
npm run build
npm run smoke:jev
npm run smoke:opencode
```

`npm ci` installs the local pre-commit hook through [Lefthook](https://lefthook.dev/usage/commands/install/).
The hook is configured in `lefthook.yml`. On each commit,
`lint-staged` formats staged TypeScript, JavaScript, JSON, Markdown, and YAML,
then runs ESLint on staged code. Fixable changes are included in the commit;
remaining lint errors block it. Partially staged files retain their unstaged edits.

```sh
npm run lint          # Check the repo with ESLint
npm run lint:fix      # Apply safe lint fixes
npm run format       # Format the repo with Prettier
npm run format:check # Check formatting without changing files
npm run check        # Lint, formatting, typecheck, and tests
```

The root `tsconfig.json` loads Node types and checks source, tests, and TypeScript
scripts. `tsconfig.build.json` emits only `src/` into `dist/`.

The hook does not run models, tests, or provider requests. Run `npm run check`
before submitting changes. ESLint checks TypeScript syntax throughout the repo
and adds type-aware promise checks for `src/`. Explicit `any` remains permitted
for existing dynamic schemas, legacy migrations, and host mocks.

Unit tests use deterministic external-service mocks, including dispatch failure,
restart reconciliation, migration, cancellation, and oversized output regressions.
Seeded property tests generate output merges, event traces, and dependency graphs. The OpenCode smoke test
uses real models and Jev in disposable projects: a non-software workflow with
an injected one-time failure, the default software workflow, and human
pause/resume across a host restart. It consumes provider resources; set
`FOREMAN_SMOKE_MODEL` to an available model if needed. Results and redacted
transcripts are retained under the printed temporary directory and `artifacts/`.

The core keeps workflow transitions (`src/core/runtime/engine.ts`) separate from the controller’s network and filesystem work,
compiles and caches validated workflow contracts, and shares graph semantics
between the runtime and checker. Persisted state has one discriminated phase
and one producer-scoped output store.

## Repository layout

```text
src/
  core/
    workflow/       YAML loading, schema, compiler, graph, and checker
    runtime/        Workflow transitions, controller, decisions, and outputs
    persistence/    Durable state store, validation, and migrations
    types.ts        Shared host-independent contracts
    models.ts       Model reference parsing
    security.ts     Credential redaction
  jev/              Jev transport and usage accounting
  opencode/         OpenCode configuration and plugin hooks
  workflows/        Bundled Foreman engineering YAML
scripts/
  build/            Clean output and copy workflow assets
  cli/              Workflow checker and usage reporting
  smoke/            Live Jev and OpenCode smoke tests
  install.mjs       Local OpenCode plugin installer
tests/
  core/             Workflow, runtime, and persistence tests
  jev/              Transport, retries, and accounting tests
  opencode/         Plugin hooks and host recovery tests
  support/          Shared fixtures
docs/
  architecture/     Runtime design and integration overview
  workflows.md      Workflow authoring contract
```

See the [architecture overview](docs/architecture/overview.md) and
[runtime design](docs/architecture/runtime.md).

A configurable workflow does not itself guarantee better quality or lower cost.

The default [Foreman workflow guide](docs/foreman.md) explains the interview,
recursive campaign planning, bounded boxes, recovery, model configuration and
the distinction between runtime gates and agent-managed campaign policies.
