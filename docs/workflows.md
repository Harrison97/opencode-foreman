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
        synopsis: {type: string, minLength: 1}
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

| Field | Meaning |
|---|---|
| purpose | Short description supplied to Jev for selection. |
| instructions | Agent instructions, inline or `{file: prompts/draft.md}`. |
| completion | Prose criteria for the agent; use gates for mechanical checks. |
| model | Optional OpenCode `provider/model`; defaults to selected host model. |
| outputs | JSON Schema for a ready report's `data`, inline or `{file: schemas/output.json}`. |
| append | Output array fields merged with existing values instead of replaced. |
| dependsOn | Capabilities that must have completed successfully before selection. |
| next | Allowed capability IDs by `ready`, `incomplete`, and `blocked` outcome. |
| tools.allow / tools.deny | Exact native/MCP tool names; deny takes precedence. |
| tools.declaredChecksOnly | Restricts bash/shell to exact commands in this capability's checks gate. |
| gate.files | Required existing project files, constrained to project directory. |
| gate.checks | Shared-data key holding a nonempty array of command strings. |
| gate.coverage | Shared-data key holding labels that must appear exactly in `covered`; requires a checks gate. |
| terminal | Delivery-only capability; cannot have outputs, gates, or outgoing transitions. |

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
- Conflicting shared output types, invalid append fields, and a capability
  requiring an output that its own gate prohibits it from changing.
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
partial outputs. Accepted output keys update shared data; configured `append`
array fields retain prior values.

An evidence-gated capability cannot edit the shared command/coverage fields it
is checking. Exact commands must execute through native bash/shell in the
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
