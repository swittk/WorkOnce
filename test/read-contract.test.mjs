import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkOnce, WorkConflict } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
import { createSqliteStore } from '../dist/sqlite.js';
import { createCompareExchangeStore } from '../dist/cas.js';

function casFixture(now) {
  const native = createMemoryStore({ now });
  return createCompareExchangeStore({
    getMany: (ids) => native.getMany(ids),
    query: (query) => native.query(query),
    compareExchange: (change) =>
      native.atomic(change.id, (row, clock) => {
        if (
          row?.revision !== change.expectedRevision ||
          (change.validUntil !== undefined && clock >= change.validUntil)
        )
          return { value: false };
        return { next: change.next, value: true };
      }),
  });
}

function fixture(adapter) {
  const now = () => 1234;
  if (adapter === 'memory') return { store: createMemoryStore({ now }) };
  if (adapter === 'cas') return { store: casFixture(now) };
  const directory = mkdtempSync(join(tmpdir(), 'workonce-read-contract-'));
  const store = createSqliteStore(join(directory, 'queue.sqlite'), { now });
  return {
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function exactConflict(promise, code) {
  await assert.rejects(
    promise,
    (error) => error instanceof WorkConflict && error.code === code,
    `expected WorkConflict(${code})`,
  );
}

for (const adapter of ['memory', 'sqlite', 'cas']) {
  test(`${adapter}: definition-bound reads preserve order, missing rows, identity and exact fences`, async () => {
    const f = fixture(adapter);
    try {
      const current = createWorkOnce({ store: f.store, scope: 'read-contract' }).define('job', {
        version: '1',
      });
      const a = await current.ensure({ value: 'a' }, { key: 'a' });
      const b = await current.ensure({ value: 'b' }, { key: 'b' });
      const before = JSON.stringify((await f.store.getMany([a.id, b.id])).rows);

      assert.equal(await current.inspect('missing'), undefined);
      assert.equal(await current.inspectId('missing-id'), undefined);
      assert.deepEqual(await current.inspectMany(['missing', 'b', 'a', 'missing', 'b']), [
        undefined,
        b,
        a,
        undefined,
        b,
      ]);
      assert.deepEqual(await current.item(null, 'a').inspect(), a);
      assert.deepEqual(await current.inspectId(a.id), a);
      const history = await current.history('a');
      assert.equal(history.length, 1);
      assert.equal(history[0].action, 'enqueue');

      const newer = createWorkOnce({ store: f.store, scope: 'read-contract' }).define('job', {
        version: '2',
      });
      await exactConflict(newer.inspect('a'), 'definition_changed');
      await exactConflict(newer.inspectMany(['missing', 'a']), 'definition_changed');
      await exactConflict(newer.item(null, 'a').inspect(), 'definition_changed');
      await exactConflict(newer.inspectId(a.id), 'definition_changed');
      await exactConflict(newer.history('a'), 'definition_changed');

      const wrongScope = createWorkOnce({ store: f.store, scope: 'other-scope' }).define('job', {
        version: '1',
      });
      await exactConflict(wrongScope.inspectId(a.id), 'not_found');

      const after = JSON.stringify((await f.store.getMany([a.id, b.id])).rows);
      assert.equal(after, before, 'reads must not mutate durable records');
    } finally {
      f.close?.();
    }
  });
}
