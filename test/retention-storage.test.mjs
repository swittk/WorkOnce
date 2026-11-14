import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCompareExchangeStore } from '../dist/cas.js';
import { createWorkOnce } from '../dist/index.js';
import { createRecord, dueAt, expiresAt } from '../dist/kernel.js';
import { createMemoryStore } from '../dist/memory.js';
import { createSqliteStore } from '../dist/sqlite.js';

function createCasHarness(initialNow = 100) {
  let now = initialNow;
  let beforeDelete;
  const native = createMemoryStore({ now: () => now });
  const port = {
    retention: true,
    getMany: (ids) => native.getMany(ids),
    query: (query) => native.query(query),
    compareExchange: (change) =>
      native.atomic(change.id, (row, clock) => {
        if (
          row?.revision !== change.expectedRevision ||
          row?.incarnation !== change.expectedIncarnation ||
          (change.validUntil !== undefined && clock >= change.validUntil)
        )
          return { value: false };
        return { next: change.next, value: true };
      }),
    async deleteExchange(change) {
      if (beforeDelete) {
        const hook = beforeDelete;
        beforeDelete = undefined;
        await hook(change);
      }
      return native.atomic(change.id, (row, clock) => {
        if (
          row?.revision !== change.expectedRevision ||
          row?.incarnation !== change.expectedIncarnation ||
          clock < change.expiredAt
        )
          return { value: false };
        return { delete: true, value: true };
      });
    },
  };
  return {
    native,
    port,
    store: createCompareExchangeStore(port),
    now: () => now,
    setNow(value) {
      now = value;
    },
    beforeDelete(hook) {
      beforeDelete = hook;
    },
  };
}

