import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, sample, ready, advance } from '../support/fixtures.js';
import { parseWorkflow } from '../../src/core/workflow/schema.js';

function workflow() {
  const w = structuredClone(sample);
  (w.capabilities.draft!.outputs!.properties as Record<string, unknown>).artifacts = {type:'array', minItems:1, items:{type:'string',minLength:1}};
  (w.capabilities.draft!.outputs!.required as string[]).push('artifacts');
  w.capabilities.draft!.gate = {files:'draft.artifacts'};
  return w;
}
test('artifact paths are checked before accepting the producer report and can differ on each visit', async () => {
  const f = await fixture(workflow());
  const report = (name:string) => ({...ready,data:{...ready.data,artifacts:[name]}});
  await assert.rejects(f.c.report('s',report('first.md')),/artifact missing/);
  assert.equal((await f.state()).report,undefined);
  await writeFile(join(f.root,'first.md'),'First design');
  await f.c.report('s',report('first.md'));
  const next=await f.c.gate('s','first'); await f.c.admit('s','continue',next!.pending!.id,true);
  await f.c.report('s',{summary:'Another design needed',outcome:'incomplete'});
  const back=await f.c.gate('s','back');await f.c.admit('s','continue',back!.pending!.id,true);
  await assert.rejects(f.c.report('s',report('second.md')),/artifact missing/);
  await writeFile(join(f.root,'second.md'),'Second design');
  await f.c.report('s',report('second.md'));
  assert.deepEqual((await f.state()).capabilityOutputs!.draft!.artifacts,['second.md']);
});
test('artifact references check the named producer and prevent outside-project paths and symlinks', async () => {
  const w=workflow(); w.capabilities.proof!.gate!.files='draft.artifacts';
  const f=await fixture(w);
  await assert.rejects(f.c.report('s',{...ready,data:{...ready.data,artifacts:['/etc/hosts']}}),/outside project/);
  await symlink('/etc/hosts',join(f.root,'outside'));
  await assert.rejects(f.c.report('s',{...ready,data:{...ready.data,artifacts:['outside']}}),/outside project/);
  await writeFile(join(f.root,'draft.md'),'design');
  await f.c.report('s',{...ready,data:{...ready.data,artifacts:['draft.md']}});
  const next=await f.c.gate('s','ready');await f.c.admit('s','continue',next!.pending!.id,true);
  await f.c.evidence('s',{callID:'check',command:'node --test',exit:0,output:'pass'});
  await f.c.report('s',{summary:'Reviewed',outcome:'ready',covered:['Correct tone']});
});
test('checker rejects legacy gate names and invalid artifact sources; acceptance can stand alone', async () => {
  for (const gate of [{checks:'draft.checks'},{coverage:'draft.labels'},{files:'missing.artifacts'},{files:'artifacts'}]) {
    const w=structuredClone(sample); (w.capabilities.proof as any).gate=gate;
    assert.throws(()=>parseWorkflow(w));
  }
  const w=structuredClone(sample);w.capabilities.proof!.gate={acceptance:'draft.labels'};delete w.capabilities.proof!.tools;
  const f=await fixture(w);await advance(f.c);
  await assert.rejects(f.c.report('s',{summary:'reviewed',outcome:'ready'}),/Missing exact coverage/);
  await f.c.report('s',{summary:'reviewed',outcome:'ready',covered:['Correct tone']});
});
