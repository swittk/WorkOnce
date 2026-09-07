import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
import { createSqliteStore } from '../dist/sqlite.js';

for (const kind of ['memory', 'sqlite'])
  test(kind + ': version-filtered claims and Unicode identity order agree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workonce-order-'));
    const store =
      kind === 'sqlite' ? createSqliteStore(join(dir, 'test.sqlite')) : createMemoryStore();
    try {
      const work = createWorkOnce({ store, scope: 'scope' });
      const old = work.define('job', { version: 'old' });
      const current = work.define('job', { version: 'new' });
      for (let i = 0; i < 10; i++) await old.enqueue(null, { key: String(i) });
      const currentSnapshot = await current.enqueue(null, { key: 'current' });
      const [currentClaim] = await current.claim({ workerId: 'new', limit: 1 });
      assert.equal(currentClaim.ref.workId, currentSnapshot.id);
      const names = ['Z', 'é', '😀', '☀', 'a', '\uE000', '𐀀'];
      const q = work.define('unicode');
      for (const key of names) await q.enqueue(null, { key });
      const rows = (
        await store.query({ scope: 'scope', kind: 'unicode', select: 'all', limit: 100 })
      ).rows;
      const expected = rows
        .map((row) => row.id)
        .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
      assert.deepEqual(
        rows.map((row) => row.id),
        expected,
      );
      const page = await store.query({
        scope: 'scope',
        kind: 'unicode',
        select: 'all',
        afterId: expected[1],
        limit: 100,
      });
      assert.deepEqual(
        page.rows.map((row) => row.id),
        expected.slice(2),
      );
    } finally {
      store.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

for (const kind of ['memory', 'sqlite'])
  test(
    kind + ': due queries reject the id-only cursor used by differently ordered views',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'workonce-due-cursor-'));
      const store =
        kind === 'sqlite' ? createSqliteStore(join(dir, 'test.sqlite')) : createMemoryStore();
      try {
        await assert.rejects(
          store.query({
            scope: 'scope',
            kind: 'job',
            select: 'due',
            afterId: 'cursor',
            limit: 1,
          }),
          /afterId is not supported for due queries/,
        );
      } finally {
        store.close?.();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

test('sqlite upgrades the pre-definition table and preserves old work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-upgrade-'));
  const databasePath = join(dir, 'test.sqlite');
  const memory = createMemoryStore({ now: () => 1000 });
  const legacyQueue = createWorkOnce({ store: memory, scope: 'legacy' }).define('job', {
    version: 'legacy-v1',
  });
  const snapshot = await legacyQueue.enqueue({ value: 1 }, { key: 'x' });
  const [row] = (await memory.getMany([snapshot.id])).rows;
  assert.ok(row);
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`CREATE TABLE workonce (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL,
      due_at INTEGER, pending_next INTEGER NOT NULL, body TEXT NOT NULL
    );`);
    db.prepare(
      'INSERT INTO workonce(id,scope,kind,due_at,pending_next,body) VALUES (?,?,?,?,?,?)',
    ).run(
      row.id,
      row.scope,
      row.kind,
      row.phase.availableAt,
      row.outbox.length,
      JSON.stringify(row),
    );
  } finally {
    db.close();
  }
  const store = createSqliteStore(databasePath);
  try {
    const restored = (await store.getMany([snapshot.id])).rows[0];
    assert.equal(restored?.definition, 'legacy-v1');
    const queried = await store.query({
      scope: 'legacy',
      kind: 'job',
      definition: 'legacy-v1',
      select: 'all',
      limit: 1,
    });
    assert.equal(queried.rows[0]?.id, snapshot.id);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sqlite rejects a legacy row whose definition cannot be restored as a string', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-legacy-corrupt-'));
  const databasePath = join(dir, 'test.sqlite');
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`CREATE TABLE workonce (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL,
      due_at INTEGER, pending_next INTEGER NOT NULL, body TEXT NOT NULL
    );`);
    db.prepare(
      'INSERT INTO workonce(id,scope,kind,due_at,pending_next,body) VALUES (?,?,?,?,?,?)',
    ).run('bad', 'legacy', 'job', 0, 0, JSON.stringify({ definition: 42 }));
  } finally {
    db.close();
  }
  try {
    assert.throws(() => createSqliteStore(databasePath), /Invalid persisted WorkOnce row/);
    const inspect = new DatabaseSync(databasePath);
    try {
      const columns = inspect
        .prepare('PRAGMA table_info(workonce)')
        .all()
        .map((row) => row.name);
      assert.equal(columns.includes('definition'), false);
    } finally {
      inspect.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sqlite validates restored rows and keeps definition in the due/list indexes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-corrupt-'));
  const databasePath = join(dir, 'test.sqlite');
  let store = createSqliteStore(databasePath);
  try {
    const q = createWorkOnce({ store, scope: 't' }).define('job', { version: 'v2' });
    const snapshot = await q.enqueue(null, { key: 'x' });
    store.close();
    const db = new DatabaseSync(databasePath);
    try {
      const dueColumns = db
        .prepare("PRAGMA index_info('workonce_due_v2')")
        .all()
        .map((row) => row.name);
      const listColumns = db
        .prepare("PRAGMA index_info('workonce_list_v2')")
        .all()
        .map((row) => row.name);
      assert.ok(dueColumns.includes('definition'));
      assert.ok(listColumns.includes('definition'));
      db.prepare('UPDATE workonce SET body=? WHERE id=?').run('{}', snapshot.id);
    } finally {
      db.close();
    }
    store = createSqliteStore(databasePath);
    await assert.rejects(store.getMany([snapshot.id]), /Invalid persisted WorkOnce row/);
  } finally {
    try {
      store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sqlite rejects a persisted request whose input property is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-missing-input-'));
  const databasePath = join(dir, 'test.sqlite');
  let store = createSqliteStore(databasePath);
  try {
    const queue = createWorkOnce({ store, scope: 'missing-input' }).define('job');
    const snapshot = await queue.ensure({ payload: 7 }, { key: 'x' });
    store.close();
    const db = new DatabaseSync(databasePath);
    try {
      const raw = db.prepare('SELECT body FROM workonce WHERE id=?').get(snapshot.id);
      const body = JSON.parse(raw.body);
      delete body.input;
      db.prepare('UPDATE workonce SET body=? WHERE id=?').run(JSON.stringify(body), snapshot.id);
    } finally {
      db.close();
    }
    store = createSqliteStore(databasePath);
    await assert.rejects(store.getMany([snapshot.id]), /Invalid persisted WorkOnce row/);
  } finally {
    try {
      store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sqlite rejects non-finite persisted payload numbers during hydration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-nonfinite-payload-'));
  const databasePath = join(dir, 'test.sqlite');
  let store = createSqliteStore(databasePath);
  try {
    const queue = createWorkOnce({ store, scope: 'nonfinite-payload' }).define('job');
    const snapshot = await queue.ensure({ value: 1 }, { key: 'x' });
    store.close();

    const db = new DatabaseSync(databasePath);
    try {
      const raw = db.prepare('SELECT body FROM workonce WHERE id=?').get(snapshot.id);
      const body = String(raw.body).replace('\"value\":1', '\"value\":1e400');
      db.prepare('UPDATE workonce SET body=? WHERE id=?').run(body, snapshot.id);
    } finally {
      db.close();
    }

    store = createSqliteStore(databasePath);
    await assert.rejects(store.getMany([snapshot.id]), /Invalid persisted WorkOnce row/);
  } finally {
    try {
      store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sqlite rejects pending follow-ups on a nonterminal persisted parent before dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-corrupt-outbox-'));
  const databasePath = join(dir, 'test.sqlite');
  let store = createSqliteStore(databasePath);
  try {
    let work = createWorkOnce({ store, scope: 'outbox-corrupt' });
    let parent = work.define('parent');
    let child = work.define('child');
    const snapshot = await parent.ensure(null, { key: 'p' });
    const childRequest = child.request({ payload: 1 }, { key: 'c' });
    store.close();

    const db = new DatabaseSync(databasePath);
    try {
      const raw = db.prepare('SELECT body FROM workonce WHERE id=?').get(snapshot.id);
      const body = JSON.parse(raw.body);
      assert.equal(body.phase.state, 'queued');
      body.outbox = [childRequest];
      db.prepare('UPDATE workonce SET body=?, pending_next=1 WHERE id=?').run(
        JSON.stringify(body),
        snapshot.id,
      );
    } finally {
      db.close();
    }

    store = createSqliteStore(databasePath);
    work = createWorkOnce({ store, scope: 'outbox-corrupt' });
    child = work.define('child');
    await assert.rejects(work.dispatch(), /Invalid persisted WorkOnce row/);
    assert.equal(await child.inspect('c'), undefined);
  } finally {
    try {
      store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sqlite rejects a persisted settlement receipt bound to another item or generation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-corrupt-receipt-'));
  const databasePath = join(dir, 'test.sqlite');
  let store = createSqliteStore(databasePath);
  try {
    const queue = createWorkOnce({ store, scope: 'receipt-corrupt' }).define('job', {
      limits: { leaseMs: 1000 },
    });
    await queue.ensure(null, { key: 'x' });
    const [run] = await queue.claim({ workerId: 'A' });
    await run.settle(run.wait('pending'));
    store.close();

    const db = new DatabaseSync(databasePath);
    try {
      const raw = db.prepare('SELECT body FROM workonce WHERE id=?').get(run.ref.workId);
      const body = JSON.parse(raw.body);
      body.receipt.attempt.workId = 'different-work-id';
      body.receipt.attempt.generation = run.ref.generation + 1;
      db.prepare('UPDATE workonce SET body=? WHERE id=?').run(JSON.stringify(body), run.ref.workId);
    } finally {
      db.close();
    }

    store = createSqliteStore(databasePath);
    await assert.rejects(store.getMany([run.ref.workId]), /Invalid persisted WorkOnce row/);
  } finally {
    try {
      store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an impossible duration is rejected before storing an unclaimable job', async () => {
  const q = createWorkOnce({ store: createMemoryStore({ now: () => 1000 }), scope: 't' }).define(
    'job',
  );
  await assert.rejects(
    q.enqueue(null, { key: 'overflow', limits: { leaseMs: Number.MAX_SAFE_INTEGER } }),
    RangeError,
  );
  assert.equal(await q.inspect('overflow'), undefined);
});
test('a permanently conflicting child cannot starve its sibling even with limit one', async () => {
  const work = createWorkOnce({ store: createMemoryStore(), scope: 't' }),
    q = work.define('parent'),
    child = work.define('child');
  await child.enqueue({ original: true }, { key: 'conflict' });
  await q.enqueue(null, { key: 'parent' });
  const [run] = await q.claim({ workerId: 'A' });
  await run.settle(
    run.succeed(null, {
      next: [
        child.request({ wrong: true }, { key: 'conflict' }),
        child.request(null, { key: 'healthy' }),
      ],
    }),
  );
  await assert.rejects(work.dispatch({ limit: 1 }), (error) => error.code === 'key_conflict');
  assert.equal(await work.dispatch({ limit: 1 }), 1);
  assert.ok(await child.inspect('healthy'));
  assert.equal((await q.inspect('parent')).pendingFollowups, 1);
});
test('a rejecting claim-poll observer still drains active claims before run rejects', async () => {
  const base = createMemoryStore();
  let queryCalls = 0;
  const store = {
    atomic: (...args) => base.atomic(...args),
    getMany: (...args) => base.getMany(...args),
    async query(...args) {
      queryCalls++;
      if (queryCalls > 1) throw new Error('claim poll failed');
      return base.query(...args);
    },
  };
  const q = createWorkOnce({ store, scope: 't' }).define('job');
  await q.enqueue(null, { key: 'one' });
  const stop = new AbortController();
  let handlerFinished = false;
  await assert.rejects(
    q.run(
      {
        workerId: 'A',
        concurrency: 2,
        signal: stop.signal,
        onError: async () => {
          throw new Error('observer failed');
        },
      },
      async (run) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        handlerFinished = true;
        return run.succeed();
      },
    ),
    /observer failed/,
  );
  assert.equal(handlerFinished, true);
  assert.equal((await q.inspect('one')).phase.state, 'succeeded');
  stop.abort();
});

test('async runner error observers are awaited instead of leaking rejection', async () => {
  const work = createWorkOnce({ store: createMemoryStore(), scope: 't' }),
    q = work.define('job');
  await q.enqueue(null, { key: 'one' });
  const stop = new AbortController();
  await assert.rejects(
    q.run(
      {
        workerId: 'A',
        signal: stop.signal,
        onError: async () => {
          throw new Error('observer failed');
        },
      },
      async () => {
        throw new Error('handler failed');
      },
    ),
    /observer failed/,
  );
  stop.abort();
});
