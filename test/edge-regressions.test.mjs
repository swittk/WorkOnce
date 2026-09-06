import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      await current.enqueue(null, { key: 'current' });
      assert.equal((await current.claim({ workerId: 'new', limit: 1 })).length, 1);
      const names = ['Z', 'é', '😀', '☀', 'a'];
      const q = work.define('unicode');
      for (const key of names) await q.enqueue(null, { key });
      const rows = (
        await store.query({ scope: 'scope', kind: 'unicode', select: 'all', limit: 100 })
      ).rows;
      const expected = rows.map((row) => row.id).sort();
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
