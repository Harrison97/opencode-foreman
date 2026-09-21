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
  fallback: draft
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
    fallback: {ready: deliver, incomplete: draft, blocked: draft}
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
| fallback | Explicit eligible next choice by outcome if Jev fails or has low confidence. |
| tools.allow / tools.deny | Exact native/MCP tool names; deny takes precedence. |
| tools.declaredChecksOnly | Restricts bash/shell to exact commands in this capability's checks gate. |
| gate.files | Required existing project files, constrained to project directory. |
| gate.checks | Shared-data key holding a nonempty array of command strings. |
| gate.coverage | Shared-data key holding labels that must appear exactly in `covered`; requires a checks gate. |
| terminal | Delivery-only capability; cannot have outputs, gates, or outgoing transitions. |

Dependency edges must be acyclic. Transition edges may cycle for iterative work.
Every capability must be reachable from admission and have a path to a terminal
capability. Missing runtime outputs or unsatisfied dependencies may still leave
no eligible next capability; Foreman pauses explicitly in that case.

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
Low-confidence automatic admission bypasses supervision. Explicit `foreman:`
requests exclude BYPASS and use the admission fallback, or pause if none exists.

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
