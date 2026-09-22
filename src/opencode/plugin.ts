import { type Plugin, tool } from '@opencode-ai/plugin';
import { StateStore } from '../core/state.js';
import { Controller } from '../core/controller.js';
import { JevClient } from '../jev/client.js';
import { UsageLog } from '../jev/usage.js';
import { resolve } from 'node:path';
import { loadWorkflowConfig } from './config.js';
import type { WorkflowState } from '../core/types.js';

export const JevSupervisor: Plugin = async ({ directory, client }) => {
  if (process.env.JEV_DISABLED === '1') return {};
  const workflow = await loadWorkflowConfig(directory);
  const usage = new UsageLog(directory);
  let connected = false;
  const notify = async (title: string, message: string, variant: 'warning' | 'success' = 'warning') => {
    await client.app.log({ body: { service: 'jev-supervisor', level: variant === 'warning' ? 'warn' : 'info', message: title + ': ' + message } }).catch(() => {});
    await client.tui.showToast({ body: { title, message, variant, duration: 12000 } }).catch(() => {});
  };
  const controller = new Controller(new StateStore(directory), new JevClient({ onNotice: async notice => {
    if (notice.type === 'connected') {
      if (!connected) { connected = true; await notify('Jev connected', notice.message, 'success'); }
    } else await notify('Jev retrying', notice.message);
  }, onUsage: async record => {
    try { await usage.append(record); }
    catch {
      await client.app.log({ body: { service: 'jev-supervisor', level: 'error', message: 'Could not write .jev/usage.jsonl; Jev usage accounting may be incomplete.' } }).catch(() => {});
      throw new Error('Jev usage accounting could not be persisted');
    }
  } }), {
    workflow, maxTurns: Number(process.env.JEV_MAX_TURNS ?? 40),
  });
  let disposed = false;
  const active = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const log = async (message: string) => { await client.app.log({ body: { service: 'jev-supervisor', level: 'info', message } }).catch(() => {}); };
  await log('Loaded Foreman workflow: ' + workflow.name);
  async function selectModel(state: WorkflowState) {
    const model = controller.selectedModel(state);
    if (model) {
      await controller.recordModel(state.sessionID, model);
      await log(`Capability ${state.capability} model ${model.providerID}/${model.modelID}`);
    }
    return model;
  }
  async function onIdle(sessionID: string) {
    if (disposed || active.has(sessionID)) return;
    active.add(sessionID);
    try {
      const s = await controller.get(sessionID);
      if (!s || s.status !== 'running') return;
      const response = await client.session.messages({ path: { id: sessionID }, query: { directory, limit: 20 } });
      if (response.error || !response.data) throw new Error('Cannot read session messages');
      const last = response.data.findLast(m => m.info.role === 'assistant');
      if (!last || last.info.role !== 'assistant' || !last.info.time.completed) return;
      if (last.info.error) { await controller.pause(sessionID, 'OpenCode agent failed or was interrupted. Review the session and reply to resume.'); return; }
      const next = await controller.gate(sessionID, last.info.id);
      if (!next) return;
      await log(`Capability ${s.capability} -> ${next.capability} (${next.status})`);
      if (next.status === 'paused') {
        await notify('Foreman paused', [...next.questions, next.pauseReason ?? ''].join('\n'));
        return;
      }
      if (next.pending && !disposed) {
        const latest = await controller.get(sessionID);
        if (latest?.pending?.id !== next.pending.id || latest.capability !== next.capability) return;
        const sent = await client.session.promptAsync({ path: { id: sessionID }, query: { directory }, body: {
          messageID: next.pending.id, model: await selectModel(next), agent: next.agent,
          parts: [{ type: 'text', text: next.pending.text, synthetic: true }],
        } });
        if (sent.error) throw new Error('Continuation dispatch failed');
      }
    } catch {
      await controller.pause(sessionID, 'Supervisor host operation failed. Review state and reply to resume.').catch(() => {});
      await log('Supervisor paused after a host operation failure (details suppressed to protect credentials)');
    } finally { active.delete(sessionID); }
  }
  const strings = tool.schema.array(tool.schema.string().max(3000)).max(60).optional();
  return {
    dispose: async () => { disposed = true; for (const timer of timers.values()) clearTimeout(timer); },
    'chat.message': async (input, output) => {
      if (!(await controller.get(input.sessionID))) {
        const session = await client.session.get({ path: { id: input.sessionID }, query: { directory } });
        // The parent workflow owns native subagent work; don't admit a second project.
        if (session.data?.parentID) return;
      }
      const parts = output.parts.filter(p => p.type === 'text');
      const text = parts.map(p => p.text).join('\n');
      // Synthetic host messages (compaction) and persisted internal IDs never create a goal.
      const existing = await controller.get(input.sessionID);
      const state = await controller.admit(input.sessionID, text, output.message.id, parts.length > 0 && parts.every(p => p.synthetic), {
        model: input.model ?? existing?.model ?? output.message.model, agent: input.agent,
      });
      if (state) {
        if (state.status === 'paused') { await notify('Foreman paused', state.pauseReason ?? 'Awaiting user input'); return; }
        const model = await selectModel(state);
        if (model) {
          const changed = output.message.model?.providerID !== model.providerID || output.message.model?.modelID !== model.modelID;
          output.message.model = model;
          // Provider-specific variants must not leak onto a different model.
          if (changed) delete (output.message as { variant?: string }).variant;
        }
      }
    },
    'experimental.chat.system.transform': async (input, output) => {
      if (!input.sessionID) return; const s = await controller.get(input.sessionID);
      if (s) output.system.push(controller.instructions(s));
    },
    'experimental.session.compacting': async (input, output) => {
      const s = await controller.get(input.sessionID); if (s) output.context.push(controller.instructions(s));
    },
    'shell.env': async (_input, output) => { output.env.JEV_API_KEY = ''; output.env.TYPESAFE_API_KEY = ''; },
    'tool.execute.before': async (input, output) => {
      await controller.beforeTool(input.sessionID, input.tool, output.args?.command);
    },
    'tool.execute.after': async (input, output) => {
      if (!['bash', 'shell'].includes(input.tool) || typeof input.args?.command !== 'string') return;
      const cwd = input.args.workdir ?? input.args.cwd ?? directory;
      if (resolve(cwd) !== resolve(directory)) return;
      await controller.evidence(input.sessionID, { callID: input.callID, command: input.args.command,
        exit: typeof output.metadata?.exit === 'number' ? output.metadata.exit : null, output: output.output });
    },
    event: async ({ event }) => {
      if (event.type === 'session.error' && event.properties.sessionID) {
        await controller.pause(event.properties.sessionID, 'OpenCode reported an error or cancellation. Reply after resolving it to resume.').catch(() => {});
      }
      if (event.type !== 'session.idle') return;
      const sessionID = event.properties.sessionID;
      if (timers.has(sessionID)) clearTimeout(timers.get(sessionID));
      // Let OpenCode release its current work unit before submitting another prompt.
      timers.set(sessionID, setTimeout(() => { timers.delete(sessionID); void onIdle(sessionID); }, 150));
    },
    tool: {
      jev_status: tool({ description: 'Read the durable Foreman workflow and current capability. No transition is requested.', args: {},
        execute: async (_args, context) => JSON.stringify(await controller.get(context.sessionID) ?? { managed: false }) }),
      jev_report: tool({
        description: 'Report the CURRENT capability. Put workflow-defined outputs in data. For incomplete/blocked omit data and describe findings in summary. Questions are essential human decisions only. covered contains exact labels required by an acceptance gate. After acceptance, finish the response. Correct a rejected report in this turn.',
        args: {
          summary: tool.schema.string().min(1).max(4000), outcome: tool.schema.enum(['ready', 'incomplete', 'blocked']),
          data: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional(),
          questions: strings, covered: strings,
        },
        execute: async (args, context) => {
          await controller.report(context.sessionID, args);
          return 'Capability report persisted. Finish your response now. Foreman selects the next eligible capability.';
        },
      }),
    },
  };
};
