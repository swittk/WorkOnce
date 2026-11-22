import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
import { createSqliteStore } from '../dist/sqlite.js';
import { createCompareExchangeStore } from '../dist/cas.js';
import { dueAt, expiresAt } from '../dist/kernel.js';
import {
  assertRetentionRefinementSamples,
  runRetentionRefinementSamples,
} from '../scripts/retention-refinement.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function jsonCopy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

test('retention refinement rejects an omitted proof observation', async () => {
  const samples = await runRetentionRefinementSamples();
  const mutant = samples.map((sample) => {
    if (sample.kind !== 'boundary' || sample.adapter !== 'memory') return sample;
    const { finiteHeldBefore: _missing, ...rest } = sample;
    return rest;
  });
  assert.throws(
    () => assertRetentionRefinementSamples(mutant),
    /boundary evidence fields drifted/u,
  );
});

async function terminal(queue, key, outcome = 'succeed') {
  await queue.ensure(null, { key });
  const [run] = await queue.claim({ workerId: `worker-${key}` });
  assert.ok(run);
  if (outcome === 'succeed') await run.settle(run.succeed());
  else if (outcome === 'fail') await run.settle(run.fail('terminal'));
  else throw new Error(`unknown terminal outcome ${outcome}`);
  return run;
}

for (const adapter of ['memory', 'sqlite'])
  test(`${adapter}: zero, finite and forever retention use exact storage-time boundaries`, async () => {
    const directory = mkdtempSync(join(tmpdir(), `workonce-retention-${adapter}-`));
    let now = 100;
    const store =
      adapter === 'memory'
        ? createMemoryStore({ now: () => now })
        : createSqliteStore(join(directory, 'queue.sqlite'), { now: () => now });
    try {
      const work = createWorkOnce({ store, scope: 'boundaries' });
      const immediate = work.define('immediate', { retention: { afterTerminalMs: 0 } });
      const zero = await immediate.ensure(null, { key: 'zero' });
      assert.match(zero.incarnation, /^[0-9a-f]{32}$/u);
      assert.deepEqual(zero.retention, { afterTerminalMs: 0 });
      const [zeroRun] = await immediate.claim({ workerId: 'zero' });
      await zeroRun.settle(zeroRun.succeed());
      assert.equal(await immediate.prune(), 1, 'zero retention expires at terminal-time equality');
      assert.equal(await immediate.inspect('zero'), undefined);
      assert.equal(
        (await store.getMany([zero.id])).rows[0],
        undefined,
        'the row is physically absent',
      );

      const finite = work.define('finite', { retention: { afterTerminalMs: 5 } });
      await terminal(finite, 'finite');
      now = 104;
      assert.equal(await finite.prune(), 0);
      assert.equal((await finite.inspect('finite')).phase.state, 'succeeded');
      now = 105;
      assert.equal(await finite.prune(), 1, 'finite retention expires exactly at its deadline');

      const forever = work.define('forever', { retention: 'forever' });
      const permanent = await forever.ensure(null, { key: 'permanent' });
      assert.equal(permanent.incarnation, undefined);
      assert.equal(
        permanent.retention,
        undefined,
        'explicit forever normalizes to the permanent default',
      );
      const [foreverRun] = await forever.claim({ workerId: 'forever' });
      await foreverRun.settle(foreverRun.succeed());
      now = Number.MAX_SAFE_INTEGER;
      assert.equal(await work.prune(), 0);
      assert.equal((await forever.inspect('permanent')).phase.state, 'succeeded');
    } finally {
      store.close?.();
      rmSync(directory, { recursive: true, force: true });
    }
  });

