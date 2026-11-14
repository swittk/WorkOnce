import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
import { createSqliteStore } from '../dist/sqlite.js';
import { assertExactBooleanSample } from './refinement-sample-schema.mjs';

async function finish(queue, key) {
  await queue.ensure(null, { key });
  const [run] = await queue.claim({ workerId: `${key}-worker` });
  await run.settle(run.succeed());
  return run;
}

async function adapterSamples(adapter) {
  const directory = mkdtempSync(join(tmpdir(), `workonce-retention-refinement-${adapter}-`));
  let now = 100;
  const store =
    adapter === 'memory'
      ? createMemoryStore({ now: () => now })
      : createSqliteStore(join(directory, 'queue.sqlite'), { now: () => now });
  try {
    const work = createWorkOnce({ store, scope: `retention-${adapter}` });
    const zero = work.define('zero', { retention: { afterTerminalMs: 0 } });
    await finish(zero, 'zero');
    const zeroDeletedAtEquality =
      (await zero.prune()) === 1 && (await zero.inspect('zero')) === undefined;

    const finite = work.define('finite', { retention: { afterTerminalMs: 5 } });
    await finish(finite, 'finite');
    now = 104;
    const finiteHeldBefore = (await finite.prune()) === 0;
    now = 105;
    const finiteDeletedAtEquality = (await finite.prune()) === 1;

    const forever = work.define('forever');
    await finish(forever, 'forever');
    now = Number.MAX_SAFE_INTEGER;
    const foreverRetained =
      (await work.prune()) === 0 && (await forever.inspect('forever')) !== undefined;

    now = 200;
    const aba = work.define('aba', { retention: { afterTerminalMs: 0 } });
    const old = await aba.ensure(null, { key: 'same' });
    const [oldRun] = await aba.claim({ workerId: 'old' });
    const oldOutcome = oldRun.succeed();
    await oldRun.settle(oldOutcome);
    await aba.prune();
    const fresh = await aba.ensure(null, { key: 'same' });
    let staleHeartbeatRejected = false;
    let staleSettlementRejected = false;
    try {
      await oldRun.heartbeat();
    } catch (error) {
      staleHeartbeatRejected = error?.code === 'stale_attempt';
    }
    try {
      await oldRun.settle(oldOutcome);
    } catch (error) {
      staleSettlementRejected = error?.code === 'stale_attempt';
    }

    const parent = work.define('parent', { retention: { afterTerminalMs: 0 } });
    const child = work.define('child');
    await parent.ensure(null, { key: 'parent' });
    const [parentRun] = await parent.claim({ workerId: 'parent' });
    await parentRun.settle(
      parentRun.succeed(null, { next: [child.request(null, { key: 'child' })] }),
    );
    const outboxRetained = (await parent.prune()) === 0;
    await work.dispatch();
    const afterDrainDeleted = (await parent.prune()) === 1;
    await aba.ensure(null, { key: 'active' });
    const activeRetained = (await aba.prune()) === 0;

    return [
      {
        kind: 'boundary',
        adapter,
        zeroDeletedAtEquality,
        finiteHeldBefore,
        finiteDeletedAtEquality,
        foreverRetained,
      },
      {
        kind: 'isolation',
        adapter,
        freshIncarnation: old.incarnation !== fresh.incarnation,
        staleHeartbeatRejected,
        staleSettlementRejected,
        activeRetained,
        outboxRetained,
        afterDrainDeleted,
      },
    ];
  } finally {
    store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function raceSample() {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-retention-refinement-race-'));
  const path = join(directory, 'queue.sqlite');
  const firstStore = createSqliteStore(path, { now: () => 100 });
  const secondStore = createSqliteStore(path, { now: () => 100 });
  try {
    const first = createWorkOnce({ store: firstStore, scope: 'retention-race' });
    const second = createWorkOnce({ store: secondStore, scope: 'retention-race' });
    const firstQueue = first.define('job', { retention: { afterTerminalMs: 0 } });
    const secondQueue = second.define('job', { retention: { afterTerminalMs: 0 } });
    await finish(firstQueue, 'same');
    const counts = await Promise.all([first.prune({ limit: 1 }), second.prune({ limit: 1 })]);
    return {
      kind: 'race',
      independentStores: true,
      singleWinner: counts[0] + counts[1] === 1,
      physicallyAbsent:
        (await firstQueue.inspect('same')) === undefined &&
        (await secondQueue.inspect('same')) === undefined,
    };
  } finally {
    firstStore.close();
    secondStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function replaySample() {
  const store = createMemoryStore({ now: () => 100 });
  const work = createWorkOnce({ store, scope: 'retention-replay' });
  const parent = work.define('parent');
  const child = work.define('child', { retention: { afterTerminalMs: 0 } });
  const requestA = child.request(null, { key: 'child' });
  const requestB = child.request(null, { key: 'child' });
  await parent.ensure(null, { key: 'parent' });
  const [run] = await parent.claim({ workerId: 'parent' });
  const outcome = run.succeed(null, { next: [requestA] });
  const first = await run.settle(outcome);
  const replay = await run.settle(outcome);
  await work.dispatch();
  const before = await child.inspect('child');
  const [childRun] = await child.claim({ workerId: 'child' });
  await childRun.settle(childRun.succeed());
  await child.prune();
  const after = await child.ensure(null, { key: 'child' });
  return {
    kind: 'replay',
    deterministicDescription: JSON.stringify(requestA) === JSON.stringify(requestB),
    descriptionHasNoIncarnation: !Object.hasOwn(requestA, 'incarnation'),
    receiptReplay: JSON.stringify(first) === JSON.stringify(replay),
    replayAfterExpiryIsFresh: before.incarnation !== after.incarnation,
  };
}

async function growthSample() {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-retention-refinement-growth-'));
  const path = join(directory, 'queue.sqlite');
  const pages = [];
  try {
    for (let wave = 0; wave < 2; wave++) {
      const store = createSqliteStore(path, { now: () => 100 });
      const queue = createWorkOnce({ store, scope: 'retention-growth' }).define('job', {
        retention: { afterTerminalMs: 0 },
      });
      for (let cycle = 0; cycle < 8; cycle++) {
        await finish(queue, 'same');
        await queue.prune({ limit: 1 });
      }
      store.close();
      const database = new DatabaseSync(path);
      try {
        assert.equal(database.prepare('SELECT count(*) AS count FROM workonce').get().count, 0);
        pages.push(database.prepare('PRAGMA page_count').get().page_count);
      } finally {
        database.close();
      }
    }
    return {
      kind: 'growth',
      cycles: 16,
      rowsAfterCycles: 0,
      pageCountStable: pages[0] === pages[1],
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function assertRetentionRefinementSamples(samples) {
  assert.equal(samples.length, 7, 'retention sample coverage drifted');
  assert.deepEqual(
    samples
      .filter((sample) => sample.kind === 'boundary')
      .map((sample) => sample.adapter)
      .sort(),
    ['memory', 'sqlite'],
  );
  assert.deepEqual(
    samples
      .filter((sample) => sample.kind === 'isolation')
      .map((sample) => sample.adapter)
      .sort(),
    ['memory', 'sqlite'],
  );
  assert.deepEqual([...new Set(samples.map((sample) => sample.kind))].sort(), [
    'boundary',
    'growth',
    'isolation',
    'race',
    'replay',
  ]);
  const booleanFields = {
    boundary: [
      'zeroDeletedAtEquality',
      'finiteHeldBefore',
      'finiteDeletedAtEquality',
      'foreverRetained',
    ],
    isolation: [
      'freshIncarnation',
      'staleHeartbeatRejected',
      'staleSettlementRejected',
      'activeRetained',
      'outboxRetained',
      'afterDrainDeleted',
    ],
    race: ['independentStores', 'singleWinner', 'physicallyAbsent'],
    replay: [
      'deterministicDescription',
      'descriptionHasNoIncarnation',
      'receiptReplay',
      'replayAfterExpiryIsFresh',
    ],
    growth: ['pageCountStable'],
  };
  const metadataFields = {
    boundary: ['adapter'],
    isolation: ['adapter'],
    race: [],
    replay: [],
    growth: ['cycles', 'rowsAfterCycles'],
  };
  for (const sample of samples) {
    assertExactBooleanSample(sample, booleanFields[sample.kind], metadataFields[sample.kind]);
    if (sample.kind === 'growth') {
      assert.equal(sample.cycles, 16);
      assert.equal(sample.rowsAfterCycles, 0);
    }
  }
}

export async function runRetentionRefinementSamples() {
  const samples = [
    ...(await adapterSamples('memory')),
    ...(await adapterSamples('sqlite')),
    await raceSample(),
    await replaySample(),
    await growthSample(),
  ];
  assertRetentionRefinementSamples(samples);
  return samples;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const samples = await runRetentionRefinementSamples();
  process.stdout.write(`${JSON.stringify(samples, null, 2)}\n`);
}
