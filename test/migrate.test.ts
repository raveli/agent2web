import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { migrate } from '../src/core/schema.js';
import { onceUntilSuccess } from '../src/util/once.js';
import { startHarness, type Harness } from './helpers.js';

// Backlog #4 (migration lock) and #3 (a failed migration must not stick).

let h: Harness;

before(async () => {
  // No request is made, so the Worker never migrates this database itself.
  h = await startHarness();
});
after(async () => h.close());

test('concurrent isolates apply a non-idempotent migration exactly once', async () => {
  // No IF NOT EXISTS anywhere: run twice, either statement fails.
  const migrations = [
    ['CREATE TABLE lock_probe (id INTEGER PRIMARY KEY)'],
    ['ALTER TABLE lock_probe ADD COLUMN added TEXT', "INSERT INTO lock_probe (added) VALUES ('once')"],
  ];
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => migrate(h.db, migrations, { pollMs: 20 })),
  );
  for (const r of results) assert.equal(r.status, 'fulfilled', String((r as PromiseRejectedResult).reason));
  assert.deepEqual(await h.db.all('SELECT added FROM lock_probe'), [{ added: 'once' }]);
  const meta = await h.db.all<{ key: string; value: string }>('SELECT key, value FROM schema_meta ORDER BY key');
  assert.deepEqual(meta, [{ key: 'version', value: '2' }], 'the lock row is released');

  // Already current: returns without touching anything.
  assert.equal(await migrate(h.db, migrations), 2);
});

test('a lock left by a crashed isolate is taken over once it expires', async () => {
  const migrations = [
    ['CREATE TABLE lock_probe (id INTEGER PRIMARY KEY)'],
    ['ALTER TABLE lock_probe ADD COLUMN added TEXT', "INSERT INTO lock_probe (added) VALUES ('once')"],
    ['CREATE TABLE after_crash (id INTEGER)'],
  ];
  await h.db.run(
    `INSERT INTO schema_meta (key, value) VALUES ('migration_lock', ?)`,
    `${Date.now() - 1}:dead-isolate`,
  );
  assert.equal(await migrate(h.db, migrations, { pollMs: 20 }), 3);
  assert.ok(await h.db.first(`SELECT name FROM sqlite_master WHERE name = 'after_crash'`));
});

test('a live lock makes others wait, then give up rather than migrate over it', async () => {
  const migrations = [
    ['CREATE TABLE lock_probe (id INTEGER PRIMARY KEY)'],
    ['ALTER TABLE lock_probe ADD COLUMN added TEXT', "INSERT INTO lock_probe (added) VALUES ('once')"],
    ['CREATE TABLE after_crash (id INTEGER)'],
    ['CREATE TABLE never_applied (id INTEGER)'],
  ];
  await h.db.run(
    `INSERT INTO schema_meta (key, value) VALUES ('migration_lock', ?)`,
    `${Date.now() + 60_000}:busy-isolate`,
  );
  await assert.rejects(migrate(h.db, migrations, { waitMs: 150, pollMs: 20 }), /Timed out/);
  assert.equal(await h.db.first(`SELECT name FROM sqlite_master WHERE name = 'never_applied'`), undefined);
  await h.db.run(`DELETE FROM schema_meta WHERE key = 'migration_lock'`);
});

test('onceUntilSuccess retries after a failure but memoises a success', async () => {
  let calls = 0;
  const init = onceUntilSuccess(async () => {
    calls += 1;
    if (calls === 1) throw new Error('transient');
    return 'ready';
  });
  await assert.rejects(init(), /transient/);
  assert.equal(await init(), 'ready');
  assert.equal(await init(), 'ready');
  assert.equal(calls, 2);
});