test('pruning preserves every live phase and terminal outbox, then deletes success/failure/cancel', async () => {
  let now = 500;
  const store = createMemoryStore({ now: () => now });
  const work = createWorkOnce({ store, scope: 'eligibility' });
  const queue = work.define('job', { retention: { afterTerminalMs: 0 } });
  const child = work.define('child', { retention: { afterTerminalMs: 0 } });

  await queue.ensure(null, { key: 'queued', availableAt: 20_000 });
  await queue.ensure(null, { key: 'running' });
  const [running] = await queue.claim({ workerId: 'running' });
  await queue.ensure(null, { key: 'waiting' });
  const [waiting] = await queue.claim({ workerId: 'waiting' });
  await waiting.settle(waiting.wait('dependency', { afterMs: 1000 }));

  await queue.ensure(null, { key: 'parent' });
  const [parent] = await queue.claim({ workerId: 'parent' });
  await parent.settle(
    parent.succeed(null, { next: [child.request(null, { key: 'continuation' })] }),
  );
  assert.equal((await queue.inspect('parent')).pendingFollowups, 1);
  now = 10_000;
  assert.equal(await work.prune(), 0, 'active and outbox-bearing rows are never expiry candidates');
  assert.equal((await queue.inspect('queued')).phase.state, 'queued');
  assert.equal((await queue.inspect('running')).phase.state, 'running');
  assert.equal((await queue.inspect('waiting')).phase.state, 'waiting');
  assert.equal((await queue.inspect('parent')).pendingFollowups, 1);

  assert.equal(await work.dispatch(), 1);
  assert.equal(await work.prune(), 1, 'the parent becomes eligible only after its outbox drains');
  assert.equal(await queue.inspect('parent'), undefined);
  assert.equal((await child.inspect('continuation')).phase.state, 'queued');

  await terminal(queue, 'failed', 'fail');
  await queue.ensure(null, { key: 'cancelled' });
  const cancelled = await queue.inspect('cancelled');
  await queue.cancel({
    key: 'cancelled',
    generation: cancelled.generation,
    incarnation: cancelled.incarnation,
  });
  assert.equal(await queue.prune({ limit: 2 }), 2);
  assert.equal(await queue.inspect('failed'), undefined);
  assert.equal(await queue.inspect('cancelled'), undefined);

  assert.equal((await running.heartbeat()).attempt.incarnation, running.ref.incarnation);
});

test('same-key recreation is fresh and stale attempt/manual authority cannot cross incarnation', async () => {
  const store = createMemoryStore({ now: () => 100 });
  const queue = createWorkOnce({ store, scope: 'aba' }).define('job', {
    retention: { afterTerminalMs: 0 },
  });
  const oldSnapshot = await queue.ensure(null, { key: 'same' });
  const [oldRun] = await queue.claim({ workerId: 'old' });
  const oldOutcome = oldRun.succeed();
  await oldRun.settle(oldOutcome);
  assert.equal(await queue.prune(), 1);

  const fresh = await queue.ensure(null, { key: 'same' });
  assert.notEqual(fresh.incarnation, oldSnapshot.incarnation);
  assert.equal(fresh.revision, 1);
  assert.equal(fresh.generation, 1);
  assert.equal(fresh.phase.state, 'queued');

  // Reuse the worker label and the exact numeric attempt counters: the old
  // reference must be rejected by incarnation, not by queued-state/fence checks.
  const [freshRun] = await queue.claim({ workerId: 'old' });
  assert.ok(freshRun);
  assert.equal(freshRun.ref.workId, oldRun.ref.workId);
  assert.equal(freshRun.ref.generation, oldRun.ref.generation);
  assert.equal(freshRun.ref.fence, oldRun.ref.fence);
  assert.notEqual(freshRun.ref.incarnation, oldRun.ref.incarnation);
  const beforeStale = await queue.inspect('same');
  assert.equal(beforeStale.phase.state, 'running');

  await assert.rejects(oldRun.heartbeat(), (error) => error?.code === 'stale_attempt');
  assert.deepEqual(await queue.inspect('same'), beforeStale);
  await assert.rejects(oldRun.settle(oldOutcome), (error) => error?.code === 'stale_attempt');
  assert.deepEqual(await queue.inspect('same'), beforeStale);
  await assert.rejects(
    queue.cancel({
      key: 'same',
      generation: oldSnapshot.generation,
      incarnation: oldSnapshot.incarnation,
    }),
    (error) => error?.code === 'generation_conflict',
  );
  await assert.rejects(
    queue.wake({
      key: 'same',
      generation: oldSnapshot.generation,
      revision: oldSnapshot.revision,
      incarnation: oldSnapshot.incarnation,
    }),
    (error) => error?.code === 'generation_conflict',
  );
  assert.deepEqual(await queue.inspect('same'), beforeStale);
});

