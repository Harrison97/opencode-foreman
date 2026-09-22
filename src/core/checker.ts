import type { Workflow } from './types.js';
import { outputReference } from './references.js';

export interface Diagnostic { severity: 'error' | 'warning'; path: string; message: string }
type Schema = Record<string, any>;
const properties = (w: Workflow, id: string): Record<string, Schema> => w.capabilities[id]!.outputs?.properties as Record<string, Schema> ?? {};
const types = (s: Schema): string[] => typeof s?.type === 'string' ? [s.type] : Array.isArray(s?.type) ? s.type : [];

/** Semantic checks over a structurally validated workflow. No services or model calls. */
export function checkWorkflow(w: Workflow, stateLimit = 20000): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const emit = (severity: Diagnostic['severity'], path: string, message: string) => {
    if (!diagnostics.some(d => d.path === path && d.message === message)) diagnostics.push({ severity, path, message });
  };
  const ids = Object.keys(w.capabilities);
  const producers = new Map<string, { id: string; schema: Schema }[]>();
  for (const id of ids) for (const [field, schema] of Object.entries(properties(w, id))) {
    producers.set(field, [...producers.get(field) ?? [], { id, schema }]);
  }
  for (const [field, writers] of producers) for (let i = 0; i < writers.length; i++) for (const b of writers.slice(i + 1)) {
    const a = writers[i]!;
    const incompatible = (x: Schema, y: Schema): boolean => {
      const xt = types(x), yt = types(y);
      return xt.length > 0 && yt.length > 0 && !xt.some(t => yt.includes(t) || t === 'integer' && yt.includes('number') || t === 'number' && yt.includes('integer'));
    };
    if (incompatible(a.schema, b.schema) || types(a.schema).includes('array') && types(b.schema).includes('array') && incompatible(a.schema.items, b.schema.items)) {
      emit('error', `capabilities.${b.id}.outputs.properties.${field}`, `Incompatible shared-field types with ${a.id}; use compatible schemas or distinct field names.`);
    }
  }
  const fields = new Set<string>();
  for (const [id, c] of Object.entries(w.capabilities)) {
    const path = `capabilities.${id}`;
    for (const key of c.append ?? []) {
      const s = properties(w, id)[key];
      if (!s || types(s).length !== 1 || types(s)[0] !== 'array') emit('error', `${path}.append`, `Declare ${key} as an array in this capability's outputs before appending it.`);
    }
    if (c.tools?.declaredChecksOnly && !c.gate?.commands) emit('error', `${path}.tools.declaredChecksOnly`, 'Set gate.commands to a declared command-array field, or disable this restriction.');
    for (const tool of c.tools?.allow ?? []) if (c.tools?.deny?.includes(tool)) emit('warning', `${path}.tools`, `${tool} appears in allow and deny; deny wins. Remove the contradictory entry.`);
    for (const tool of c.tools?.deny ?? []) if (['jev_status', 'jev_report'].includes(tool)) emit('warning', `${path}.tools.deny`, `${tool} is a Foreman control tool and is exempt from these lists.`);
    if (c.gate?.commands && !['bash', 'shell'].some(t => !c.tools?.deny?.includes(t) && (!c.tools?.allow || c.tools.allow.includes(t)))) emit('error', `${path}.tools`, 'A command gate requires an allowed bash or shell tool to collect native evidence.');
    for (const kind of ['commands', 'acceptance', 'files'] as const) {
      const field = c.gate?.[kind];
      if (!field || Array.isArray(field)) continue;
      fields.add(field);
      const ref = outputReference(field);
      if (!ref) { emit('error', `${path}.gate.${kind}`, `Use capability.output, such as build.checks, instead of ${field}.`); continue; }
      if (!Object.hasOwn(w.capabilities, ref.producer)) { emit('error', `${path}.gate.${kind}`, `Unknown output producer ${ref.producer}; reference an existing capability.`); continue; }
      if (ref.producer === id && kind !== 'files') emit('error', `${path}.gate.${kind}`, 'A gate must consume an earlier capability output, not its own output.');
      if (ref.producer === id && kind === 'files' && !(c.outputs?.required as string[] | undefined)?.includes(ref.field))
        emit('error', `${path}.gate.files`, `Require ${ref.field} in this capability's outputs.required so its submitted paths can be checked.`);
      const source = (producers.get(ref.field) ?? []).filter(p => p.id === ref.producer);
      if (!source.length) emit('error', `${path}.gate.${kind}`, `No declared output ${field}; declare ${ref.field} in ${ref.producer}.outputs.properties.`);
      for (const p of source) {
        const t = types(p.schema), item = types(p.schema.items);
        if (t.length && (t.length !== 1 || t[0] !== 'array') || item.length && (item.length !== 1 || item[0] !== 'string')) emit('error', `${path}.gate.${kind}`, `${field} must be an array of strings; correct its output schema.`);
        else if (!t.length || !item.length) emit('warning', `${path}.gate.${kind}`, `Cannot prove the type of ${field}; use explicit type: array and items.type: string for static checking.`);
        if (!(p.schema.minItems >= 1)) emit('warning', `${path}.gate.${kind}`, `${field} permits an empty array, which this gate rejects; set minItems: 1.`);
      }
      if (kind !== 'files' && (c.outputs?.required as string[] | undefined)?.includes(ref.field)) emit('error', `${path}.outputs.required`, `${field} is also consumed by this capability's gate; gated contract fields cannot be overwritten. Produce it earlier instead.`);
    }
    if (c.outputs && ['$ref', 'allOf', 'anyOf', 'oneOf', 'if', 'patternProperties'].some(k => k in c.outputs!)) emit('warning', `${path}.outputs`, 'Complex output schemas still validate at runtime; static field analysis uses only top-level properties and required declarations.');
  }

  // Explore completion sets, preserving shared output presence across repair loops.
  // This mirrors runtime invalidation; plain graph reachability misses dependency deadlocks.
  type State = { id: string; done: Set<string>; data: Set<string> };
  const stateKey = (s: State) => JSON.stringify([s.id, [...s.done].sort(), [...s.data].sort()]);
  const queue: State[] = w.admission.entries.map(id => ({ id, done: new Set(), data: new Set() }));
  const scheduled = new Set(queue.map(stateKey));
  const visited = new Set<string>(), reached = new Set<string>(), terminal = new Set<string>();
  const invalidate = (done: Set<string>, id: string) => {
    const invalid = new Set([id]);
    for (const x of invalid) for (const other of ids) if (w.capabilities[other]!.dependsOn?.includes(x)) invalid.add(other);
    for (const x of invalid) done.delete(x);
  };
  let truncated = false;
  for (let n = 0; n < queue.length; n++) {
    const s = queue[n]!;
    const key = stateKey(s);
    if (visited.has(key)) continue;
    if (visited.size >= stateLimit) { truncated = true; break; }
    visited.add(key); reached.add(s.id);
    const c = w.capabilities[s.id]!;
    if (c.terminal) { terminal.add(s.id); continue; }
    for (const kind of ['commands', 'acceptance', 'files'] as const) {
      const field = c.gate?.[kind];
      if (!field || Array.isArray(field) || kind === 'files' && outputReference(field)?.producer === s.id) continue;
      if (field && (!s.data.has(field) || !s.done.has(outputReference(field)?.producer ?? ''))) emit('error', `capabilities.${s.id}.gate.${kind}`, `${field} is not guaranteed on every entry path. Require it in an earlier producer's outputs.required and prevent transitions that skip or invalidate that producer.`);
    }
    for (const outcome of ['ready', 'incomplete', 'blocked'] as const) {
      const done = new Set(s.done), data = new Set(s.data);
      if (outcome === 'ready') {
        done.add(s.id);
        for (const field of fields) if (outputReference(field)?.producer === s.id) data.delete(field);
        for (const field of (c.outputs?.required as string[] | undefined) ?? []) if (fields.has(`${s.id}.${field}`) && Object.hasOwn(properties(w, s.id), field)) data.add(`${s.id}.${field}`);
      } else invalidate(done, s.id);
      const targets = (c.next?.[outcome] ?? []).filter(id => (outcome === 'ready' || !w.capabilities[id]!.terminal) && (w.capabilities[id]!.dependsOn ?? []).every(dep => done.has(dep)));
      if (c.next?.[outcome]?.length && !targets.length) emit('warning', `capabilities.${s.id}.next.${outcome}`, 'A reachable completion state has no eligible next capability; this outcome pauses. Adjust dependencies/transitions if that is unintended.');
      for (const id of targets) {
        const nextDone = new Set(done); invalidate(nextDone, id);
        const next = { id, done: nextDone, data };
        const key = stateKey(next);
        if (!scheduled.has(key)) {
          if (queue.length >= stateLimit) truncated = true;
          else { scheduled.add(key); queue.push(next); }
        }
      }
    }
  }
  if (truncated) emit('warning', 'capabilities', `Dependency/output analysis reached its ${stateLimit}-state limit; full reachability was not proven. Simplify the graph or review the unproven paths.`);
  else {
    for (const id of ids) if (!reached.has(id)) emit('error', `capabilities.${id}.dependsOn`, 'Capability is unreachable with completion prerequisites enforced; reorder transitions or fix its dependencies.');
    if (!terminal.size) emit('error', 'capabilities', 'No terminal delivery is reachable with completion prerequisites enforced; fix dependency deadlocks.');
  }
  return diagnostics;
}

export function checkHost(w: Workflow, models: string[], tools: string[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [id, c] of Object.entries(w.capabilities)) {
    if (c.model && !models.includes(c.model)) diagnostics.push({ severity: 'warning', path: `capabilities.${id}.model`, message: `${c.model} is not advertised by a connected provider in this host; configure the provider/model before running.` });
    for (const name of new Set([...(c.tools?.allow ?? []), ...(c.tools?.deny ?? [])])) if (!tools.includes(name) && !['jev_status', 'jev_report'].includes(name)) diagnostics.push({ severity: 'warning', path: `capabilities.${id}.tools`, message: `${name} is not advertised by this host's tool inventory; verify the name and plugin/MCP configuration.` });
  }
  return diagnostics;
}
