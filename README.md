# Foreman

Define how your OpenCode agent works using YAML workflows, with Jev choosing
what happens next.

A workflow contains **capabilities**: instructions, expected outputs, optional
models, and allowed transitions. OpenCode performs the work with its normal tools.
Foreman persists progress, checks configured gates, and starts the next capability.
A review can return work for repair or investigation instead of following a fixed pipeline.

## What you can use it for

- **Build a project from an idea.** Use the default engineering workflow to clarify
  requirements, plan manageable work, implement, verify, and repair failures.
- **Define your own process.** Create capabilities for research, writing, review,
  or another task, with the outputs and transitions you want.
- **Use different models for different work.** Assign models per capability—for
  example, architecture and implementation—without manually switching at each step.
- **Continue work across sessions.** Keep decisions, outputs, and progress on disk,
  with human questions and recovery recorded as resumable pauses.

## Install

Requires Node.js 22.13+ on 22.x or 24+, an installed OpenCode, and `TYPESAFE_API_KEY`
in its environment. Keep keys out of YAML.
The adapter is tested with OpenCode 1.18.31 using plugin SDK 1.18.30.

From the directory where you want to keep Foreman, run:

```sh
git clone https://github.com/Harrison97/opencode-foreman.git && (cd opencode-foreman && npm ci && npm run install:local)
```

Already cloned it? Run `npm ci && npm run install:local` inside the checkout.
The install command builds the plugin and registers it with OpenCode, including
its terminal trace UI. Keep the checkout in place: the installation points to its
compiled files. Restart OpenCode after installation.

Make `TYPESAFE_API_KEY` available to the shell or launcher that starts OpenCode. Configure
your coding model in OpenCode as usual; Foreman uses those existing credentials.
See [UI compatibility](docs/sidebar.md) and [operations](docs/operations.md) for
configuration, disabling, and recovery.

## Start a project

Open OpenCode in the project you want to work on:

```sh
mkdir my-project && cd my-project && opencode
```

Ask normally:

> Build a local issue tracker with persistent storage, issue creation and editing,
> status and priority filters, and a polished interface. Make routine engineering
> decisions yourself.

Without project configuration, the [default Foreman workflow](docs/foreman.md)
handles substantial engineering work: clarify the product, design, plan bounded
work, implement, review, and verify the finished result. Small requests can bypass
supervision. No YAML file is needed to use the default. Answer its product questions,
then let it continue. You do not need to prompt each step. A **Jev connected** notice
confirms the first successful routing request; the trace shows capability transitions.

In OpenCode chat:

- `foreman: ...` explicitly enters the workflow.
- `foreman bypass: ...` uses normal OpenCode and detaches supervision.
- `stop`, `pause`, or `cancel` pauses a run; a normal reply resumes it.
- `foreman resume` can attach the latest paused run to a new conversation.
- `/foreman-trace` opens the capability history in the terminal UI.

These are chat messages/UI commands, not shell commands. The agent uses
`foreman_status` to inspect its assignment and `foreman_report` to report outcomes.

## Make your own workflow

Foreman supports one project configuration: **`foreman.workflow.yaml`**, in the
directory where OpenCode starts. There is no home-directory workflow discovery.
Copy the default to customize it, or write your own:

```sh
cp /path/to/foreman/src/workflows/software-engineer/workflow.yaml ./foreman.workflow.yaml
```

A minimal complete workflow:

```yaml
version: 1
name: Writing assistant
admission:
  instructions: Use this workflow for substantial writing projects; bypass unrelated requests.
  entries: [draft]
capabilities:
  draft:
    purpose: Produce the requested document.
    instructions: Write DRAFT.md using the user's requirements.
    completion: The document addresses the requested scope.
    gate:
      files: [DRAFT.md]
    next:
      ready: [deliver]
      incomplete: [draft]
      blocked: [draft]
  deliver:
    purpose: Deliver the document.
    instructions: Summarize the result and link DRAFT.md.
    completion: The user has the result.
    dependsOn: [draft]
    terminal: true
```

Set `model: provider/model` on a capability to route it to a configured OpenCode
model; omit it to inherit the selected model. Capabilities share the conversation.
The example's file gate checks existence, not writing quality.

**[YAML configuration guide →](docs/workflows.md)** includes field definitions,
output schemas, verification gates, repair loops, tool rules, and reusable packages.

Validate from the Foreman checkout without calling a model:

```sh
npm run workflow:check -- /path/to/foreman.workflow.yaml
```

Restart OpenCode after editing configuration. New runs use the new definition;
existing campaigns retain their saved workflow. State and Jev usage live in
`.foreman/`. Never put credentials there.

## What Foreman guarantees

The runtime checks output schemas, file gates, permitted transitions, dependencies,
tool-name restrictions, and fresh command evidence where configured. It does not
prove that tests cover the intended behavior. Campaign planning and meaningful
acceptance checks still depend on the agent and workflow instructions.

The runtime work-unit cap is unlimited by default; `FOREMAN_MAX_TURNS` opts into
a cap. The default engineering workflow also instructs the agent to observe
[per-box recovery and time limits](docs/foreman.md). Set `FOREMAN_DISABLED=1` to
disable Foreman. No default dollar budget is imposed.

Jev chooses the highest-ranked legal option. Transient routing failures retry,
then pause visibly; credentials errors pause immediately. Usage is available with
`npm run usage:jev -- /path/to/project`. Coding-model usage stays in OpenCode.
A workflow does not itself guarantee better quality or lower cost.

## More documentation

- [YAML configuration](docs/workflows.md)
- [Default engineering workflow and its limits](docs/foreman.md)
- [Terminal capability trace](docs/sidebar.md)
- [Operations, usage, recovery, and migration](docs/operations.md)
- [Development, testing, and repository layout](docs/development.md)
- [Architecture](docs/architecture/overview.md)