test('an async manual gate cannot rerun a deleted and recreated key', async () => {
  const store = createMemoryStore({ now: () => 100 });
  const queue = createWorkOnce({ store, scope: 'manual-gate' }).define('job', {
    retention: { afterTerminalMs: 0 },
  });
  const old = await queue.ensure(null, { key: 'same' });
  const [run] = await queue.claim({ workerId: 'old' });
  await run.settle(run.succeed());

  const entered = deferred();
  const release = deferred();
  const guarded = queue.rerun({
    key: 'same',
    generation: old.generation,
    incarnation: old.incarnation,
    check: async (snapshot) => {
      assert.equal(snapshot.incarnation, old.incarnation);
      entered.resolve();
      await release.promise;
      return true;
    },
  });
  await entered.promise;
  assert.equal(await queue.prune(), 1);
  const fresh = await queue.ensure(null, { key: 'same' });
  release.resolve();
  await assert.rejects(guarded, (error) => error?.code === 'generation_conflict');
  const after = await queue.inspect('same');
  assert.equal(after.incarnation, fresh.incarnation);
  assert.equal(after.phase.state, 'queued');
  assert.equal(after.generation, 1);
});

test('a stale claim candidate cannot claim a replacement incarnation', async () => {
  const base = createMemoryStore({ now: () => 100 });
  const captured = deferred();
  const release = deferred();
  let holdFirstDueQuery = true;
  const store = {
    retention: true,
    atomic: (...args) => base.atomic(...args),
    getMany: (...args) => base.getMany(...args),
    async query(query) {
      const result = await base.query(query);
      if (query.select === 'due' && holdFirstDueQuery) {
        holdFirstDueQuery = false;
        captured.resolve();
        await release.promise;
      }
      return result;
    },
  };
  const queue = createWorkOnce({ store, scope: 'claim-aba' }).define('job', {
    retention: { afterTerminalMs: 0 },
  });
  await queue.ensure(null, { key: 'same' });
  const staleClaim = queue.claim({ workerId: 'stale' });
  await captured.promise;

  const [current] = await queue.claim({ workerId: 'current' });
  await current.settle(current.succeed());
  assert.equal(await queue.prune(), 1);
  const fresh = await queue.ensure(null, { key: 'same' });
  release.resolve();

  assert.deepEqual(await staleClaim, []);
  const after = await queue.inspect('same');
  assert.equal(after.incarnation, fresh.incarnation);
  assert.equal(after.phase.state, 'queued');
  assert.equal(after.attempts, 0);
});