function fixture(kind) {
  let now = 100;
  if (kind === 'memory') {
    return {
      store: createMemoryStore({ now: () => now }),
      setNow(value) {
        now = value;
      },
      close() {},
    };
  }
  if (kind === 'cas') {
    const harness = createCasHarness(now);
    return {
      ...harness,
      close() {},
    };
  }
  const directory = mkdtempSync(join(tmpdir(), 'workonce-retention-storage-'));
  const store = createSqliteStore(join(directory, 'queue.sqlite'), { now: () => now });
  return {
    store,
    setNow(value) {
      now = value;
    },
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function succeed(queue, key, options = {}) {
  const snapshot = await queue.ensure(null, { key, ...options });
  const [run] = await queue.claim({ workerId: `worker-${key}` });
  assert.ok(run, `expected ${key} to be claimable`);
  await run.settle(run.succeed());
  return snapshot;
}

for (const kind of ['memory', 'sqlite', 'cas']) {
  test(`${kind}: expiry query is bounded, deadline ordered, and inclusive at clock equality`, async () => {
    const f = fixture(kind);
    try {
      assert.equal(f.store.retention, true);
      const work = createWorkOnce({ store: f.store, scope: `expiry-${kind}` });
      const queue = work.define('job');

      f.setNow(100);
      const late = await succeed(queue, 'late', { retention: { afterTerminalMs: 20 } });
      const sameB = await succeed(queue, 'same-b', { retention: { afterTerminalMs: 15 } });
      const sameA = await succeed(queue, 'same-a', { retention: { afterTerminalMs: 15 } });
      await succeed(queue, 'forever');
      await queue.ensure(null, { key: 'active', retention: { afterTerminalMs: 0 } });

      f.setNow(114);
      assert.deepEqual(
        (await f.store.query({ scope: `expiry-${kind}`, select: 'expired', limit: 10 })).rows,
        [],
      );
      f.setNow(115);
      const equal = await f.store.query({
        scope: `expiry-${kind}`,
        kind: 'job',
        definition: '1',
        select: 'expired',
        limit: 1,
      });
      const sameIds = [sameA.id, sameB.id].sort();
      assert.deepEqual(
        equal.rows.map((row) => row.id),
        sameIds.slice(0, 1),
      );
      await assert.rejects(
        f.store.query({
          scope: `expiry-${kind}`,
          select: 'expired',
          limit: 1,
          afterId: equal.rows[0].id,
        }),
        /afterId is not supported for expired queries/,
      );
      assert.equal(await queue.prune({ limit: 1 }), 1, 'one bounded pass removes at most one row');
      assert.equal(
        await queue.prune({ limit: 1 }),
        1,
        'the equal-deadline sibling remains visible',
      );
      assert.ok(await queue.inspect('late'));
      f.setNow(119);
      assert.equal(await queue.prune(), 0);
      f.setNow(120);
      assert.equal(await queue.prune(), 1);
      assert.equal(await queue.inspect('late'), undefined);
      assert.ok(await queue.inspect('forever'));
      assert.ok(await queue.inspect('active'));
      assert.equal(late.retention.afterTerminalMs, 20);
    } finally {
      f.close();
    }
  });

  test(`${kind}: immediate retention waits for the durable outbox to drain`, async () => {
    const f = fixture(kind);
    try {
      const work = createWorkOnce({ store: f.store, scope: `outbox-${kind}` });
      const parent = work.define('parent', { retention: { afterTerminalMs: 0 } });
      const child = work.define('child');
      await parent.ensure(null, { key: 'p' });
      const [run] = await parent.claim({ workerId: 'parent-worker' });
      assert.ok(run);
      await run.settle(run.succeed(null, { next: [child.request(null, { key: 'c' })] }));

      const stored = (await f.store.getMany([run.ref.workId])).rows[0];
      assert.equal(stored.outbox.length, 1);
      assert.equal(expiresAt(stored), undefined);
      assert.equal(await work.prune(), 0);
      assert.equal(await work.dispatch(), 1);
      assert.equal((await parent.inspect('p')).pendingFollowups, 0);
      assert.equal(await work.prune(), 1);
      assert.equal(await parent.inspect('p'), undefined);
      assert.ok(await child.inspect('c'));
    } finally {
      f.close();
    }
  });
}

test('CAS delete compares incarnation as well as revision across delete/recreate ABA', async () => {
  const f = createCasHarness(100);
  const work = createWorkOnce({ store: f.store, scope: 'cas-delete-aba' });
  const queue = work.define('job', { retention: { afterTerminalMs: 0 } });
  const original = await succeed(queue, 'same-key');
  const originalRow = (await f.native.getMany([original.id])).rows[0];
  const replacementIncarnation = 'b'.repeat(32);
  let compared;

  f.beforeDelete(async (change) => {
    compared = change;
    await f.native.atomic(original.id, () => ({ delete: true, value: null }));
    const replacement = {
      ...originalRow,
      incarnation: replacementIncarnation,
      revision: 1,
      ...(originalRow.receipt
        ? {
            receipt: {
              ...originalRow.receipt,
              attempt: { ...originalRow.receipt.attempt, incarnation: replacementIncarnation },
            },
          }
        : {}),
    };
    await f.native.atomic(original.id, () => ({ next: replacement, value: null }));
    while ((await f.native.getMany([original.id])).rows[0].revision < originalRow.revision) {
      await f.native.atomic(original.id, (row) => ({
        next: { ...row, revision: row.revision + 1 },
        value: null,
      }));
    }
  });

  assert.equal(await queue.prune(), 0, 'stale candidate must not delete the recreated incarnation');
  const after = (await f.native.getMany([original.id])).rows[0];
  assert.equal(after.revision, originalRow.revision, 'the ABA deliberately reused the revision');
  assert.equal(after.incarnation, replacementIncarnation);
  assert.equal(compared.expectedRevision, originalRow.revision);
  assert.equal(compared.expectedIncarnation, original.incarnation);
  assert.equal(await queue.prune(), 1, 'a fresh candidate may delete the replacement itself');
});

test('CAS native delete rechecks storage time when the clock rolls back after discovery', async () => {
  const f = createCasHarness(100);
  const work = createWorkOnce({ store: f.store, scope: 'cas-delete-clock' });
  const queue = work.define('job', { retention: { afterTerminalMs: 0 } });
  const snapshot = await succeed(queue, 'clock');
  f.beforeDelete(async (change) => {
    assert.equal(change.expiredAt, 100);
    f.setNow(99);
  });
  assert.equal(await queue.prune(), 0);
  assert.ok((await f.native.getMany([snapshot.id])).rows[0]);
  f.setNow(100);
  assert.equal(await queue.prune(), 1);
});

test('SQLite upgrades only the exact published schema and preserves existing permanent rows', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-retention-upgrade-'));
  const path = join(directory, 'queue.sqlite');
  const source = createMemoryStore({ now: () => 100 });
  const snapshot = await createWorkOnce({ store: source, scope: 'published' })
    .define('job')
    .ensure({ value: 1 }, { key: 'kept' });
  const record = (await source.getMany([snapshot.id])).rows[0];
  let raw = new DatabaseSync(path);
  let store;
  try {
    raw.exec(`CREATE TABLE workonce (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, definition TEXT NOT NULL,
      due_at INTEGER, pending_next INTEGER NOT NULL, body TEXT NOT NULL
    )`);
    raw
      .prepare(
        `INSERT INTO workonce(id,scope,kind,definition,due_at,pending_next,body)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        record.id,
        record.scope,
        record.kind,
        record.definition,
        dueAt(record) ?? null,
        record.outbox.length,
        JSON.stringify(record),
      );
    raw.close();
    raw = undefined;

    store = createSqliteStore(path, { now: () => 100 });
    assert.deepEqual((await store.getMany([record.id])).rows[0], record);
    store.close();
    store = undefined;

    raw = new DatabaseSync(path);
    const expiryColumn = raw
      .prepare('PRAGMA table_info(workonce)')
      .all()
      .find((column) => column.name === 'expires_at');
    assert.ok(expiryColumn);
    assert.equal(expiryColumn.notnull, 0);
    assert.equal(
      raw.prepare('SELECT expires_at FROM workonce WHERE id=?').get(record.id).expires_at,
      null,
    );
    const indexes = raw
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='workonce'")
      .all()
      .map((row) => row.name);
    assert.ok(indexes.includes('workonce_expired_scope'));
    assert.ok(indexes.includes('workonce_expired_definition'));
  } finally {
    store?.close();
    raw?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite pruning physically removes rows and remains at zero storage across key reuse', async () => {
  let now = 100;
  const database = new DatabaseSync(':memory:');
  const store = createSqliteStore(database, { now: () => now });
  try {
    const queue = createWorkOnce({ store, scope: 'physical-delete' }).define('job', {
      retention: { afterTerminalMs: 0 },
    });
    const incarnations = new Set();
    for (let cycle = 0; cycle < 20; cycle++) {
      const snapshot = await succeed(queue, 'reused');
      incarnations.add(snapshot.incarnation);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM workonce').get().count, 1);
      assert.equal(await queue.prune(), 1);
      assert.equal(await queue.inspect('reused'), undefined);
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM workonce').get().count,
        0,
        'physical deletion must not leave a tombstone or accumulate one row per incarnation',
      );
      now++;
    }
    assert.equal(incarnations.size, 20);

    const permanent = createWorkOnce({ store, scope: 'physical-delete' }).define('permanent');
    await succeed(permanent, 'kept');
    assert.equal(await queue.prune(), 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM workonce').get().count, 1);
  } finally {
    store.close();
    database.close();
  }
});

test('delete is never downgraded to a no-write on a permanent-only CAS port', async () => {
  const native = createMemoryStore({ now: () => 100 });
  const store = createCompareExchangeStore({
    getMany: (ids) => native.getMany(ids),
    query: (query) => native.query(query),
    compareExchange: (change) =>
      native.atomic(change.id, (row) => {
        if (row?.revision !== change.expectedRevision) return { value: false };
        return { next: change.next, value: true };
      }),
  });
  assert.equal(store.retention, undefined);
  await assert.rejects(
    store.atomic('missing', () => ({ delete: true, value: null })),
    (error) => error?.code === 'retention_unsupported',
  );
});

test('legacy CAS port cannot mutate finite work created by a retention-capable deployment', async () => {
  const harness = createCasHarness();
  let writes = 0;
  const legacy = createCompareExchangeStore({
    getMany: harness.port.getMany,
    query: harness.port.query,
    compareExchange(change) {
      writes++;
      return harness.port.compareExchange(change);
    },
  });
  const capableQueue = createWorkOnce({ store: harness.store, scope: 'rolling-upgrade' }).define(
    'job',
    { retention: { afterTerminalMs: 0 } },
  );
  const saved = await capableQueue.ensure(null, { key: 'existing' });
  const legacyQueue = createWorkOnce({ store: legacy, scope: 'rolling-upgrade' }).define('job');
  await assert.rejects(legacyQueue.claim({ workerId: 'old-port' }), {
    code: 'retention_unsupported',
  });
  assert.equal(writes, 0, 'a port without incarnation fencing must never receive the mutation');
  assert.equal((await capableQueue.inspect('existing')).phase.state, 'queued');
  assert.equal((await capableQueue.inspect('existing')).incarnation, saved.incarnation);

  const request = capableQueue.request(null, { key: 'new' });
  await assert.rejects(
    legacy.atomic(request.id, (_, now) => ({
      next: createRecord(request, now, 'new-creation'),
      value: null,
    })),
    { code: 'retention_unsupported' },
  );
  assert.equal(writes, 0);
  assert.equal(await capableQueue.inspect('new'), undefined);
});
