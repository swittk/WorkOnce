import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompareExchangeStore } from '../dist/cas.js';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
import { createSqliteStore } from '../dist/sqlite.js';
import { assertExactBooleanSample } from './refinement-sample-schema.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function within(promise, label, timeoutMs = 3000) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`refinement timed out waiting for ${label}`)),
        timeoutMs,
      );
    }),
  ]);
}
function stable(value) {
  return JSON.stringify(value);
}
function withoutHistory(row) {
  const cloned = structuredClone(row);
  delete cloned.history;
  return cloned;
}
function observedResult(value, error) {
  if (error !== undefined) {
    return {
      status: 'rejected',
      name: error?.constructor?.name ?? typeof error,
      code: error?.code ?? null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { status: 'fulfilled', value };
}
async function observeOperation(operation) {
  try {
    return observedResult(await operation(), undefined);
  } catch (error) {
    return observedResult(undefined, error);
  }
}
async function seedWaiting(queue, key, reason = 'pending') {
  await queue.ensure(null, { key });
  const [run] = await queue.claim({ workerId: `seed-${key}`, limit: 1 });
  assert.ok(run);
  await run.settle(run.wait(reason, { afterMs: 10 }));
  return queue.inspect(key);
}

function historyFixture(reason, traceName) {
  const store = createMemoryStore({ now: () => 100 });
  const queue = createWorkOnce({
    store,
    scope: `read-history-congruence-${traceName}`,
  }).define('job', {
    limits: { leaseMs: 50, maxAttempts: 8, maxElapsedMs: 1000, maxDeferrals: 8 },
    retry: { retry: true, afterMs: 0, maxRetries: 8, manualRetry: true },
    wait: { afterMs: 0 },
  });
  return { store, queue, reason };
}
async function seedHistoryFixture(reason, traceName) {
  const fixture = historyFixture(reason, traceName);
  await fixture.queue.ensure(null, { key: 'job' });
  const [first] = await fixture.queue.claim({ workerId: 'seed-first' });
  assert.ok(first);
  await first.settle(first.fail(reason, { manualRetry: true }));
  await fixture.queue.retry({ key: 'job', generation: 1 });
  const current = await fixture.queue.inspect('job');
  const history = await fixture.queue.history('job');
  const raw = (await fixture.store.getMany([current.id])).rows[0];
  return { ...fixture, current, history, raw };
}
async function historyProjection(fixture) {
  const current = await fixture.queue.inspect('job');
  const raw = (await fixture.store.getMany([current.id])).rows[0];
  return {
    current,
    rawWithoutHistory: withoutHistory(raw),
    history: await fixture.queue.history('job'),
  };
}
async function runFutureTrace(reason, traceName) {
  const fixture = await seedHistoryFixture(reason, traceName);
  const baselineHistoryLength = fixture.history.length;
  const results = [];
  const projections = [];
  let run;
  const record = async (label, operation) => {
    results.push([label, await observeOperation(operation)]);
    projections.push([label, await historyProjection(fixture)]);
  };
  const claim = async (workerId) => {
    const claims = await fixture.queue.claim({ workerId, limit: 1 });
    run = claims[0];
    assert.ok(run, `${traceName} expected a claim for ${workerId}`);
    return { ref: run.ref, observedAt: run.observedAt, leaseUntil: run.attempt.leaseUntil };
  };

  if (traceName === 'claim-heartbeat-succeed') {
    await record('claim', () => claim('future-a'));
    await record('heartbeat', () => run.heartbeat());
    await record('succeed', () => run.settle(run.succeed('done')));
  } else if (traceName === 'retry-wake-succeed') {
    await record('claim-1', () => claim('future-a'));
    await record('retry', () => run.settle(run.retry('future-retry', { afterMs: 0 })));
    await record('wake', () => fixture.queue.wake({ key: 'job', generation: 2 }));
    await record('claim-2', () => claim('future-b'));
    await record('succeed', () => run.settle(run.succeed('done')));
  } else if (traceName === 'defer-fail-manual-retry') {
    await record('claim-1', () => claim('future-a'));
    await record('defer', () => run.settle(run.wait('future-wait', { afterMs: 0 })));
    await record('wake', () => fixture.queue.wake({ key: 'job', generation: 2 }));
    await record('claim-2', () => claim('future-b'));
    await record('fail', () => run.settle(run.fail('future-fail', { manualRetry: true })));
    await record('manual-retry', () => fixture.queue.retry({ key: 'job', generation: 2 }));
  } else if (traceName === 'cancel-queued') {
    await record('cancel', () => fixture.queue.cancel({ key: 'job', generation: 2 }));
  } else if (traceName === 'cancel-running-late-settle') {
    await record('claim', () => claim('future-a'));
    await record('cancel-current', () =>
      fixture.queue.cancelCurrent({ key: 'job', expectedGeneration: 2 }),
    );
    await record('late-settle', () => run.settle(run.succeed('too-late')));
  } else if (traceName === 'succeed-rerun') {
    await record('claim', () => claim('future-a'));
    await record('succeed', () => run.settle(run.succeed('done')));
    await record('rerun', () => fixture.queue.rerun({ key: 'job', generation: 2 }));
  } else {
    throw new Error(`Unknown future history trace ${traceName}`);
  }

  const finalHistory = await fixture.queue.history('job');
  return {
    current: fixture.current,
    rawBefore: fixture.raw,
    historyBefore: fixture.history,
    results,
    projections: projections.map(([label, value]) => [
      label,
      { current: value.current, rawWithoutHistory: value.rawWithoutHistory },
    ]),
    futureHistoryTail: finalHistory.slice(baselineHistoryLength),
    finalHistory,
  };
}
function normalizeHistoricalReason(history) {
  return history.map((event) =>
    event.reason === 'history-A' || event.reason === 'history-B'
      ? { ...event, reason: '<history-only-difference>' }
      : event,
  );
}
async function historyCongruenceSample() {
  const traceNames = [
    'claim-heartbeat-succeed',
    'retry-wake-succeed',
    'defer-fail-manual-retry',
    'cancel-queued',
    'cancel-running-late-settle',
    'succeed-rerun',
  ];
  const pairs = [];
  for (const traceName of traceNames) {
    const [left, right] = await Promise.all([
      runFutureTrace('history-A', traceName),
      runFutureTrace('history-B', traceName),
    ]);
    pairs.push({ traceName, left, right });
  }
  const first = pairs[0];
  return {
    kind: 'historyCongruence',
    sameCurrentProjection: pairs.every(
      ({ left, right }) => stable(left.current) === stable(right.current),
    ),
    differentHistory:
      stable(first.left.historyBefore) !== stable(first.right.historyBefore) &&
      first.left.historyBefore.some((event) => event.reason === 'history-A') &&
      first.right.historyBefore.some((event) => event.reason === 'history-B'),
    historyOnlyDurableDifference: pairs.every(
      ({ left, right }) =>
        stable(withoutHistory(left.rawBefore)) === stable(withoutHistory(right.rawBefore)) &&
        stable(left.rawBefore.history) !== stable(right.rawBefore.history),
    ),
    allFutureProjectionsSame: pairs.every(
      ({ left, right }) => stable(left.projections) === stable(right.projections),
    ),
    allFutureResultsSame: pairs.every(
      ({ left, right }) => stable(left.results) === stable(right.results),
    ),
    allFutureHistoryTailsSame: pairs.every(
      ({ left, right }) => stable(left.futureHistoryTail) === stable(right.futureHistoryTail),
    ),
    allFutureHistoryDifferencePreserved: pairs.every(
      ({ left, right }) =>
        stable(left.finalHistory) !== stable(right.finalHistory) &&
        stable(normalizeHistoricalReason(left.finalHistory)) ===
          stable(normalizeHistoricalReason(right.finalHistory)),
    ),
    futureTraceCount: traceNames.length,
  };
}

async function historyTruncationSample() {
  const store = createMemoryStore({ now: () => 100 });
  const queue = createWorkOnce({ store, scope: 'read-history-truncation' }).define('job', {
    limits: { leaseMs: 50, maxAttempts: 4, maxElapsedMs: 1000, maxDeferrals: 4 },
  });
  await queue.ensure(null, { key: 'job' });
  const expectedActions = ['enqueue'];
  const expectedReasons = [];
  for (let cycle = 0; cycle < 44; cycle++) {
    const [run] = await queue.claim({ workerId: `w-${cycle}`, limit: 1 });
    assert.ok(run);
    expectedActions.push('claim');
    const reason = `reason-${cycle}`;
    await run.settle(run.fail(reason, { manualRetry: true }));
    expectedActions.push('fail');
    expectedReasons.push(reason);
    await queue.retry({ key: 'job', generation: cycle + 1 });
    expectedActions.push('manual_retry');
  }
  const history = await queue.history('job');
  const row = (await store.getMany([(await queue.inspect('job')).id])).rows[0];
  const expectedTail = expectedActions.slice(-128);
  const retainedReasons = history
    .filter((event) => event.action === 'fail')
    .map((event) => event.reason);
  const expectedRetainedReasons = expectedReasons.slice(-retainedReasons.length);
  return {
    kind: 'historyTruncation',
    retainedEvents: history.length,
    exactly128: history.length === 128,
    latestActionsExact: stable(history.map((event) => event.action)) === stable(expectedTail),
    latestReasonsExact: stable(retainedReasons) === stable(expectedRetainedReasons),
    oldestDropped: !history.some((event) => event.reason === 'reason-0'),
    newestRetained: history.some((event) => event.reason === 'reason-43'),
    publicEqualsDurable: stable(history) === stable(row.history),
  };
}

function baseFixture(adapter) {
  const now = () => 100;
  if (adapter === 'memory') return { store: createMemoryStore({ now }), close() {} };
  if (adapter === 'sqlite') {
    const directory = mkdtempSync(join(tmpdir(), 'workonce-read-race-'));
    const store = createSqliteStore(join(directory, 'queue.sqlite'), { now });
    return {
      store,
      close() {
        store.close();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  }
  throw new Error(`Unsupported base fixture ${adapter}`);
}

async function endpointRaceSample(adapter, mode) {
  const fixture = baseFixture(adapter);
  const entered = deferred();
  const release = deferred();
  let armed = false;
  let reading;
  try {
    const wrapped = {
      ...fixture.store,
      async getMany(ids) {
        if (!armed || ids.length !== 2) return fixture.store.getMany(ids);
        armed = false;
        if (mode === 'writerFirst') {
          entered.resolve();
          await within(release.promise, 'read-history race release');
          return fixture.store.getMany(ids);
        }
        const result = await fixture.store.getMany(ids);
        entered.resolve();
        await within(release.promise, 'read-history race release');
        return result;
      },
    };
    const queue = createWorkOnce({ store: wrapped, scope: `read-race-${adapter}-${mode}` }).define(
      'job',
      { limits: { leaseMs: 50, maxAttempts: 4, maxElapsedMs: 1000, maxDeferrals: 4 } },
    );
    await seedWaiting(queue, 'a');
    await seedWaiting(queue, 'b');
    const before = await queue.inspectMany(['a', 'b']);
    armed = true;
    reading = queue.inspectMany(['a', 'b']);
    await within(entered.promise, 'read-history race entry');
    const bBefore = await queue.inspect('b');
    const bAfter = await queue.wake({
      key: 'b',
      generation: bBefore.generation,
      revision: bBefore.revision,
    });
    release.resolve();
    const observed = await reading;
    const after = await queue.inspectMany(['a', 'b']);
    const expected = mode === 'writerFirst' ? [before[0], bAfter] : before;
    return {
      kind: 'inspectManyRace',
      adapter,
      mode,
      callerOrderExact: observed[0].key === 'a' && observed[1].key === 'b',
      perIdRealState:
        (stable(observed[0]) === stable(before[0]) || stable(observed[0]) === stable(after[0])) &&
        (stable(observed[1]) === stable(before[1]) || stable(observed[1]) === stable(after[1])),
      expectedEndpoint: stable(observed) === stable(expected),
      mixedRevision: observed[0].revision !== observed[1].revision,
      oneStorageClock: observed[0].observedAt === observed[1].observedAt,
      perIdContractPreserved:
        observed.length === 2 &&
        observed[0]?.key === 'a' &&
        observed[1]?.key === 'b' &&
        (stable(observed[0]) === stable(before[0]) || stable(observed[0]) === stable(after[0])) &&
        (stable(observed[1]) === stable(before[1]) || stable(observed[1]) === stable(after[1])),
      crossIdAtomicSnapshotRequired: false,
    };
  } finally {
    release.resolve();
    if (reading) await Promise.allSettled([reading]);
    fixture.close();
  }
}

async function casMixedRaceSample() {
  const now = () => 100;
  const native = createMemoryStore({ now });
  const firstRead = deferred();
  const release = deferred();
  let armed = false;
  const port = {
    async getMany(ids) {
      if (!armed || ids.length !== 2) return native.getMany(ids);
      armed = false;
      const left = await native.getMany([ids[0]]);
      firstRead.resolve();
      await within(release.promise, 'read-history race release');
      const right = await native.getMany([ids[1]]);
      return { rows: [left.rows[0], right.rows[0]], now: right.now };
    },
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
  };
  const store = createCompareExchangeStore(port);
  const queue = createWorkOnce({ store, scope: 'read-race-cas-mixed' }).define('job', {
    limits: { leaseMs: 50, maxAttempts: 4, maxElapsedMs: 1000, maxDeferrals: 4 },
  });
  let reading;
  try {
    await seedWaiting(queue, 'a');
    await seedWaiting(queue, 'b');
    const before = await queue.inspectMany(['a', 'b']);
    armed = true;
    reading = queue.inspectMany(['a', 'b']);
    await within(firstRead.promise, 'CAS mixed-race first read');
    const bBefore = await queue.inspect('b');
    const bAfter = await queue.wake({
      key: 'b',
      generation: bBefore.generation,
      revision: bBefore.revision,
    });
    release.resolve();
    const observed = await reading;
    const after = await queue.inspectMany(['a', 'b']);
    return {
      kind: 'inspectManyRace',
      adapter: 'cas',
      mode: 'mixed',
      callerOrderExact: observed[0].key === 'a' && observed[1].key === 'b',
      perIdRealState:
        stable(observed[0]) === stable(before[0]) &&
        stable(observed[1]) === stable(bAfter) &&
        stable(observed[1]) === stable(after[1]),
      expectedEndpoint: stable(observed) === stable([before[0], bAfter]),
      mixedRevision: observed[0].revision !== observed[1].revision,
      oneStorageClock: observed[0].observedAt === observed[1].observedAt,
      perIdContractPreserved:
        observed.length === 2 &&
        observed[0]?.key === 'a' &&
        observed[1]?.key === 'b' &&
        stable(observed[0]) === stable(before[0]) &&
        stable(observed[1]) === stable(bAfter),
      crossIdAtomicSnapshotRequired: false,
    };
  } finally {
    release.resolve();
    if (reading) await Promise.allSettled([reading]);
  }
}

export async function runReadHistorySamples() {
  return [
    await historyCongruenceSample(),
    await historyTruncationSample(),
    await endpointRaceSample('memory', 'readerFirst'),
    await endpointRaceSample('memory', 'writerFirst'),
    await endpointRaceSample('sqlite', 'readerFirst'),
    await endpointRaceSample('sqlite', 'writerFirst'),
    await casMixedRaceSample(),
  ];
}

export function assertReadHistorySamples(samples) {
  assert.equal(samples.length, 7, 'read-history sample family unexpectedly changed');
  for (const sample of samples) {
    const name = JSON.stringify(sample);
    if (sample.kind === 'historyCongruence') {
      assertExactBooleanSample(
        sample,
        [
          'sameCurrentProjection',
          'differentHistory',
          'historyOnlyDurableDifference',
          'allFutureProjectionsSame',
          'allFutureResultsSame',
          'allFutureHistoryTailsSame',
          'allFutureHistoryDifferencePreserved',
        ],
        ['futureTraceCount'],
      );
      assert.equal(sample.futureTraceCount, 6, 'historyCongruence.futureTraceCount');
    } else if (sample.kind === 'historyTruncation') {
      assertExactBooleanSample(
        sample,
        [
          'exactly128',
          'latestActionsExact',
          'latestReasonsExact',
          'oldestDropped',
          'newestRetained',
          'publicEqualsDurable',
        ],
        ['retainedEvents'],
      );
      assert.equal(sample.retainedEvents, 128, 'historyTruncation.retainedEvents');
    } else if (sample.kind === 'inspectManyRace') {
      assertExactBooleanSample(
        sample,
        [
          'callerOrderExact',
          'perIdRealState',
          'expectedEndpoint',
          'oneStorageClock',
          'perIdContractPreserved',
        ],
        ['adapter', 'mode', 'mixedRevision', 'crossIdAtomicSnapshotRequired'],
      );
      assert.equal(sample.crossIdAtomicSnapshotRequired, false, name);
      if (sample.mode === 'mixed') assert.equal(sample.mixedRevision, true, name);
      if (sample.mode === 'readerFirst') assert.equal(sample.mixedRevision, false, name);
      if (sample.mode === 'writerFirst') assert.equal(sample.mixedRevision, true, name);
    } else assert.fail(`Unmapped read-history sample: ${name}`);
  }
  return samples.length;
}
