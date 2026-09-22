# Workflow configuration

Foreman loads `jev.workflow.yaml`. YAML is a serialization format; the contents
must follow Foreman's versioned schema. Arbitrary YAML from other workflow
products is not automatically compatible.

## One layer: capabilities

```yaml
version: 1
name: my-workflow
admission:
  instructions: Use draft for substantial writing. BYPASS questions or small edits.
  entries: [draft]
capabilities:
  draft:
    purpose: Produce the requested draft.
    instructions: Write DRAFT.md and record a concise synopsis.
    completion: The draft and synopsis exist.
    outputs:
      type: object
      additionalProperties: false
      required: [synopsis]
      properties:
        synopsis: { type: string, minLength: 1 }
    gate:
      files: [DRAFT.md]
    next:
      ready: [deliver]
      incomplete: [draft]
      blocked: [draft]
  deliver:
    purpose: Deliver the draft.
    instructions: Summarize the draft and link DRAFT.md.
    completion: The user has the result.
    dependsOn: [draft]
    terminal: true
```

Names may use letters, digits, underscores, and hyphens and must start with a
letter. Names have no special meaning. There is no `kind`, `stage`, or second
capability registry.

## Capability fields

| Field                    | Meaning                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| purpose                  | Short description supplied to Jev for selection.                                                                 |
| instructions             | Agent instructions, inline or `{file: prompts/draft.md}`.                                                        |
| completion               | Prose criteria for the agent; use gates for mechanical checks.                                                   |
| model                    | Optional OpenCode `provider/model`; defaults to selected host model.                                             |
| outputs                  | JSON Schema for a ready report's `data`, inline or `{file: schemas/output.json}`.                                |
| append                   | Output array fields unioned with this producer’s previous values before validation.                              |
| dependsOn                | Capabilities that must have completed successfully before selection.                                             |
| next                     | Allowed capability IDs by `ready`, `incomplete`, and `blocked` outcome.                                          |
| tools.allow / tools.deny | Exact native/MCP tool names; deny takes precedence.                                                              |
| tools.declaredChecksOnly | Restricts bash/shell to exact commands in this capability's checks gate.                                         |
| gate.files               | Fixed project-relative paths or a `capability.output` reference to an artifact-path array.                       |
| gate.commands            | Required `capability.output` reference to a nonempty array of command strings, e.g. `build.commands`.            |
| gate.acceptance          | Required `capability.output` reference to labels that must appear exactly in `covered`, e.g. `build.acceptance`. |
| terminal                 | Delivery-only capability; cannot have outputs, gates, or outgoing transitions.                                   |

Dependency edges must be acyclic. Transition edges may cycle for iterative work.
Every capability must be reachable from admission and have a path to a terminal
capability. The checker also explores completion prerequisites and output
availability across admission paths and repair loops. Outcomes with no eligible
next capability pause at runtime and produce a checker warning.

## Check a workflow

```sh
npm run workflow:check -- /path/to/jev.workflow.yaml
```

Loading a workflow runs the same structural and semantic error checks. The CLI
also prints warnings with field paths and suggested corrections. Errors exit
nonzero; warnings do not prevent loading. Checks include:

- Missing dependencies/transitions, dependency cycles, unreachable capabilities,
  and dependency deadlocks.
- Missing gate output fields, incompatible string-array types, and required
  output availability on every explored entry path. Declare consumed fields in
  the producer's top-level `outputs.properties` and `outputs.required`.
- Invalid append fields, self references in command/acceptance gates, and
  references whose producer does not remain completed. Output names are scoped
  to their producer; different capabilities may use the same name with different types.
- Command restrictions without a checks source, or command gates without an
  allowed shell tool.
- Warnings for allow/deny overlaps, exempt control tools, empty-array contracts,
  and outcomes that can pause because no transition is eligible.

Optional host inventory checks use an already running OpenCode server:

```sh
npm run workflow:check -- /path/to/jev.workflow.yaml --host http://127.0.0.1:4096
```

This makes read-only requests to `/provider` and `/experimental/tool/ids`, using
the current working directory as the OpenCode project context. It warns about
models not advertised by connected providers and tools absent from that host's
inventory. It does not run models, test credentials, or guarantee tool access;
MCP/dynamic tools may not appear in that inventory. Inventory failures exit
nonzero. This CLI currently supports servers without HTTP authentication only.

Static analysis is bounded to 20,000 distinct completion/output states; larger
graphs warn that full reachability was not proven. Output analysis understands
top-level properties, required fields, and explicit types; advanced JSON Schema
constructs still validate at runtime but are not a general schema-subtyping
proof. Missing guarantees must be made explicit in the output contract. File
existence, actual command results, permissions, and instruction quality cannot
be proven by checking YAML. No safety claim is made about allowed commands.

The core implements only these generic mechanisms. Domain rules such as “write
a design,” “test persistence,” or “ask about audience” belong in the workflow.

## Outputs and evidence

`jev_report` accepts `summary`, `outcome`, optional `data`, `covered`, and
`questions`. The `data` object has no built-in domain fields. Ready reports
must satisfy the capability's JSON Schema and gates before anything is stored.
Incomplete/blocked reports describe findings in the summary without publishing
partial outputs. Accepted outputs live only in `capabilityOutputs[producer]`.
Configured `append` arrays union their own previous values by JSON-value equality.
The resulting snapshot must satisfy the schema, including `maxItems` and
`uniqueItems`, and its artifact paths must pass file gates before it is stored.