test('a stale outbox scan cannot acknowledge a replacement parent', async () => {
  const base = createMemoryStore({ now: () => 100 });
  const captured = deferred();
  const release = deferred();
  let holdFirstOutboxQuery = true;
  const store = {
    retention: true,
    atomic: (...args) => base.atomic(...args),
    getMany: (...args) => base.getMany(...args),
    async query(query) {
      const result = await base.query(query);
      if (query.select === 'outbox' && holdFirstOutboxQuery) {
        holdFirstOutboxQuery = false;
        captured.resolve();
        await release.promise;
      }
      return result;
    },
  };
  const staleWork = createWorkOnce({ store, scope: 'outbox-aba' });
  const currentWork = createWorkOnce({ store, scope: 'outbox-aba' });
  const staleParent = staleWork.define('parent', { retention: { afterTerminalMs: 0 } });
  const staleChild = staleWork.define('child');
  const currentParent = currentWork.define('parent', { retention: { afterTerminalMs: 0 } });
  const currentChild = currentWork.define('child');

  const old = await staleParent.ensure(null, { key: 'same' });
  const [oldRun] = await staleParent.claim({ workerId: 'old' });
  await oldRun.settle(
    oldRun.succeed(null, { next: [staleChild.request(null, { key: 'old-child' })] }),
  );
  const staleDispatch = staleWork.dispatch();
  await captured.promise;

  assert.equal(await currentWork.dispatch(), 1);
  assert.equal(await currentParent.prune(), 1);
  const fresh = await currentParent.ensure(null, { key: 'same' });
  assert.notEqual(fresh.incarnation, old.incarnation);
  const [freshRun] = await currentParent.claim({ workerId: 'fresh' });
  await freshRun.settle(
    freshRun.succeed(null, { next: [currentChild.request(null, { key: 'fresh-child' })] }),
  );
  release.resolve();

  await assert.rejects(staleDispatch, (error) => error?.code === 'stale_attempt');
  const after = await currentParent.inspect('same');
  assert.equal(after.incarnation, fresh.incarnation);
  assert.equal(after.pendingFollowups, 1);
  assert.equal(await currentChild.inspect('fresh-child'), undefined);
});

test('finite follow-up descriptions are deterministic and replay becomes fresh after retention', async () => {
  const store = createMemoryStore({ now: () => 100 });
  const work = createWorkOnce({ store, scope: 'follow-up-retention' });
  const parent = work.define('parent');
  const child = work.define('child', { retention: { afterTerminalMs: 0 } });
  const firstDescription = child.request({ value: 1 }, { key: 'child' });
  const secondDescription = child.request({ value: 1 }, { key: 'child' });
  assert.deepEqual(firstDescription, secondDescription);
  assert.equal(Object.hasOwn(firstDescription, 'incarnation'), false);

  await parent.ensure(null, { key: 'parent' });
  const [parentRun] = await parent.claim({ workerId: 'parent' });
  const outcome = parentRun.succeed(null, { next: [firstDescription] });
  const firstAck = await parentRun.settle(outcome);
  assert.deepEqual(
    await parentRun.settle(outcome),
    firstAck,
    'same receipt replays before dispatch',
  );
  assert.equal((await parent.inspect('parent')).pendingFollowups, 1);
  assert.equal(await work.dispatch(), 1);

  const firstChild = await child.inspect('child');
  const [childRun] = await child.claim({ workerId: 'child' });
  await childRun.settle(childRun.succeed());
  assert.equal(await child.prune(), 1);
  const recreated = await child.ensure({ value: 1 }, { key: 'child' });
  assert.notEqual(recreated.incarnation, firstChild.incarnation);
  assert.equal(recreated.phase.state, 'queued');
});

test('queue pruning is kind/version limited while scope pruning remains scope limited', async () => {
  const store = createMemoryStore({ now: () => 100 });
  const scopeA = createWorkOnce({ store, scope: 'scope-a' });
  const scopeB = createWorkOnce({ store, scope: 'scope-b' });
  const aV1 = scopeA.define('job', { version: 'v1', retention: { afterTerminalMs: 0 } });
  const aV2 = scopeA.define('job', { version: 'v2', retention: { afterTerminalMs: 0 } });
  const bV1 = scopeB.define('job', { version: 'v1', retention: { afterTerminalMs: 0 } });
  await terminal(aV1, 'a-v1');
  await terminal(aV2, 'a-v2');
  await terminal(bV1, 'b-v1');

  assert.equal(await aV1.prune({ limit: 10 }), 1);
  assert.equal(await aV1.inspect('a-v1'), undefined);
  assert.equal((await aV2.inspect('a-v2')).phase.state, 'succeeded');
  assert.equal((await bV1.inspect('b-v1')).phase.state, 'succeeded');
  assert.equal(await scopeA.prune({ limit: 10 }), 1);
  assert.equal(await aV2.inspect('a-v2'), undefined);
  assert.equal((await bV1.inspect('b-v1')).phase.state, 'succeeded');
  assert.equal(await scopeB.prune({ limit: 10 }), 1);
});

