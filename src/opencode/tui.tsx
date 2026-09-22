/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createSignal, For, Show } from "solid-js";
import { readTrace, recentSteps, type TraceView } from "./trace.js";

const tui: TuiPlugin = async (api) => {
  if (process.env.FOREMAN_DISABLED === "1") return;
  const [major, minor, patch] = api.app.version.split(".").map(Number);
  if (
    major !== 1 ||
    minor === undefined ||
    patch === undefined ||
    !Number.isFinite(minor) ||
    !Number.isFinite(patch) ||
    minor < 18 ||
    (minor === 18 && patch < 30) ||
    !api.slots?.register ||
    !api.keymap?.registerLayer
  ) {
    api.ui.toast({
      variant: "warning",
      message:
        "Foreman sidebar requires OpenCode 1.18.30+ (1.x). Workflow supervision is separate.",
    });
    return;
  }
  const [trace, setTrace] = createSignal<TraceView>();
  let disposed = false;
  let reading = false;
  let previous = "";

  function session() {
    const route = api.route.current;
    return route.name === "session" &&
      typeof route.params?.sessionID === "string"
      ? route.params.sessionID
      : undefined;
  }

  async function refresh() {
    if (disposed || reading) return;
    const id = session();
    const directory = id && api.state.session.get(id)?.directory;
    if (!id || !directory) {
      setTrace(undefined);
      previous = "";
      return;
    }
    reading = true;
    try {
      const next = await readTrace(directory, id);
      if (disposed || session() !== id) return;
      const encoded = JSON.stringify(next) ?? "";
      if (encoded !== previous) {
        previous = encoded;
        setTrace(next);
      }
    } catch {
      // Missing/incompatible/remote state must not show another session's trace.
      previous = "";
      setTrace(undefined);
    } finally {
      reading = false;
    }
  }

  api.slots.register({
    slots: {
      sidebar_content: (_context, props) => (
        <Show
          when={trace()?.sessionID === props.session_id ? trace() : undefined}
        >
          {(current) => (
            <box flexDirection="column" paddingTop={1} gap={1}>
              <text fg={api.theme.current.primary}>
                <b>
                  {current().name === "Foreman"
                    ? "Foreman"
                    : `Foreman · ${current().name}`}
                </b>
              </text>
              <box flexDirection="column">
                <text
                  fg={
                    current().status === "paused"
                      ? api.theme.current.warning
                      : api.theme.current.text
                  }
                >
                  {current().capability} · {current().status}
                </text>
                <Show when={current().pauseReason}>
                  <text fg={api.theme.current.warning}>
                    {current().pauseReason}
                  </text>
                </Show>
              </box>
              <box flexDirection="column">
                <For each={recentSteps(current())}>
                  {(step) => (
                    <text fg={api.theme.current.textMuted}>
                      {step.number}. {step.text}
                    </text>
                  )}
                </For>
              </box>
              <text fg={api.theme.current.textMuted}>
                /foreman-trace · full history
              </text>
            </box>
          )}
        </Show>
      ),
    },
  });

  api.keymap.registerLayer({
    commands: [
      {
        name: "foreman.trace",
        title: "Foreman: capability trace",
        category: "Foreman",
        namespace: "palette",
        slashName: "foreman-trace",
        run() {
          const current = trace();
          if (!current || current.sessionID !== session()) {
            api.ui.toast({
              message: "No local Foreman workflow in this session",
              variant: "info",
            });
            return;
          }
          api.ui.dialog.replace(() => (
            <api.ui.DialogSelect
              title={`Foreman · ${current.capability} · ${current.status}`}
              options={current.steps.map((step, index) => ({
                title: `${index + 1}. ${step.from ?? "start"} → ${step.to}`,
                value: index,
                description: step.at,
                footer: `${step.source}${step.confidence === undefined ? "" : ` · ${Math.round(step.confidence * 100)}%`}`,
                onSelect: () =>
                  api.ui.dialog.replace(() => (
                    <api.ui.DialogAlert
                      title={`${step.from ?? "start"} → ${step.to}`}
                      message={`${step.at}\n${step.reason}`}
                    />
                  )),
              }))}
            />
          ));
        },
      },
    ],
  });

  const timer = setInterval(() => void refresh(), 1000);
  api.lifecycle.onDispose(() => {
    disposed = true;
    clearInterval(timer);
    setTrace(undefined);
  });
  await refresh();
};

export default { id: "foreman.trace", tui } satisfies TuiPluginModule;