Gate references must identify their producer explicitly:

```yaml
gate:
  commands: build.commands
  acceptance: build.acceptance
```

Bare names such as `commands`, missing producers/outputs, self references in command/acceptance gates, and paths
that skip or invalidate the named producer are rejected. References select a
top-level output property, not a nested JSON path. Capability names start with a
letter; output reference names start with a letter or underscore. Both may
contain letters, digits, underscores, and hyphens.

Accepted reports save a per-capability output snapshot. Gates read the
named producer's snapshot, never the last writer of a shared-data key. A producer
must still be completed; invalidation makes its old snapshot ineligible. A new
ready report replaces that producer's snapshot, including removing omitted
optional fields. Appended fields store the merged values. Agent context includes producer
snapshots. To carry criteria between capabilities, instruct the consumer to
include the earlier producer’s values explicitly in its own report.

For variable artifact names, a producing capability can check its own submitted
paths before its ready report is accepted:

```yaml
plan:
  # purpose, instructions, completion, and next omitted here
  outputs:
    type: object
    required: [artifacts]
    properties:
      artifacts:
        type: array
        minItems: 1
        items: { type: string, minLength: 1 }
  gate:
    files: plan.artifacts
```

One visit can report `designs/authentication.md`, another `designs/billing.md`.
Paths are relative to the project directory where OpenCode starts; absolute
paths and symlinks escaping the project are rejected. Subsequent capabilities
can also use `files: plan.artifacts`, reading the completed producer's snapshot.
Only file gates support checking the current capability's submitted outputs.
The default SWE plan uses this pattern instead of overwriting `DESIGN.md`.
File gates check existence, not content quality or whether a file is newly created.

`acceptance` is an LLM checklist: every referenced label must be included in the
report's `covered` array. It does not require a commands gate and does not prove
the checklist claims are true. The old gate keys `checks` and `coverage` are
rejected; use `commands` and `acceptance` respectively.

Schema-2 snapshots with producer outputs and a currently valid workflow migrate
to schema 3 with a private backup. Older snapshots without provenance cannot be
reconstructed safely: preserve the original outside `.jev/foreman-state.json`
and start a new workflow from the existing files. `gate.files` accepts a fixed path list or a qualified reference to an artifact-path array.

An evidence-gated capability cannot edit the other producer’s saved command or
coverage contract through its report. Exact commands must execute through native bash/shell in the
project root and finish with exit code zero. The latest result takes precedence.
Evidence from an older visit or revision cannot satisfy the gate. Commands
themselves are trusted workflow/project code, not guaranteed read-only.

For tool permissions, `jev_status` is always available. `jev_report` is available
only while running and before a report is accepted. Other tools follow the
capability's allow/deny rules. After an accepted report, only status inspection
is allowed until the next capability.

## Admission, pause, and completion

Normal requests go to Jev with the workflow's eligible entries plus BYPASS.
The highest-probability legal option wins without a confidence cutoff. Explicit
`foreman:` requests exclude BYPASS. Ties retain Jev's reported choice when it is
tied for highest probability; otherwise declaration order breaks the tie.
API failure during admission pauses instead of silently choosing BYPASS or an
entry. There are no fallback fields.

Transient failures and malformed responses retry five times after the initial
attempt. Missing/rejected credentials and permanent HTTP errors pause immediately.
Retry notices and pause reasons appear in OpenCode; the first successful request
shows a connection notification. `foreman resume` retries the pending admission
or transition, retaining an accepted report and its evidence. Each attempt is
accounted separately. See README for backoff and server-delay limits.

Questions in a blocked/incomplete report pause the current capability until a
real human response. Host errors, explicit stop, exhausted work units, and
unresolved decisions also pause. Resume increments the visit/revision and
invalidates current/dependent completion records. No named human-input
capability is required.

Jev chooses among configured eligible transitions. If the only next option is
terminal delivery after a validated ready report, Foreman completes
deterministically. Completion does not always imply tests: it means the gates
the workflow author configured were satisfied.

## Workflow packages and dependencies

A project may reference a cloned workflow repo:

```yaml
source: ../team-workflows/release/foreman.yaml
```

The package file can import reusable capability definitions:

```yaml
version: 1
name: release
imports: [capabilities/review.yaml]
admission: # ...
capabilities: # additional definitions ...
```

Each imported YAML contains `capabilities` and optionally `imports`. Duplicate
names and cyclic imports are rejected. All import, Markdown instruction, and
JSON schema paths resolve relative to the main package file's directory;
escaping paths and symlinks are rejected. The project's `source` is allowed
to point to a different local repository.

This version supports local package imports and capability prerequisites.
It does not download Git repositories, install tools/MCP servers, or install
remote dependency packages. Clone/pin those repositories yourself. Workflow
authors may use tool names already supplied by the OpenCode environment.

New runs persist their complete resolved definition and SHA-256 hash. Existing
runs retain that snapshot even if the source files change. Restart OpenCode to
load new configuration for subsequent runs.

## Implementation references

The adapter uses [OpenCode plugin hooks](https://opencode.ai/docs/plugins/).
The loader uses [YAML's document parser](https://eemeli.org/yaml/) with duplicate
key checking and bounded aliases; output validation uses JSON Schema.
