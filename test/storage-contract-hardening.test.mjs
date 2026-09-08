import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCompareExchangeStore } from '../dist/cas.js';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
import { createSqliteStore } from '../dist/sqlite.js';

function casFixture(options = {}) {
  let now = 100;
  const native = createMemoryStore({ now: () => now });
  let falseWrites = options.falseWrites ?? 0;
  let compareCalls = 0;
  const port = {
    getMany: (ids) => native.getMany(ids),
    query: (query) => native.query(query),
    async compareExchange(change) {
      compareCalls++;
      if (falseWrites > 0) {
        falseWrites--;
        return false;
      }
      return native.atomic(change.id, (row, clock) => {
        if (
          row?.revision !== change.expectedRevision ||
          (change.validUntil !== undefined && clock >= change.validUntil)
        )
          return { value: false };
        return { next: change.next, value: true };
      });
    },
  };
  return {
    native,
    port,
    store: createCompareExchangeStore(port, { maxConflicts: options.maxConflicts ?? 100 }),
    compareCalls: () => compareCalls,
    setNow(value) {
      now = value;
    },
  };
}

function fixtures() {
  const sqliteDir = mkdtempSync(join(tmpdir(), 'workonce-storage-contract-'));
  const sqlite = createSqliteStore(join(sqliteDir, 'queue.sqlite'), { now: () => 100 });
  const cas = casFixture();
  return [
    { name: 'memory', store: createMemoryStore({ now: () => 100 }), close() {} },
    {
      name: 'sqlite',
      store: sqlite,
      close() {
        sqlite.close();
        rmSync(sqliteDir, { recursive: true, force: true });
      },
    },
    { name: 'cas', store: cas.store, close() {} },
  ];
}

for (const fixture of fixtures()) {
  test(`${fixture.name}: getMany/query rows are detached and cursor order is stable`, async () => {
    try {
      const work = createWorkOnce({ store: fixture.store, scope: `storage-${fixture.name}` });
      const q = work.define('job');
      const snapshots = [];
      for (const key of ['delta', 'alpha', 'charlie', 'bravo'])
        snapshots.push(await q.ensure({ nested: { key } }, { key }));
      const ids = snapshots.map((snapshot) => snapshot.id);
      const batch = await fixture.store.getMany(ids);
      batch.rows[0].input.nested.key = 'MUTATED';
      const reread = await fixture.store.getMany([ids[0]]);
      assert.equal(reread.rows[0].input.nested.key, 'delta');

      const all = await fixture.store.query({
        scope: `storage-${fixture.name}`,
        select: 'all',
        limit: 20,
      });
      const orderedIds = all.rows.map((row) => row.id);
      assert.deepEqual(orderedIds, [...orderedIds].sort());
      all.rows[0].input.nested.key = 'QUERY-MUTATED';
      assert.notEqual(
        (await fixture.store.getMany([orderedIds[0]])).rows[0].input.nested.key,
        'QUERY-MUTATED',
      );

      for (let index = 0; index < orderedIds.length; index++) {
        const page = await fixture.store.query({
          scope: `storage-${fixture.name}`,
          select: 'all',
          limit: 2,
          afterId: orderedIds[index],
        });
        assert.deepEqual(
          page.rows.map((row) => row.id),
          orderedIds.slice(index + 1, index + 3),
        );
      }
    } finally {
      fixture.close();
    }
  });
}

for (const fixture of fixtures()) {
  test(`${fixture.name}: write deadline equality and serialization failure commit nothing`, async () => {
    try {
      const queue = createWorkOnce({
        store: fixture.store,
        scope: `write-boundary-${fixture.name}`,
      }).define('job');
      const snapshot = await queue.ensure(null, { key: 'x' });
      const before = JSON.stringify((await fixture.store.getMany([snapshot.id])).rows[0]);
      await assert.rejects(
        fixture.store.atomic(snapshot.id, (row) => ({
          next: { ...row, revision: row.revision + 1 },
          validUntil: 100,
          value: null,
        })),
        (error) => error?.code === 'lease_expired',
      );
      await assert.rejects(
        fixture.store.atomic(snapshot.id, (row) => ({
          next: { ...row, revision: row.revision + 1 },
          value: { unsupported: BigInt(1) },
        })),
        /JSON data/u,
      );
      assert.equal(JSON.stringify((await fixture.store.getMany([snapshot.id])).rows[0]), before);
    } finally {
      fixture.close();
    }
  });
}