test('two independent SQLite stores race to one physical prune winner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-retention-race-'));
  const path = join(directory, 'queue.sqlite');
  const firstStore = createSqliteStore(path, { now: () => 100 });
  const secondStore = createSqliteStore(path, { now: () => 100 });
  try {
    const first = createWorkOnce({ store: firstStore, scope: 'race' });
    const second = createWorkOnce({ store: secondStore, scope: 'race' });
    const firstQueue = first.define('job', { retention: { afterTerminalMs: 0 } });
    const secondQueue = second.define('job', { retention: { afterTerminalMs: 0 } });
    await terminal(firstQueue, 'same');
    const results = await Promise.all([first.prune({ limit: 1 }), second.prune({ limit: 1 })]);
    assert.equal(results[0] + results[1], 1);
    assert.equal(await firstQueue.inspect('same'), undefined);
    assert.equal(await secondQueue.inspect('same'), undefined);
  } finally {
    firstStore.close();
    secondStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CAS delete comparison includes incarnation even when a replacement has the same revision', async () => {
  const replacementStore = createMemoryStore({ now: () => 100 });
  const replacementQueue = createWorkOnce({ store: replacementStore, scope: 'cas-aba' }).define(
    'job',
    { retention: { afterTerminalMs: 0 } },
  );
  await terminal(replacementQueue, 'same');
  const replacementSnapshot = await replacementQueue.inspect('same');
  const replacementRow = (await replacementStore.getMany([replacementSnapshot.id])).rows[0];

  let stored;
  let injectReplacement = false;
  let deleteCalls = 0;
  const now = 100;
  const port = {
    retention: true,
    async getMany(ids) {
      return {
        rows: ids.map((id) => (stored?.id === id ? jsonCopy(stored) : undefined)),
        now,
      };
    },
    async query(query) {
      if (!stored || stored.scope !== query.scope || (query.kind && stored.kind !== query.kind))
        return { rows: [], now };
      if (query.definition && stored.definition !== query.definition) return { rows: [], now };
      const selected =
        query.select === 'due'
          ? dueAt(stored) !== undefined && dueAt(stored) <= now
          : query.select === 'expired'
            ? expiresAt(stored) !== undefined && expiresAt(stored) <= now
            : query.select === 'outbox'
              ? stored.outbox.length > 0
              : true;
      return { rows: selected ? [jsonCopy(stored)] : [], now };
    },
    async compareExchange(change) {
      const matches =
        change.expectedRevision === undefined
          ? stored === undefined
          : stored?.revision === change.expectedRevision &&
            stored?.incarnation === change.expectedIncarnation;
      if (!matches) return false;
      stored = jsonCopy(change.next);
      return true;
    },
    async deleteExchange(change) {
      deleteCalls++;
      if (injectReplacement) {
        injectReplacement = false;
        assert.equal(replacementRow.revision, change.expectedRevision);
        assert.notEqual(replacementRow.incarnation, change.expectedIncarnation);
        stored = jsonCopy(replacementRow);
      }
      if (
        stored?.revision !== change.expectedRevision ||
        stored?.incarnation !== change.expectedIncarnation ||
        now < change.expiredAt
      )
        return false;
      stored = undefined;
      return true;
    },
  };
  const store = createCompareExchangeStore(port);
  const queue = createWorkOnce({ store, scope: 'cas-aba' }).define('job', {
    retention: { afterTerminalMs: 0 },
  });
  await terminal(queue, 'same');
  const old = await queue.inspect('same');
  assert.equal(old.revision, replacementRow.revision);
  injectReplacement = true;
  assert.equal(await queue.prune(), 0);
  assert.equal(deleteCalls, 1);
  const after = await queue.inspect('same');
  assert.equal(after.incarnation, replacementRow.incarnation);
  assert.notEqual(after.incarnation, old.incarnation);
});

