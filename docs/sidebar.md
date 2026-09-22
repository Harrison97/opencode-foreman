# Persistent capability trace

Foreman's terminal UI companion shows the selected conversation's workflow name,
current capability/status, pause reason, and the eight most recent transitions.
Visits are numbered and repair loops remain visible; a visited capability is not
presented as permanently complete. `/foreman-trace` or **Foreman: capability trace**
in the command palette opens the full transition history. Select a transition
for its timestamp and recorded routing reason.

The panel uses OpenCode's public `sidebar_content` TUI slot, not a modified
OpenCode binary. It reads `.foreman/foreman-state.json` once per second, makes no model
requests, and never writes workflow state or triggers continuation. No workflow
in the selected conversation means no panel. A completed workflow keeps its trace
until that conversation starts another request. If the sidebar is hidden, use
OpenCode's sidebar toggle (normally Ctrl+X, B).

## Installation and compatibility

```sh
npm run install:local
```

Restart the terminal UI. Installation retains the server shim and adds the UI
entry to global `tui.json` (or an existing `tui.jsonc`), preserving comments,
other plugins, settings, and any explicit disabled state.

- Supported API target: **OpenCode 1.18.30+ within 1.x**; actually tested in
  **1.18.31**, with plugin type definitions 1.18.30. This is not a claim that
  every host version has been tested. OpenCode 2.x has a different plugin API.
- This is for the **terminal UI**, not the web/desktop interfaces.
- The state file must be readable on the TUI machine. A remotely attached TUI
  without access to the project's state directory cannot display this panel.
- The module is separate from the workflow server plugin. Disabling the UI does
  not disable supervision, and headless runs do not load it.
- `FOREMAN_DISABLED=1` also suppresses the panel. `opencode --pure` skips external
  plugins through the host's native mechanism.

To disable only the panel, use OpenCode's **Plugins** dialog, or set this in the
TUI configuration and restart:

```json
{
  "plugin_enabled": {
    "foreman.trace": false
  }
}
```

OpenCode's persisted Plugins-dialog selection can override that configuration;
re-enable the panel from the same dialog if necessary. To remove its registration,
remove the `dist/opencode/tui.jsx` entry from the TUI config's `plugin` array.
The server shim lives separately at `~/.config/opencode/plugins/foreman.js`.

The trace is generic: it reads capability IDs and transitions from any pinned
workflow. It does not depend on Foreman's engineering campaign JSON or assume
particular capability names. Corrupt, incompatible or unavailable state hides
the panel rather than displaying stale progress from another conversation.

API reference: [OpenCode's TUI plugin specification](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/specs/tui-plugins.md).
