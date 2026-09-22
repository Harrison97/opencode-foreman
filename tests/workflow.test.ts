import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { parseWorkflow } from '../src/core/workflow.js';
import { loadWorkflowFile } from '../src/core/loader.js';
import { loadWorkflowConfig } from '../src/opencode/config.js';
import { parseModel } from '../src/core/models.js';
import { fixture, sample, ready, advance } from './fixtures.js';

test('bundled software workflow uses the same parser and has one capability layer', async () => {
  const w = await loadWorkflowFile(resolve('src/workflows/software-engineer/workflow.yaml'));
  assert.equal(w.name,'software-engineer');
  assert.equal(w.capabilities.review!.gate?.commands,'build.commands');
  assert.equal(w.capabilities.review!.model,undefined);
  assert.equal(Object.hasOwn(w,'stages'),false);
});
test('schema rejects unknown semantics, references, dependency cycles, and invalid models', () => {
  const mutate: ((w:any)=>void)[] = [
    w=>w.capabilities.draft.kind='implementation',
    w=>w.capabilities.draft.next.ready=['missing'],
    w=>w.capabilities.draft.fallback={ready:'publish'},
    w=>w.capabilities.draft.dependsOn=['proof'],
    w=>w.capabilities.publish.next={ready:['draft']},
    w=>w.capabilities.proof.model='bad model',
    w=>w.capabilities.proof.gate={acceptance:'labels'},
    w=>w.admission.fallback='publish',
    w=>w.capabilities.draft.outputs={type:'object',unknownKeyword:true},
    w=>w.capabilities.lonely={purpose:'x',instructions:'x',completion:'x',terminal:true},
    w=>w.capabilities.proof.next={ready:['proof']},
    w=>w.capabilities.proof.dependsOn=['publish'],
  ];
  for(const change of mutate){const w=structuredClone(sample);change(w);assert.throws(()=>parseWorkflow(w));}
});
test('local workflow repo imports capabilities, markdown instructions and JSON schemas', async () => {
  const root=await mkdtemp(join(tmpdir(),'foreman-package-'));
  const repo=join(root,'repo'); const project=join(root,'project');
  await mkdir(repo); await mkdir(project);
  const w:any=structuredClone(sample);
  const draft=w.capabilities.draft;
  await writeFile(join(repo,'prompt.md'),'Custom editorial guidance.');
  await writeFile(join(repo,'output.json'),JSON.stringify(draft.outputs));
  draft.instructions={file:'prompt.md'}; draft.outputs={file:'output.json'};
  await writeFile(join(repo,'library.yaml'),YAML.stringify({capabilities:{draft}}));
  delete w.capabilities.draft; w.imports=['library.yaml'];
  await writeFile(join(repo,'foreman.yaml'),YAML.stringify(w));
  await writeFile(join(project,'jev.workflow.yaml'),YAML.stringify({source:'../repo/foreman.yaml'}));
  const loaded=await loadWorkflowConfig(project);
  assert.equal(loaded.capabilities.draft!.instructions,'Custom editorial guidance.');
  assert.deepEqual(loaded.capabilities.draft!.outputs,sample.capabilities.draft!.outputs);
});
test('invalid YAML, conflicting imports, symlink escapes, and missing sources fail explicitly', async () => {
  const root=await mkdtemp(join(tmpdir(),'foreman-invalid-')); const file=join(root,'jev.workflow.yaml');
  await writeFile(file,'name: first\nname: second\n');
  await assert.rejects(loadWorkflowConfig(root),/Invalid workflow YAML/);
  await writeFile(file,'source: missing.yaml\n');
  await assert.rejects(loadWorkflowConfig(root),/ENOENT/);
  await writeFile(join(root,'lib.yaml'),YAML.stringify({capabilities:{draft:sample.capabilities.draft}}));
  await writeFile(file,YAML.stringify({...sample,imports:['lib.yaml']}));
  await assert.rejects(loadWorkflowConfig(root),/Duplicate capability/);
  await writeFile(join(root,'lib.yaml'),YAML.stringify({imports:['lib.yaml'],capabilities:{}}));
  await assert.rejects(loadWorkflowConfig(root),/Cyclic workflow imports/);
  const outside=await mkdtemp(join(tmpdir(),'foreman-outside-'));
  await writeFile(join(outside,'prompt.md'),'outside');
  await symlink(join(outside,'prompt.md'),join(root,'prompt.md'));
  const w:any=structuredClone(sample);w.capabilities.draft.instructions={file:'prompt.md'};
  await writeFile(file,YAML.stringify(w));
  await assert.rejects(loadWorkflowConfig(root),/escapes package/);
});
test('legacy JSON is rejected explicitly and YAML takes precedence',async()=>{
  const root=await mkdtemp(join(tmpdir(),'foreman-migration-'));
  await writeFile(join(root,'jev.workflow.json'),JSON.stringify({stages:{VERIFY:{model:'provider/model'}}}));
  await assert.rejects(loadWorkflowConfig(root),/Legacy.*Migrate/);
  await writeFile(join(root,'jev.workflow.yaml'),YAML.stringify(sample));
  assert.equal((await loadWorkflowConfig(root)).name,'editorial');
});
test('required artifacts must exist; append-only contract labels survive repair', async () => {
  const w=structuredClone(sample);w.capabilities.draft!.gate={files:['DRAFT.md']};
  const f=await fixture(w);
  await assert.rejects(f.c.report('s',ready),/artifact missing/);
  await writeFile(join(f.root,'DRAFT.md'),'draft');
  await advance(f.c);
  await f.c.report('s',{summary:'fix',outcome:'incomplete'});
  const back=await f.c.gate('s','back');await f.c.admit('s','continue',back!.pending!.id,true);
  await f.c.report('s',{...ready,data:{...ready.data,labels:['New criterion']}});
  assert.deepEqual((await f.state()).data.labels,['Correct tone','New criterion']);
});
test('capability model overrides host model and persists attribution', async () => {
  assert.deepEqual(parseModel('provider/model'),{providerID:'provider',modelID:'model'});
  assert.throws(()=>parseModel('invalid'));
  const w=structuredClone(sample); w.capabilities.proof!.model='provider/reviewer';
  const f=await fixture(w);
  await f.c.admit('s','continue',undefined,false,{model:{providerID:'provider',modelID:'default'}});
  assert.equal(f.c.selectedModel(await f.state())?.modelID,'default');
  await advance(f.c);
  const model=f.c.selectedModel(await f.state())!;
  assert.equal(model.modelID,'reviewer');
  await f.c.recordModel('s',model);await f.c.recordModel('s',model);
  assert.equal((await f.state()).modelHistory.length,1);
  assert.equal((await f.state()).model?.modelID,'default');
});
