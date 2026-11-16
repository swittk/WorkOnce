import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkOnce } from '../dist/index.js';
import { runExternalAvailable } from '../dist/external.js';
import { createMemoryStore } from '../dist/memory.js';
import { createSqliteStore } from '../dist/sqlite.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('managed local worker may settle after takeover time while its fence is still current', async () => {
  const queue = createWorkOnce({ store: createMemoryStore(), scope: 'local-takeover' }).define(
    'task',
    {
      leaseMode: 'takeover-fenced',
      limits: { leaseMs: 1, maxElapsedMs: 500 },
      perform: async (run) => {
        await delay(20);
        assert.equal(
          run.signal.aborted,
          false,
          'takeover eligibility is not proven ownership loss',
        );
        return run.succeed();
      },
    },
  );
  await queue.ensure(null, { key: 'job' });
  const results = await queue.runAvailable({ workerId: 'local' });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'settled');
  assert.equal((await queue.inspect('job')).phase.state, 'succeeded');
});

test('external worker receives persisted lease mode and may report after takeover time', async () => {
  const queue = createWorkOnce({ store: createMemoryStore(), scope: 'external-takeover' }).define(
    'task',
    { leaseMode: 'takeover-fenced', limits: { leaseMs: 1, maxElapsedMs: 500 } },
  );
  await queue.ensure(null, { key: 'job' });
  const service = queue.serveExternal({
    prepare: (run) => run.handoff({ workId: run.ref.workId }),
    onPrepareError: (run) => run.fail('prepare_error'),
  });
  const controller = new AbortController();
  const results = await runExternalAvailable(
    service,
    { workerId: 'external', signal: controller.signal },
    async (run, input) => {
      assert.equal(run.leaseMode, 'takeover-fenced');
      assert.equal(input.workId, run.attempt.workId);
      await delay(20);
      assert.equal(run.signal.aborted, false);
      return run.succeed();
    },
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'settled');
  assert.equal((await queue.inspect('job')).phase.state, 'succeeded');
});

test('two independent SQLite connections serialize a late completion versus reclaim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-takeover-'));
  let clock = 100;
  const path = join(dir, 'work.sqlite');
  const aStore = createSqliteStore(path, { now: () => clock });
  const bStore = createSqliteStore(path, { now: () => clock });
  try {
    const definition = { leaseMode: 'takeover-fenced', limits: { leaseMs: 10 } };
    const a = createWorkOnce({ store: aStore, scope: 'two-connections' }).define(
      'task',
      definition,
    );
    const b = createWorkOnce({ store: bStore, scope: 'two-connections' }).define(
      'task',
      definition,
    );
    await a.ensure(null, { key: 'job' });
    const [old] = await a.claim({ workerId: 'A' });
    assert.ok(old);
    clock += 10;
    const [done, replacement] = await Promise.allSettled([
      old.settle(old.succeed()),
      b.claim({ workerId: 'B' }),
    ]);
    assert.equal(replacement.status, 'fulfilled');
    if (replacement.status === 'fulfilled') {
      if (replacement.value.length) {
        assert.equal(done.status, 'rejected');
        assert.equal(done.reason.code, 'stale_attempt');
        await replacement.value[0].settle(replacement.value[0].succeed());
      } else {
        assert.equal(done.status, 'fulfilled');
      }
    }
    assert.equal((await a.inspect('job')).phase.state, 'succeeded');
  } finally {
    aStore.close();
    bStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takeover-fenced renewal respects the generation wall-time budget', async () => {
  let clock = 1000;
  const queue = createWorkOnce({
    store: createMemoryStore({ now: () => clock }),
    scope: 'elapsed-takeover',
  }).define('task', {
    leaseMode: 'takeover-fenced',
    limits: { leaseMs: 5, maxElapsedMs: 10 },
  });
  await queue.ensure(null, { key: 'job' });
  const [run] = await queue.claim({ workerId: 'owner' });
  clock += 10;
  await assert.rejects(run.heartbeat(), (err) => err?.code === 'lease_expired');
  // Losing the right to extend a generation does not silently revoke an owner.
  assert.equal((await run.settle(run.succeed())).state, 'succeeded');
});

test('takeover mode is immutable in the stored row and cannot silently migrate work', async () => {
  const store = createMemoryStore();
  const work = createWorkOnce({ store, scope: 'immutable-mode' });
  const a = work.define('task', { leaseMode: 'takeover-fenced' });
  const strict = work.define('task', { leaseMode: 'commit-deadline' });
  const first = await a.ensure(null, { key: 'job' });
  await assert.rejects(
    strict.claim({ workerId: 'wrong-mode' }),
    (err) => err?.code === 'definition_changed',
  );
  await assert.rejects(
    store.atomic(first.id, (current) => ({
      next: { ...current, revision: current.revision + 1, leaseMode: 'commit-deadline' },
      value: null,
    })),
    /changed persisted lease mode/u,
  );
  assert.equal((await a.inspect('job')).leaseMode, 'takeover-fenced');
});