test('SQLite finite reuse reaches a bounded no-row steady state instead of accumulating tombstones', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-retention-growth-'));
  const path = join(directory, 'queue.sqlite');
  const pageCounts = [];
  try {
    for (let wave = 0; wave < 3; wave++) {
      const store = createSqliteStore(path, { now: () => 100 });
      const queue = createWorkOnce({ store, scope: 'growth' }).define('job', {
        retention: { afterTerminalMs: 0 },
      });
      for (let cycle = 0; cycle < 20; cycle++) {
        await terminal(queue, 'same');
        assert.equal(await queue.prune({ limit: 1 }), 1);
      }
      assert.equal(
        (await store.query({ scope: 'growth', select: 'all', limit: 100 })).rows.length,
        0,
      );
      store.close();
      const database = new DatabaseSync(path);
      try {
        assert.equal(database.prepare('SELECT count(*) AS count FROM workonce').get().count, 0);
        pageCounts.push(database.prepare('PRAGMA page_count').get().page_count);
      } finally {
        database.close();
      }
    }
    assert.equal(
      pageCounts[2],
      pageCounts[1],
      `SQLite page reuse did not stabilize: ${pageCounts}`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Fail only the selected atomic deletions, as a storage adapter would on an isolated
// persistence error. The other items must still reach their own atomic decisions.
for (const adapter of ['memory', 'sqlite']) {
  test(`${adapter}: pruning isolates one failed deletion and retries it on the next pass`, async () => {
    const directory = mkdtempSync(join(tmpdir(), `workonce-retention-failure-${adapter}-`));
    const backing =
      adapter === 'memory'
        ? createMemoryStore({ now: () => 100 })
        : createSqliteStore(join(directory, 'queue.sqlite'), { now: () => 100 });
    const errors = new Map();
    const attempted = [];
    let pruning = false;
    const store = {
      retention: true,
      async atomic(id, decide) {
        if (pruning) {
          attempted.push(id);
          if (errors.has(id)) throw errors.get(id);
        }
        return backing.atomic(id, decide);
      },
      getMany: (...args) => backing.getMany(...args),
      query: (...args) => backing.query(...args),
    };
    try {
      const queue = createWorkOnce({ store, scope: 'isolate-single-deletion' }).define('job', {
        retention: { afterTerminalMs: 0 },
      });
      for (const key of ['a', 'b', 'c']) await terminal(queue, key);
      const ids = Object.fromEntries(
        await Promise.all(['a', 'b', 'c'].map(async (key) => [key, (await queue.inspect(key)).id])),
      );
      const dbError = new Error('failed deleting b');
      errors.set(ids.b, dbError);
      pruning = true;
      await assert.rejects(queue.prune({ limit: 3 }), (error) => error === dbError);
      assert.deepEqual(attempted, [ids.a, ids.b, ids.c]);
      assert.equal(await queue.inspect('a'), undefined);
      assert.equal((await queue.inspect('b')).phase.state, 'succeeded');
      assert.equal(await queue.inspect('c'), undefined);

      errors.clear();
      assert.equal(await queue.prune({ limit: 3 }), 1);
      assert.equal(await queue.inspect('b'), undefined);
    } finally {
      backing.close?.();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test(`${adapter}: pruning reports every failure after deleting other eligible jobs`, async () => {
    const directory = mkdtempSync(join(tmpdir(), `workonce-retention-many-failures-${adapter}-`));
    const backing =
      adapter === 'memory'
        ? createMemoryStore({ now: () => 100 })
        : createSqliteStore(join(directory, 'queue.sqlite'), { now: () => 100 });
    const errors = new Map();
    let pruning = false;
    const store = {
      retention: true,
      async atomic(id, decide) {
        if (pruning && errors.has(id)) throw errors.get(id);
        return backing.atomic(id, decide);
      },
      getMany: (...args) => backing.getMany(...args),
      query: (...args) => backing.query(...args),
    };
    try {
      const work = createWorkOnce({ store, scope: 'isolate-multiple-deletions' });
      const queue = work.define('job', { retention: { afterTerminalMs: 0 } });
      for (const key of ['a', 'b', 'c']) await terminal(queue, key);
      const idA = (await queue.inspect('a')).id;
      const idC = (await queue.inspect('c')).id;
      const errorsInOrder = [new Error('failed a'), new Error('failed c')];
      errors.set(idA, errorsInOrder[0]);
      errors.set(idC, errorsInOrder[1]);
      pruning = true;
      await assert.rejects(work.prune({ limit: 3 }), (error) => {
        assert.equal(error.name, 'WorkRetentionError');
        assert.deepEqual(error.errors, errorsInOrder);
        return true;
      });
      assert.equal((await queue.inspect('a')).phase.state, 'succeeded');
      assert.equal(await queue.inspect('b'), undefined);
      assert.equal((await queue.inspect('c')).phase.state, 'succeeded');
      errors.clear();
      assert.equal(await work.prune({ limit: 3 }), 2);
    } finally {
      backing.close?.();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('runPruner performs an explicit bounded pass and stops on its signal', async () => {
  const base = createMemoryStore({ now: () => 100 });
  const controller = new AbortController();
  const store = {
    retention: true,
    atomic: (...args) => base.atomic(...args),
    getMany: (...args) => base.getMany(...args),
    async query(query) {
      const result = await base.query(query);
      if (query.select === 'expired') controller.abort();
      return result;
    },
  };
  const work = createWorkOnce({ store, scope: 'pruner' });
  const queue = work.define('job', { retention: { afterTerminalMs: 0 } });
  await terminal(queue, 'expired');
  await work.runPruner({ signal: controller.signal, intervalMs: 1, limit: 1 });
  assert.equal(await queue.inspect('expired'), undefined);
});

test('finite retention and pruning reject a permanent-only store explicitly', async () => {
  const base = createMemoryStore();
  const store = {
    atomic: (...args) => base.atomic(...args),
    getMany: (...args) => base.getMany(...args),
    query: (...args) => base.query(...args),
  };
  const work = createWorkOnce({ store, scope: 'unsupported' });
  const finite = work.define('job', { retention: { afterTerminalMs: 0 } });
  assert.throws(
    () => finite.request(null, { key: 'x' }),
    (error) => error?.code === 'retention_unsupported',
  );
  await assert.rejects(
    finite.ensure(null, { key: 'x' }),
    (error) => error?.code === 'retention_unsupported',
  );
  await assert.rejects(work.prune(), (error) => error?.code === 'retention_unsupported');
});

// A custom CAS deployment may be permanent-only while the same physical backend can
// later be upgraded to support indexed expiry and true deletion. The core must not
// commit any finite-child intent that the current adapter can never dispatch.
for (const adapter of ['memory', 'sqlite']) {
  test(`non-retention ${adapter} store rejects direct and planned finite children before parent terminal commit`, async () => {
    const directory = mkdtempSync(join(tmpdir(), `workonce-child-capability-${adapter}-`));
    let now = 100;
    const native =
      adapter === 'memory'
        ? createMemoryStore({ now: () => now })
        : createSqliteStore(join(directory, 'queue.sqlite'), { now: () => now });
    const permanentOnly = {
      atomic: (...args) => native.atomic(...args),
      getMany: (...args) => native.getMany(...args),
      query: (...args) => native.query(...args),
    };
    try {
      const capable = createWorkOnce({ scope: 'child-capability', store: native });
      const legacy = createWorkOnce({ scope: 'child-capability', store: permanentOnly });
      const finiteRequest = capable
        .define('finite-child', { retention: { afterTerminalMs: 0 } })
        .request(null, { key: 'child' });
      const ordinaryRequest = legacy.define('ordinary-child').request(null, { key: 'ordinary' });
      const parent = legacy.define('direct-parent');
      await parent.ensure(null, { key: 'direct' });
      const [run] = await parent.claim({ workerId: 'direct-worker' });
      const attempted = run.succeed(null, { thenDo: [finiteRequest] });
      await assert.rejects(run.settle(attempted), { code: 'retention_unsupported' });
      const blocked = await parent.inspect('direct');
      assert.equal(blocked.phase.state, 'running');
      assert.equal(blocked.pendingFollowups, 0);
      assert.equal((await native.getMany([blocked.id])).rows[0].receipt, undefined);
      assert.equal(await capable.define('finite-child').inspect('child'), undefined);
      assert.equal(await legacy.dispatch(), 0);
      // The same worker may still submit a valid permanent child before its lease expires.
      await run.settle(run.succeed(null, { next: [ordinaryRequest] }));
      assert.equal(await legacy.dispatch(), 1);
      assert.equal(
        (await legacy.define('ordinary-child').inspect('ordinary')).phase.state,
        'queued',
      );

      let planned = 0;
      const planner = legacy.define('planner-parent', {
        thenDo: () => {
          planned++;
          return [finiteRequest];
        },
      });
      await planner.ensure(null, { key: 'planned-failure' });
      const [failedRun] = await planner.claim({ workerId: 'planner-worker' });
      await assert.rejects(
        failedRun.settle(failedRun.fail('planned', { result: 'typed-result' })),
        { code: 'retention_unsupported' },
      );
      assert.equal(planned, 1, 'the callback-planned follow-up must be validated too');
      assert.equal((await planner.inspect('planned-failure')).phase.state, 'running');
      assert.equal((await planner.inspect('planned-failure')).pendingFollowups, 0);
      assert.equal(await capable.define('finite-child').inspect('child'), undefined);
    } finally {
      native.close?.();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test(`pre-existing finite-child outbox can drain after an in-place ${adapter} store capability upgrade`, async () => {
    const directory = mkdtempSync(join(tmpdir(), `workonce-child-upgrade-${adapter}-`));
    let now = 100;
    const native =
      adapter === 'memory'
        ? createMemoryStore({ now: () => now })
        : createSqliteStore(join(directory, 'queue.sqlite'), { now: () => now });
    try {
      // Simulate a parent terminal receipt written by a capable deployment, and
      // subsequently observed by an older permanent-only adapter.
      const capable = createWorkOnce({ scope: 'child-upgrade', store: native });
      const permanentOnly = createWorkOnce({
        scope: 'child-upgrade',
        store: {
          atomic: (...args) => native.atomic(...args),
          getMany: (...args) => native.getMany(...args),
          query: (...args) => native.query(...args),
        },
      });
      const child = capable.define('finite', { retention: { afterTerminalMs: 0 } });
      const parent = capable.define('parent');
      await parent.ensure(null, { key: 'persisted' });
      const [run] = await parent.claim({ workerId: 'old-creator' });
      const receipt = run.succeed(null, { next: [child.request(null, { key: 'child' })] });
      const committed = await run.settle(receipt);
      assert.equal((await parent.inspect('persisted')).pendingFollowups, 1);
      assert.deepEqual(
        await permanentOnly.define('parent').settle(run.ref, receipt),
        committed,
        'receipt replay must remain possible even if the adapter later lacks deletion capability',
      );
      await assert.rejects(permanentOnly.dispatch(), { code: 'retention_unsupported' });
      assert.equal((await parent.inspect('persisted')).pendingFollowups, 1);
      // No silent policy weakening: switch back to the retention-capable adapter.
      assert.equal(await capable.dispatch(), 1);
      assert.equal((await parent.inspect('persisted')).pendingFollowups, 0);
      const snapshot = await child.inspect('child');
      assert.deepEqual(snapshot.retention, { afterTerminalMs: 0 });
      const [childRun] = await child.claim({ workerId: 'upgrade-worker' });
      await childRun.settle(childRun.succeed());
      assert.equal(await child.prune(), 1);
      assert.equal(await child.inspect('child'), undefined);
    } finally {
      native.close?.();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
