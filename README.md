# Foreman

[Website](https://harrison97.github.io/opencode-foreman/) · [Documentation](docs/foreman.md)

> [!CAUTION]
> **HIGH TOKEN USAGE**
>
> Foreman can use a **lot** of tokens. Each capability, review, and repair loop adds model calls. Monitor your usage, especially on long-running workflows.

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

## Install

Requires Node.js 22.13+ on 22.x or 24+, an installed OpenCode, and `TYPESAFE_API_KEY`
in its environment. Keep keys out of YAML.
The adapter is tested with OpenCode 1.18.31 using plugin SDK 1.18.30.

On macOS or Linux (including WSL), run:

```sh
curl -fsSL https://harrison97.github.io/opencode-foreman/install.sh | bash
```

Requires Git and npm as well as the prerequisites above. The installer downloads,
builds, and registers Foreman and its terminal trace UI. Restart OpenCode afterward.
Run the same command again to update.

The managed installation lives in `${XDG_DATA_HOME:-$HOME/.local/share}/opencode-foreman`.
Set `FOREMAN_INSTALL_DIR` to an absolute path to choose another location; when piping,
pass it to Bash: `curl -fsSL https://harrison97.github.io/opencode-foreman/install.sh | FOREMAN_INSTALL_DIR=/your/path bash`.
Updates replace this managed directory, so keep custom workflows in your projects.
Existing OpenCode settings are preserved. You can [inspect the installer](site/install.sh)
before running it.

For development or a manually managed checkout:

```sh
git clone https://github.com/Harrison97/opencode-foreman.git
cd opencode-foreman
npm ci && npm run install:local
```

Keep that checkout in place: the local installation points to its compiled files.

Make `TYPESAFE_API_KEY` available to the shell or launcher that starts OpenCode. Configure
your coding model in OpenCode as usual; Foreman uses those existing credentials.
See [UI compatibility](docs/sidebar.md) and [operations](docs/operations.md) for
configuration, disabling, and recovery.

## Start a project

Open OpenCode in the project you want to work on.

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
- `/foreman-routing` shows routing inputs, excluded stages, probabilities, and outcomes.

These are chat messages/UI commands, not shell commands. The agent uses
`foreman_status` to inspect its assignment and `foreman_report` to report outcomes.

## Make your own workflow

Foreman supports one project configuration: **`foreman.workflow.yaml`**, in the
directory where OpenCode starts. There is no home-directory workflow discovery.
To customize the default, copy the complete `src/workflows/software-engineer/`
directory from this repository into your project as `workflows/software-engineer/`,
including its `prompts/` files. Point your project configuration at that copy:

```yaml
source: workflows/software-engineer/workflow.yaml
```

A minimal complete workflow:

```yaml
version: 1
name: Writing assistant
admission:
  when: Substantial writing projects.
  bypass: Unrelated requests.
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