test('SQLite startup retry recognizes native BUSY/LOCKED result codes without message parsing', () => {
  for (const errcode of [5, 6]) {
    const directory = mkdtempSync(join(tmpdir(), `workonce-sqlite-native-busy-${errcode}-`));
    const path = join(directory, 'queue.sqlite');
    const original = DatabaseSync.prototype.exec;
    let injected = 0;
    DatabaseSync.prototype.exec = function patchedExec(sql) {
      if (injected === 0 && String(sql).includes('PRAGMA journal_mode=WAL')) {
        injected++;
        const error = new Error('opaque native sqlite failure');
        error.code = 'ERR_SQLITE_ERROR';
        error.errcode = errcode;
        error.errstr = errcode === 5 ? 'database is busy' : 'database table is locked';
        throw error;
      }
      return original.call(this, sql);
    };
    try {
      const store = createSqliteStore(path, { busyTimeoutMs: 1000 });
      store.close();
      assert.equal(injected, 1);
    } finally {
      DatabaseSync.prototype.exec = original;
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('SQLite startup retry helper handles a one-shot native busy before schema bootstrap', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-sqlite-busy-injected-'));
  const path = join(directory, 'queue.sqlite');
  const original = DatabaseSync.prototype.exec;
  let injected = 0;
  DatabaseSync.prototype.exec = function patchedExec(sql) {
    if (injected === 0 && String(sql).includes('PRAGMA journal_mode=WAL')) {
      injected++;
      const error = new Error('database is busy');
      error.code = 'ERR_SQLITE_ERROR';
      throw error;
    }
    return original.call(this, sql);
  };
  try {
    const store = createSqliteStore(path, { busyTimeoutMs: 1000 });
    store.close();
    assert.equal(injected, 1);
  } finally {
    DatabaseSync.prototype.exec = original;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite opens only the current schema and never adopts an old development table shape', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-sqlite-current-schema-only-'));
  const path = join(directory, 'queue.sqlite');
  const raw = new DatabaseSync(path);
  raw.exec('CREATE TABLE workonce(id TEXT PRIMARY KEY, body TEXT NOT NULL);');
  const before = raw
    .prepare('PRAGMA table_info(workonce)')
    .all()
    .map((row) => row.name);
  raw.close();
  let failure;
  try {
    createSqliteStore(path);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error, 'old development schema must not be silently adopted');
  const reopened = new DatabaseSync(path);
  try {
    const after = reopened
      .prepare('PRAGMA table_info(workonce)')
      .all()
      .map((row) => row.name);
    assert.deepEqual(after, before);
    assert.deepEqual(after, ['id', 'body']);
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('native CAS retries proven compare-miss contention only after a fresh read', async () => {
  const f = casFixture({ falseWrites: 2, maxConflicts: 5 });
  const q = createWorkOnce({ store: f.store, scope: 'cas-contention' }).define('job');
  const snapshot = await q.ensure(null, { key: 'x' });
  assert.equal(snapshot.phase.state, 'queued');
  assert.equal(f.compareCalls(), 3);
  assert.ok((await f.native.getMany([snapshot.id])).rows[0]);
});

test('native CAS bounded contention exhaustion is exact and leaves no caller write', async () => {
  const f = casFixture({ falseWrites: 100, maxConflicts: 3 });
  const q = createWorkOnce({ store: f.store, scope: 'cas-exhaustion' }).define('job');
  await assert.rejects(
    q.ensure(null, { key: 'x' }),
    /Work store remained contended; retry the command, not the external effect/,
  );
  assert.equal(f.compareCalls(), 3);
  const rows = await f.native.query({ scope: 'cas-exhaustion', select: 'all', limit: 10 });
  assert.equal(rows.rows.length, 0);
});

test('native CAS unknown acknowledgement propagates and is never retried blindly', async () => {
  const f = casFixture();
  let throwAfterCommit = true;
  let calls = 0;
  const port = {
    ...f.port,
    async compareExchange(change) {
      calls++;
      const committed = await f.port.compareExchange(change);
      if (throwAfterCommit) {
        throwAfterCommit = false;
        throw new Error('unknown acknowledgement');
      }
      return committed;
    },
  };
  const store = createCompareExchangeStore(port, { maxConflicts: 5 });
  const q = createWorkOnce({ store, scope: 'cas-unknown' }).define('job');
  await assert.rejects(q.ensure(null, { key: 'x' }), /unknown acknowledgement/);
  assert.equal(calls, 1, 'unknown outcome must not enter compare-miss retry loop');
  const rows = await f.native.query({ scope: 'cas-unknown', select: 'all', limit: 10 });
  assert.equal(rows.rows.length, 1, 'the first native write really did commit');
  const replay = await q.ensure(null, { key: 'x' });
  assert.equal(replay.phase.state, 'queued');
  assert.equal(calls, 1, 'idempotent replay reads existing truth and needs no new compareExchange');
});
