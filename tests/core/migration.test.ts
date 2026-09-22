import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, ready, advance } from "../support/fixtures.js";

async function legacy() {
  const f = await fixture();
  await advance(f.c);
  await f.c.evidence("s", {
    callID: "check",
    command: "node --test",
    exit: 0,
    output: "pass",
  });
  await f.c.report("s", {
    summary: "verified",
    outcome: "ready",
    covered: ready.data.labels,
  });
  await f.c.gate("s", "verified");
  const view = await f.state();
  const {
    phase: _phase,
    version: _version,
    guidance: _guidance,
    ...fields
  } = view;
  const old = {
    ...fields,
    schema: 2,
    status: "complete",
    data: { ...ready.data },
    pending: { ...view.pending, delivered: false },
  };
  const original = JSON.stringify({
    schema: 2,
    active: old.id,
    workflows: { [old.id]: old },
  });
  await writeFile(f.store.path, original);
  return { ...f, original, id: old.id };
}

test("v2 migration preserves undelivered work, producer outputs, and a private original backup", async () => {
  const f = await legacy();
  const migrated = (await f.store.read()).workflows[f.id]!;
  assert.equal(migrated.schema, 3);
  assert.equal(migrated.phase.kind, "dispatching");
  assert.deepEqual(migrated.capabilityOutputs.draft, ready.data);
  assert.equal("data" in migrated, false);
  assert.equal(await readFile(f.store.path, "utf8"), f.original);
  await f.store.transaction(() => {});
  assert.equal(
    await readFile(join(f.store.dir, "foreman-state.v2.json"), "utf8"),
    f.original,
  );
  assert.equal(JSON.parse(await readFile(f.store.path, "utf8")).schema, 3);
  await f.store.transaction(() => {});
  assert.equal(
    await readFile(join(f.store.dir, "foreman-state.v2.json"), "utf8"),
    f.original,
  );
});

test("unmigratable state fails explicitly without overwriting the original", async () => {
  const f = await legacy();
  const db = JSON.parse(f.original);
  delete db.workflows[f.id].capabilityOutputs;
  const original = JSON.stringify(db);
  await writeFile(f.store.path, original);
  await assert.rejects(
    f.store.transaction(() => {}),
    /lacks output provenance/,
  );
  assert.equal(await readFile(f.store.path, "utf8"), original);
});
