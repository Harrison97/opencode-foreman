# Foreman

Define how your OpenCode agent works using portable YAML workflows.

A workflow is a collection of **capabilities**. Each capability defines its
instructions, model, outputs, dependencies, legal next choices, and optional
runtime gates. Jev selects the next eligible capability; OpenCode does the work
with its normal agent/tool loop. There is no separate stage or capability-kind
layer, and no software-specific behavior in the core.

## Install

Requires Node.js 22+ and an installed OpenCode. This adapter is tested with
OpenCode 1.18.31 and uses plugin SDK 1.18.30.

```sh
npm ci
npm run check
npm run install:local
```

Restart OpenCode. Installation writes an import shim to
`~/.config/opencode/plugins/jev-supervisor.js` (honoring `XDG_CONFIG_HOME`).
It points at this checkout's compiled output. Remove that shim to uninstall.
Model credentials stay in OpenCode. Jev uses `JEV_API_KEY`, falling back to
`TYPESAFE_API_KEY`; neither is written to workflow configuration.

## Use

Without project configuration, Foreman loads the bundled
[software-engineer workflow](src/workflows/software-engineer/workflow.yaml):
clarify, plan, build, review, deliver. These names and behaviors exist only in
YAML. Jev can enter appropriate capabilities and route repairs backward.

Ask for work normally. The workflow's admission instructions tell Jev when to
bypass supervision. Prefix a request with `foreman:` to explicitly opt in:

```text
foreman: Build a local issue tracker with persistent storage, tests, and setup instructions.
```

- `foreman bypass: ...` uses normal OpenCode and detaches supervision.
- `foreman resume` attaches the latest unfinished run to the current session.
- `stop`, `pause`, or `cancel` pauses an active run.
- Reply normally to answer a question and resume.
- `jev_status` shows the current capability, data, history, evidence, and models.

The historical `jev:`, `jev bypass:`, and `jev resume` prefixes also work.

## Define a workflow

Put a complete workflow in `jev.workflow.yaml` at the project directory where
OpenCode starts. To customize the default:

```sh
cp /path/to/foreman/src/workflows/software-engineer/workflow.yaml ./jev.workflow.yaml
```

Or reference a workflow from another local or cloned repository:

```yaml
source: ../my-workflows/editorial/foreman.yaml
```

Use local capability-library imports and Markdown/JSON asset files to organize a
package. See [the configuration guide](docs/workflows.md).

Validate a definition without running a model:

```sh
npm run workflow:check -- /path/to/jev.workflow.yaml
```

There are no fixed capability names, report fields, admission categories,
recovery labels, or required software-engineering steps. Set `model:
provider/model` on any capability to override the user's selected OpenCode
model. All capabilities share the host conversation.

## Runtime guarantees and boundaries

Foreman validates workflow schemas and references, filters unmet dependencies,
enforces configured tool-name lists, validates declared JSON outputs, checks
required project files, and gates on fresh native exit codes and exact coverage
labels when configured. Jev can choose only eligible transitions.

Ready reports are atomic. Correcting a rejected coverage report does not rerun
fresh checks. Failed work follows the workflow's incomplete/blocked transitions.
Low confidence uses a configured eligible fallback; otherwise the run pauses.
Three consecutive repeats or the work-unit limit pause for guidance.

Human pause and completion are runtime statuses, not mandatory capabilities.
The workflow chooses which capability delivers its final response.

State lives in private atomic `.jev/foreman-state.json` files. Each run pins
the fully resolved workflow in its state, so editing configuration affects new
runs, not a running contract. Evidence is bound to a capability visit and state
revision. Re-entering a capability invalidates its completion and dependent
completions.

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

The private `.jev/usage.jsonl` ledger records each real Jev request, model,
status, and returned input/output tokens. Pending and unknown usage remain
visible. Coding-model usage remains in OpenCode transcripts. No prices are
assumed.

Environment options:

- `JEV_DISABLED=1`: disable the plugin.
- `JEV_MODEL`: Jev model, default `jev-latest`.
- `JEV_CONFIDENCE_THRESHOLD`: default 0.75.
- `JEV_MAX_TURNS`: automatic work-unit limit, default 40; not a spending limit.

## Version 0.3 migration

The old `jev.workflow.json` configured only models. It is rejected with an
explicit migration message; convert to a full YAML workflow and put model
overrides on capabilities. If both files exist, YAML takes precedence.

Old `.jev/state.json` files are preserved. Version 0.3
starts separate version-2 state rather than silently interpreting old
software-specific state as an arbitrary workflow. Resume old work with 0.2.1,
or start a new Foreman run using the existing project files.

## Development and tests

```sh
npm run check
npm run build
npm run smoke:jev
npm run smoke:opencode
```

Unit tests use deterministic external-service mocks. The OpenCode smoke test
uses real models and Jev in disposable projects: a non-software workflow with
an injected one-time failure, the default software workflow, and human
pause/resume across a host restart. It consumes provider resources; set
`JEV_SMOKE_MODEL` to an available model if needed. Results and redacted
transcripts are retained under the printed temporary directory and `artifacts/`.

Core modules live under `src/core`; Jev transport/accounting under `src/jev`;
the host adapter under `src/opencode`; the default workflow under
`src/workflows/software-engineer`.

A configurable workflow does not itself guarantee better quality or lower cost.
