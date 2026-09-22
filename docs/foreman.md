# Foreman, the default engineering workflow

[The default YAML](../src/workflows/software-engineer/workflow.yaml) defines
Foreman's personality and process. Its engineering process lives in YAML. The runtime work-unit cap is opt-in.
Projects without `foreman.workflow.yaml` load this default. To customize it, copy
that file into the project as `foreman.workflow.yaml` and restart OpenCode. Existing
campaigns retain their pinned definition; a source update does not rewrite them.

Start with an idea, for example:

> foreman: Build a local issue tracker for my team. Help me work out what it
> should do before building it. Make routine engineering decisions yourself.

Foreman interviews for substantial ambiguous work. It investigates facts itself,
asks focused product questions, saves a brief, and records the basis for proceeding.
A complete supplied specification with prior authorization needs reconciliation,
not a repeated approval ceremony. Trivial requests can bypass the workflow.

## Interview rounds

The interview keeps a small decision map in `.foreman/brief.md`. Questions follow
settled prerequisites, with recommendations and tradeoffs, usually 2-4 at a time.
Foreman researches discoverable facts itself and owns delegated engineering choices.
It revisits dependent questions after each answer and presents a concrete product
summary before proceeding, honoring existing confirmation and authority.

This approach draws on [Matt Pocock's grilling skill](https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md).
Foreman adapts it to bounded rounds and persistent pause/resume; it does not require
exhausting every possible design question or renewing authorization already given.

## How work moves

The capability graph is:

```text
interview → design → plan → build → review → checkpoint → plan
                ↑         ↓       ↓
                └── local redesign / investigation / repair

plan → release → verify → deliver
```

`investigate` can resolve uncertainty before returning to the affected scope.
These are legal paths, not a fixed pipeline. Jev sees eligible choices, reports,
recent evidence and output summaries. Put the affected scope, cause, evidence,
remaining limits and next action in reports; the runtime does not read every
campaign file into Jev's routing context. Transition history records the choice
and probabilities; reports/progress retain the supplied reasons. This is not
Jev's private reasoning or a complete audit of every document it considered.

`build` handles one bounded box. `review` runs its declared commands freshly.
`checkpoint` records verified progress. `plan` selects the next ready work or
prepares final acceptance. `verify` checks the whole product before delivery.
The workflow instructs the agent to return for repair, investigation or local
redesign when needed. Only `verify` can reach terminal delivery.

## Capability handoffs and report recovery

Each continuation includes the current capability assignment and resolved gate inputs.
`foreman_status` returns the current assignment without the full workflow and command-output
history; pass `producer` to retrieve a particular capability's saved outputs. A capability
without an output schema still requires a report, with `data` omitted.

A response without an accepted report retries the same capability up to three times,
preserving its fresh evidence. It does not ask Jev to treat a missing report as an
`incomplete` work outcome. Exhaustion produces a persistent pause; a user reply resumes
that capability. Explicit accepted `incomplete` reports still follow the workflow's
repair transitions.

## Parent and product acceptance

Planning preserves user journeys from the original brief/design through decomposition:
starting conditions, public entry points, actions, expected results, implementation
owners and integration check owners. Verified children make a parent ready for
integration review; they do not automatically verify the parent. Stage and product
integration boxes must demonstrate their own journeys, including connections between
components and stages. Before implementation begins, every promised journey needs
an owner and a planned behavioral check, even when later work remains coarsely scoped.

Review gathers discoverable coverage gaps across its assigned scope into one repair
handoff, distinguishing defects from missing evidence. Repairs preserve promised
interactions: deleting or disabling a promised action requires an authorized scope
change, rather than counting as a successful fix. This aims to reduce avoidable
review loops without claiming every defect can be found in one pass.

Review and final verification derive expected scenarios before reading the existing
test coverage. UI journeys require real browser interaction and page reload evidence;
DOM-only tests, screenshots or a command named `test:browser` are insufficient substitutes.
Missing checks route back for implementation through the existing graph. Verification
keeps its read-only and declared-command restrictions: it requests a better check contract
rather than weakening its approval standard. These are workflow instructions; the runtime
still cannot prove that a check establishes a meaningful user outcome.

## Durable artifacts

The agent maintains these under the existing private `.foreman/` directory:

- `brief.md`: users, scenarios, boundaries, requirements, assumptions,
  decisions, observable acceptance and basis for proceeding.
- `designs/` and `contracts.md`: architecture, alternatives,
  failure/recovery behavior, explicit interfaces and impact analysis.
- `investigations.md`: questions, evidence, conclusions and uncertainty.
- `campaign.json`: stages, nested work, leaf boxes, dependencies,
  ownership, status, blockers, attempts, limits and evidence references.
- `checkpoint.md`: current assignment, next actions and interruption
  reconciliation, including receipts for external side effects when applicable.
- `acceptance.md`: original product criteria mapped to final checks.
- `scripts/` and `evidence/`: campaign-only validators, probes, acceptance journeys
  and their results; these do not belong in the product source folders.

The runtime separately maintains `.foreman/foreman-state.json`, its pinned workflow,
producer outputs, transition history and native command evidence. Agents must
not edit that state file. `.foreman/` is ignored by Git; deliberately copy selected
product/design documents elsewhere if the team wants versioned documentation.
Do not put credentials in any artifact.

The default denies the native `question` tool using existing YAML tool rules.
Human questions go through `foreman_report`, so Foreman records a durable pause rather
than leaving a native question pending while its own state says working.

Normal replies resume a paused conversation. To attach a saved paused campaign
to a fresh OpenCode conversation in the same project, send `foreman resume`.
The existing runtime resumes the most recently updated paused campaign; it does
not automatically attach arbitrary new conversations. The workflow tells the
agent to reconcile files and external receipts before replaying interrupted work.
That instruction cannot guarantee exactly-once external side effects.

## What is enforced, and what is instruction

| Behavior                                                                                     | Enforcement in this version                                                                                      |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Interview brief exists, ready output has empty blocking-question list and a proceeding basis | File gate and output schema; meaning and user agreement still require honest agent judgment                      |
| Capability dependencies and legal transitions                                                | Runtime and workflow checker                                                                                     |
| Box and final command evidence                                                               | Exact declared commands, native exit codes, current visit/revision, root working directory                       |
| Acceptance coverage                                                                          | Exact labels required in `covered`; runtime cannot prove semantic coverage                                       |
| Campaign task graph, recursive decomposition, ownership and stale-result propagation         | Agent-maintained artifacts and project-local checks; not a runtime scheduler                                     |
| Parent integration, useful tests, browser behavior and visual quality                        | Workflow instructions and checks the agent supplies; a successful command alone does not prove these             |
| Branch-specific blockers                                                                     | Ledger instructions; independent work should finish before asking a global question                              |
| Human input                                                                                  | Any report with questions pauses the entire workflow; no simultaneous background branch scheduling               |
| Native parallel workers                                                                      | Only when available and authorized; agent-managed, default serial; no new worker pool or filesystem isolation    |
| Model routing                                                                                | Existing `model: provider/model` per capability; inherited host model otherwise                                  |
| Named model roles, automatic difficulty escalation/fallback                                  | Not implemented; capability transitions can route to configured stronger models, provider failures pause         |
| Attempts, repair/time and financial limits in campaign.json                                  | Agent-observed policy, not independently enforced budgets                                                        |
| Automatic work-unit limit and repeated identical-capability transitions                      | Existing runtime pause guards; work units unlimited by default; optional `FOREMAN_MAX_TURNS` cap, repeat guard 3 |
| Final stop                                                                                   | Runtime delivers once and marks complete after validated final verification                                      |

The work-unit limit counts capability turns, not native tool calls, elapsed time,
tokens or dollars. It is unlimited by default. Set `FOREMAN_MAX_TURNS` to a positive
integer to opt into a cap, or `unlimited` to explicitly disable it. An existing
limit pause requires a reply to resume after restarting OpenCode. Other pause
conditions, including repeated failures and human questions, still apply.
The default policy asks the agent to record 3 attempts per box, 2 unchanged-failure
repair cycles, 20 minutes per box and a 120-minute autonomous tranche. It must
preserve counters across replanning and ask before renewing exhausted limits.
Existing user limits take precedence. There is no invented default dollar cap;
an explicit no-spend-limit instruction remains valid. Unknown usage is unknown,
not zero. Hard budgets would require runtime support and are not claimed here.

A campaign's `nextAction` guides Jev; it is not a dynamic eligibility predicate.
The release output requires `allRequiredWorkVerified: true`, but this is an
attestation, not a runtime traversal of the task graph. The workflow calls for
project-local DAG and completion checks; their correctness is still agent-dependent.
Likewise, a file gate proves existence, not the quality of a design or interview.

## Configure model routing

Edit capability model fields in your project copy. For example, `design.model`
and `review.model` can point to your configured stronger model while `build.model`
points to your implementation model. Omit `model` to inherit OpenCode's selected
model. The default hardcodes no provider or model.

You can use YAML anchors to avoid repeating model identifiers, using actual
provider/model strings from your host:

```yaml
# Within their existing capability definitions:
design:
  model: &planning_model provider/your-planning-model
  # retain the other design fields
investigate:
  model: *planning_model
  # retain the other investigate fields
build:
  model: provider/your-implementation-model
  # retain the other build fields
```

This is YAML reuse, not runtime model-role resolution. There is no supported
`roles`, `budget`, `scheduler` or dynamic task-model field to add at the top level.
An unavailable configured model does not silently fall back. Correct configuration
and resume after the host reports the error. All capabilities normally share the
OpenCode conversation, even if the model changes.

## Validation

```sh
npm run workflow:check -- src/workflows/software-engineer/workflow.yaml
npm run check
npm run build
npm run smoke:opencode
FOREMAN_SMOKE_SCENARIO=default npm run smoke:opencode
FOREMAN_SMOKE_SCENARIO=interview npm run smoke:opencode
```

`tests/core/foreman.test.ts` drives the real default YAML through the controller
with a deterministic chooser: interview output gates, human pause/resume, deeper
design, failed checks and repair, branch-deferral versus global pause, work-unit
exhaustion, cross-session reconstruction, final evidence and terminal stop.
These are runtime/contract tests, not proof that a model follows every instruction.
The OpenCode smoke script exercises actual models and Jev in disposable projects;
it covers generic repair/restart behavior and a specified small project using the
default. The interview scenario checks that a vague idea pauses with product
questions and a substantive saved brief, without reaching implementation. Its
artifacts are local and ignored by Git.

True enforced task scheduling, independent branch pauses, named model roles and
hard time/cost limits would need general runtime extensions. They are deliberately
not added as part of this YAML-only implementation.
