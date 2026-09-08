import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';
import { createCompareExchangeStore } from '../dist/cas.js';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
import { createSqliteStore } from '../dist/sqlite.js';

const observe = (promise) =>
  promise.then(
    (value) => ({ rejected: false, value }),
    (error) => ({ rejected: true, error }),
  );
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function adapterFixture(adapter) {
  let now = 100;
  if (adapter === 'memory') {
    return {
      store: createMemoryStore({ now: () => now }),
      setNow(value) {
        now = value;
      },
      close() {},
      async expire(leaseMs) {
        now += leaseMs + 1;
      },
    };
  }
  if (adapter === 'cas') {
    const native = createMemoryStore({ now: () => now });
    const port = {
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
    };
    return {
      store: createCompareExchangeStore(port),
      setNow(value) {
        now = value;
      },
      close() {},
      async expire(leaseMs) {
        now += leaseMs + 1;
      },
    };
  }
  if (adapter === 'sqlite') {
    const directory = mkdtempSync(join(tmpdir(), 'workonce-runner-refinement-'));
    const store = createSqliteStore(join(directory, 'workonce.sqlite'));
    return {
      store,
      setNow() {},
      close() {
        store.close();
        rmSync(directory, { recursive: true, force: true });
      },
      async expire(leaseMs) {
        await sleep(leaseMs + 25);
      },
    };
  }
  throw new Error(`Unknown adapter ${adapter}`);
}
async function waitUntil(check, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (performance.now() >= deadline) throw new Error('local runner refinement timed out');
    await sleep(2);
  }
}
function semanticSnapshot(snapshot) {
  if (!snapshot) return null;
  const phase = { ...snapshot.phase };
  delete phase.startedAt;
  delete phase.completedAt;
  delete phase.failedAt;
  delete phase.cancelledAt;
  if (phase.attempt) {
    phase.attempt = { ...phase.attempt };
    delete phase.attempt.leaseUntil;
    delete phase.attempt.workerId;
  }
  return {
    generation: snapshot.generation,
    attempts: snapshot.attempts,
    retries: snapshot.retries,
    deferrals: snapshot.deferrals,
    phase,
    pendingFollowups: snapshot.pendingFollowups,
  };
}

async function stopReclaimSample(adapter, mode) {
  const fixture = adapterFixture(adapter);
  const leaseMs = 80;
  const callerStop = new Error(`${adapter}-caller-stop`);
  const heartbeatFailure = new Error(`${adapter}-heartbeat-failure`);
  let failHeartbeat = false;
  try {
    const store = {
      ...fixture.store,
      async atomic(id, decide) {
        if (failHeartbeat) throw heartbeatFailure;
        return fixture.store.atomic(id, decide);
      },
    };
    const queue = createWorkOnce({ store, scope: `runner-${adapter}-${mode}` }).define('job', {
      limits: { leaseMs, maxAttempts: 4, maxElapsedMs: 1000, maxDeferrals: 4 },
    });
    await queue.ensure(null, { key: 'job' });
    const entered = deferred();
    const release = deferred();
    const stop = new AbortController();
    const running = queue.runAvailable(
      { workerId: 'A', heartbeatMs: mode === 'heartbeat' ? 5 : 20, signal: stop.signal },
      async (run) => {
        entered.resolve(run.ref);
        if (mode === 'heartbeat') {
          failHeartbeat = true;
          await sleep(35);
        } else {
          await release.promise;
        }
        return run.succeed();
      },
    );
    const oldRef = await entered.promise;
    if (mode === 'caller') {
      stop.abort(callerStop);
      release.resolve();
    }
    const [result] = await running;
    failHeartbeat = false;
    const beforeReclaim = await queue.inspect('job');
    await fixture.expire(leaseMs);
    const [reclaimed] = await queue.claim({ workerId: 'B', limit: 1 });
    return {
      kind: 'stopReclaim',
      adapter,
      mode,
      exactCause:
        result.status === 'interrupted' &&
        result.error === (mode === 'heartbeat' ? heartbeatFailure : callerStop),
      leftRunning: beforeReclaim.phase.state === 'running',
      reclaimAdvanced:
        reclaimed !== undefined &&
        reclaimed.ref.generation === oldRef.generation &&
        reclaimed.ref.fence === oldRef.fence + 1,
    };
  } finally {
    fixture.close();
  }
}

async function undefinedHeartbeatSample(adapter) {
  const fixture = adapterFixture(adapter);
  let failHeartbeat = false;
  try {
    const store = {
      ...fixture.store,
      async atomic(id, decide) {
        if (failHeartbeat) throw undefined;
        return fixture.store.atomic(id, decide);
      },
    };
    const queue = createWorkOnce({ store, scope: `runner-undefined-${adapter}` }).define('job', {
      limits: { leaseMs: 100, maxAttempts: 3, maxElapsedMs: 1000, maxDeferrals: 2 },
    });
    await queue.ensure(null, { key: 'job' });
    const [result] = await queue.runAvailable({ workerId: 'A', heartbeatMs: 5 }, async (run) => {
      failHeartbeat = true;
      await sleep(30);
      return run.succeed();
    });
    return {
      kind: 'undefinedHeartbeat',
      adapter,
      interrupted: result.status === 'interrupted',
      exactUndefined: result.status === 'interrupted' && result.error === undefined,
    };
  } finally {
    fixture.close();
  }
}

async function settleCauseSample(adapter) {
  const fixture = adapterFixture(adapter);
  const failure = new Error(`${adapter}-settle-delivery`);
  let failSettle = false;
  try {
    const store = {
      ...fixture.store,
      async atomic(id, decide) {
        if (failSettle) throw failure;
        return fixture.store.atomic(id, decide);
      },
    };
    const queue = createWorkOnce({ store, scope: `runner-settle-${adapter}` }).define('job', {
      limits: { leaseMs: 500, maxAttempts: 3, maxElapsedMs: 1000, maxDeferrals: 2 },
    });
    await queue.ensure(null, { key: 'job' });
    const [result] = await queue.runAvailable({ workerId: 'A', heartbeatMs: 100 }, async (run) => {
      failSettle = true;
      return run.succeed();
    });
    failSettle = false;
    return {
      kind: 'settleCause',
      adapter,
      exactCause: result.status === 'interrupted' && result.error === failure,
      stillRunning: (await queue.inspect('job')).phase.state === 'running',
    };
  } finally {
    fixture.close();
  }
}

async function dynamicArrivalSample() {
  const store = createMemoryStore();
  const queue = createWorkOnce({ store, scope: 'runner-dynamic' }).define('job', {
    limits: { leaseMs: 1000, maxAttempts: 4, maxElapsedMs: 5000, maxDeferrals: 2 },
  });
  for (let index = 0; index < 6; index++) await queue.ensure({ index }, { key: String(index) });
  const stop = new AbortController();
  const starts = [];
  const counts = new Map();
  let active = 0;
  let peak = 0;
  let slowFinished = false;
  let laterBeforeSlow = false;
  const running = queue.run(
    { workerId: 'dynamic', concurrency: 3, idleMs: 1, heartbeatMs: 100, signal: stop.signal },
    async (run, input) => {
      starts.push(input.index);
      counts.set(input.index, (counts.get(input.index) ?? 0) + 1);
      if (input.index >= 3 && !slowFinished) laterBeforeSlow = true;
      active++;
      peak = Math.max(peak, active);
      await sleep(input.index === 0 ? 100 : 8);
      active--;
      if (input.index === 0) slowFinished = true;
      return run.succeed();
    },
  );
  await waitUntil(() => starts.length >= 2);
  for (let index = 6; index < 10; index++) await queue.ensure({ index }, { key: String(index) });
  await waitUntil(async () => {
    const snapshots = await queue.inspectMany(
      Array.from({ length: 10 }, (_, index) => String(index)),
    );
    return snapshots.every((snapshot) => snapshot?.phase.state === 'succeeded');
  });
  stop.abort();
  await running;
  return {
    kind: 'dynamicArrival',
    allTen: counts.size === 10 && [...counts.values()].every((count) => count === 1),
    boundedCapacity: peak === 3,
    refilledAroundSlow: laterBeforeSlow,
  };
}

async function handledClaimRecoverySample() {
  const base = createMemoryStore();
  const failure = new Error('transient claim fault');
  let failuresRemaining = 3;
  const store = {
    ...base,
    async query(query) {
      if (failuresRemaining > 0) {
        failuresRemaining--;
        throw failure;
      }
      return base.query(query);
    },
  };
  const queue = createWorkOnce({ store, scope: 'runner-handled-recovery' }).define('job');
  await queue.ensure(null, { key: 'job' });
  const stop = new AbortController();
  const observed = [];
  let calls = 0;
  const running = queue.run(
    {
      workerId: 'handled',
      idleMs: 1,
      signal: stop.signal,
      onError(error) {
        observed.push(error);
      },
    },
    async (run) => {
      calls++;
      return run.succeed();
    },
  );
  await waitUntil(async () => (await queue.inspect('job')).phase.state === 'succeeded');
  stop.abort();
  await running;
  return {
    kind: 'handledRecovery',
    exactErrors: observed.length === 3 && observed.every((error) => error === failure),
    eventuallyRanOnce: calls === 1,
  };
}

async function competingRunnersSample(adapter) {
  const fixture = adapterFixture(adapter);
  try {
    const first = createWorkOnce({
      store: fixture.store,
      scope: `runner-compete-${adapter}`,
    }).define('job', {
      limits: { leaseMs: 500, maxAttempts: 4, maxElapsedMs: 2000, maxDeferrals: 2 },
    });
    const second = createWorkOnce({
      store: fixture.store,
      scope: `runner-compete-${adapter}`,
    }).define('job', {
      limits: { leaseMs: 500, maxAttempts: 4, maxElapsedMs: 2000, maxDeferrals: 2 },
    });
    for (let index = 0; index < 4; index++) await first.ensure({ index }, { key: String(index) });
    const stopA = new AbortController();
    const stopB = new AbortController();
    const firstWave = deferred();
    const release = deferred();
    const counts = new Map();
    const owners = new Set();
    let blocked = 0;
    const handler = async (run, input) => {
      counts.set(input.index, (counts.get(input.index) ?? 0) + 1);
      owners.add(run.attempt.workerId);
      if (blocked < 2) {
        blocked++;
        if (blocked === 2) firstWave.resolve();
        await release.promise;
      }
      return run.succeed();
    };
    const runningA = first.run(
      { workerId: 'A', concurrency: 1, idleMs: 1, heartbeatMs: 50, signal: stopA.signal },
      handler,
    );
    const runningB = second.run(
      { workerId: 'B', concurrency: 1, idleMs: 1, heartbeatMs: 50, signal: stopB.signal },
      handler,
    );
    await firstWave.promise;
    release.resolve();
    await waitUntil(async () => {
      const snapshots = await first.inspectMany(['0', '1', '2', '3']);
      return snapshots.every((snapshot) => snapshot?.phase.state === 'succeeded');
    });
    stopA.abort();
    stopB.abort();
    await Promise.all([runningA, runningB]);
    return {
      kind: 'competingRunners',
      adapter,
      bothOwners: owners.has('A') && owners.has('B'),
      exactlyOnce: counts.size === 4 && [...counts.values()].every((count) => count === 1),
    };
  } finally {
    fixture.close();
  }
}

async function completionOrderLane(reverse) {
  const store = createMemoryStore({ now: () => 100 });
  const queue = createWorkOnce({ store, scope: `runner-order-${reverse}` }).define('job', {
    limits: { leaseMs: 500, maxAttempts: 4, maxElapsedMs: 2000, maxDeferrals: 2 },
  });
  await queue.ensure('a', { key: 'a' });
  await queue.ensure('b', { key: 'b' });
  const entered = { a: deferred(), b: deferred() };
  const release = { a: deferred(), b: deferred() };
  const running = queue.runAvailable({ workerId: 'order', concurrency: 2 }, async (run, input) => {
    entered[input].resolve();
    await release[input].promise;
    return run.succeed(input);
  });
  await Promise.all([entered.a.promise, entered.b.promise]);
  const order = reverse ? ['b', 'a'] : ['a', 'b'];
  release[order[0]].resolve();
  await nextTurn();
  release[order[1]].resolve();
  await running;
  const projection = (await queue.inspectMany(['a', 'b'])).map(semanticSnapshot);
  await queue.ensure('future', { key: 'future' });
  const [future] = await queue.runAvailable({ workerId: 'future' }, async (run) => run.succeed());
  return { projection, future: future.status };
}

async function completionOrderSample() {
  const forward = await completionOrderLane(false);
  const reverse = await completionOrderLane(true);
  return {
    kind: 'completionOrder',
    sameProjection: JSON.stringify(forward.projection) === JSON.stringify(reverse.projection),
    sameFuture: forward.future === 'settled' && reverse.future === 'settled',
  };
}

async function handledVsAbortLane(handled) {
  const base = createMemoryStore({ now: () => 100 });
  const failure = new Error('handled-history');
  let failClaim = handled;
  const store = {
    ...base,
    async query(query) {
      if (failClaim) {
        failClaim = false;
        throw failure;
      }
      return base.query(query);
    },
  };
  const queue = createWorkOnce({ store, scope: `runner-history-${handled}` }).define('job');
  await queue.ensure(null, { key: 'job' });
  const stop = new AbortController();
  if (!handled) stop.abort(new Error('graceful-stop'));
  await queue.run(
    {
      workerId: 'history',
      idleMs: 1,
      signal: stop.signal,
      onError(error) {
        assert.equal(error, failure);
        stop.abort(new Error('handled-stop'));
      },
    },
    async (run) => run.succeed(),
  );
  const durable = semanticSnapshot(await queue.inspect('job'));
  const [future] = await queue.runAvailable({ workerId: 'future' }, async (run) => run.succeed());
  return { durable, future: future.status };
}

async function handledAbortCongruenceSample() {
  const handled = await handledVsAbortLane(true);
  const aborted = await handledVsAbortLane(false);
  return {
    kind: 'handledAbortHistory',
    sameDurable: JSON.stringify(handled.durable) === JSON.stringify(aborted.durable),
    sameFuture: handled.future === 'settled' && aborted.future === 'settled',
  };
}

async function backoffLane(mode) {
  const base = createMemoryStore({ now: () => 100 });
  const failure = new Error('backoff-history');
  let queries = 0;
  const store = {
    ...base,
    async query(query) {
      queries++;
      if (queries === 2) throw failure;
      return base.query(query);
    },
  };
  const queue = createWorkOnce({ store, scope: `runner-backoff-${mode}` }).define('job', {
    limits: { leaseMs: 500, maxAttempts: 4, maxElapsedMs: 2000, maxDeferrals: 2 },
  });
  await queue.ensure(null, { key: 'job' });
  const release = deferred();
  const stop = new AbortController();
  let observed = 0;
  const running = queue.run(
    {
      workerId: 'backoff',
      concurrency: 2,
      idleMs: 1,
      heartbeatMs: 50,
      signal: stop.signal,
      async onError(error) {
        assert.equal(error, failure);
        observed++;
        if (mode === 'before') {
          release.resolve();
          await waitUntil(async () => (await queue.inspect('job')).phase.state === 'succeeded');
        } else {
          setTimeout(() => release.resolve(), 0);
          await sleep(10);
        }
      },
    },
    async (run) => {
      await release.promise;
      return run.succeed();
    },
  );
  await waitUntil(async () => (await queue.inspect('job')).phase.state === 'succeeded');
  stop.abort();
  await running;
  const durable = semanticSnapshot(await queue.inspect('job'));
  await queue.ensure(null, { key: 'future' });
  const [future] = await queue.runAvailable({ workerId: 'future' }, async (run) => run.succeed());
  return { observed, durable, future: future.status };
}

async function backoffCongruenceSample() {
  const before = await backoffLane('before');
  const during = await backoffLane('during');
  return {
    kind: 'backoffHistory',
    handledOnce: before.observed === 1 && during.observed === 1,
    sameDurable: JSON.stringify(before.durable) === JSON.stringify(during.durable),
    sameFuture: before.future === 'settled' && during.future === 'settled',
  };
}

async function lateClaimStopSample() {
  const queue = createWorkOnce({
    store: createMemoryStore(),
    scope: 'runner-late-claim-stop',
  }).define('job', {
    limits: { leaseMs: 500, maxAttempts: 4, maxElapsedMs: 2000, maxDeferrals: 2 },
  });
  await queue.ensure({ id: 'a' }, { key: 'a' });
  await queue.ensure({ id: 'b' }, { key: 'b' });
  const originalClaim = queue.claim.bind(queue);
  let claimCalls = 0;
  const secondClaimEntered = deferred();
  const releaseSecondClaim = deferred();
  queue.claim = async (options) => {
    claimCalls++;
    if (claimCalls === 1) return originalClaim({ ...options, limit: 1 });
    secondClaimEntered.resolve();
    await releaseSecondClaim.promise;
    return originalClaim({ ...options, limit: 1 });
  };
  const firstHandlerEntered = deferred();
  const releaseFirstHandler = deferred();
  const started = [];
  const stop = new AbortController();
  const running = queue.run(
    { workerId: 'late', concurrency: 2, heartbeatMs: 100, idleMs: 1000, signal: stop.signal },
    async (run, input) => {
      started.push(input.id);
      if (input.id === 'a') {
        firstHandlerEntered.resolve();
        await releaseFirstHandler.promise;
      }
      return run.succeed();
    },
  );
  await Promise.all([firstHandlerEntered.promise, secondClaimEntered.promise]);
  stop.abort(new Error('late-claim-stop'));
  releaseFirstHandler.resolve();
  await nextTurn();
  releaseSecondClaim.resolve();
  await running;
  const late = await queue.inspect('b');
  return {
    kind: 'lateClaimStop',
    oneHandler: started.length === 1 && started[0] === 'a',
    lateLeaseNotExecuted: late.phase.state === 'running',
  };
}

async function timerBoundarySample() {
  async function exactLease() {
    const q = createWorkOnce({
      store: createMemoryStore(),
      scope: 'runner-exact-heartbeat',
    }).define('job', {
      limits: { leaseMs: 20, maxAttempts: 3, maxElapsedMs: 1000, maxDeferrals: 2 },
    });
    await q.ensure(null, { key: 'job' });
    const [result] = await q.runAvailable({ workerId: 'x', heartbeatMs: 20 }, async (run) =>
      run.succeed(),
    );
    return (
      result.status === 'interrupted' &&
      result.error instanceof RangeError &&
      result.error.message === 'heartbeatMs must be shorter than the lease'
    );
  }
  async function justBelow() {
    const q = createWorkOnce({
      store: createMemoryStore(),
      scope: 'runner-below-heartbeat',
    }).define('job', {
      limits: { leaseMs: 20, maxAttempts: 3, maxElapsedMs: 1000, maxDeferrals: 2 },
    });
    await q.ensure(null, { key: 'job' });
    const [result] = await q.runAvailable({ workerId: 'x', heartbeatMs: 19 }, async (run) =>
      run.succeed(),
    );
    return result.status === 'settled';
  }
  async function hugeTimer() {
    const q = createWorkOnce({
      store: createMemoryStore({ now: () => 100 }),
      scope: 'runner-huge',
    }).define('job', {
      limits: {
        leaseMs: 2_147_483_648,
        maxAttempts: 3,
        maxElapsedMs: 2_147_483_649,
        maxDeferrals: 2,
      },
    });
    await q.ensure(null, { key: 'job' });
    const [result] = await q.runAvailable(
      { workerId: 'x', heartbeatMs: 2_147_483_647 },
      async (run) => run.succeed(),
    );
    return result.status === 'settled';
  }
  async function oneMsExpiry() {
    const q = createWorkOnce({ store: createMemoryStore(), scope: 'runner-expiry' }).define('job', {
      limits: { leaseMs: 1, maxAttempts: 3, maxElapsedMs: 1000, maxDeferrals: 2 },
    });
    await q.ensure(null, { key: 'job' });
    const [result] = await q.runAvailable({ workerId: 'x' }, async (run) => {
      await sleep(8);
      return run.succeed();
    });
    return (
      result.status === 'interrupted' && result.error?.message === 'Confirmed lease deadline passed'
    );
  }
  async function hugeIdleAbort() {
    const q = createWorkOnce({ store: createMemoryStore(), scope: 'runner-huge-idle' }).define(
      'job',
    );
    const stop = new AbortController();
    const started = performance.now();
    const running = q.run(
      { workerId: 'x', idleMs: Number.MAX_SAFE_INTEGER, signal: stop.signal },
      async (run) => run.succeed(),
    );
    await sleep(5);
    stop.abort(new Error('stop huge idle'));
    await running;
    return performance.now() - started < 250;
  }
  return {
    kind: 'timerBoundary',
    exactLeaseRejects: await exactLease(),
    oneBelowAccepts: await justBelow(),
    hugeFiniteAccepted: await hugeTimer(),
    expiryCauseExact: await oneMsExpiry(),
    hugeIdleInterruptible: await hugeIdleAbort(),
  };
}

async function wakePollSample() {
  const base = createMemoryStore();
  const failure = new Error('wake-poll-heartbeat');
  let failAtomic = false;
  const store = {
    ...base,
    async atomic(id, decide) {
      if (failAtomic) throw failure;
      return base.atomic(id, decide);
    },
  };
  const queue = createWorkOnce({ store, scope: 'runner-wake-poll' }).define('job', {
    limits: { leaseMs: 500, maxAttempts: 3, maxElapsedMs: 2000, maxDeferrals: 2 },
  });
  await queue.ensure(null, { key: 'job' });
  const stop = new AbortController();
  const started = performance.now();
  const result = await observe(
    queue.run(
      { workerId: 'wake', concurrency: 2, heartbeatMs: 20, idleMs: 800, signal: stop.signal },
      async (run) => {
        failAtomic = true;
        await sleep(80);
        return run.succeed();
      },
    ),
  );
  failAtomic = false;
  stop.abort();
  return {
    kind: 'wakePoll',
    exactCause: result.rejected && result.error === failure,
    promptlyWoken: performance.now() - started < 400,
  };
}

export async function runLocalRunnerRefinementSamples() {
  const samples = [];
  for (const adapter of ['memory', 'sqlite', 'cas']) {
    samples.push(await stopReclaimSample(adapter, 'caller'));
    samples.push(await stopReclaimSample(adapter, 'heartbeat'));
    samples.push(await undefinedHeartbeatSample(adapter));
    samples.push(await settleCauseSample(adapter));
    samples.push(await competingRunnersSample(adapter));
  }
  samples.push(await dynamicArrivalSample());
  samples.push(await handledClaimRecoverySample());
  samples.push(await completionOrderSample());
  samples.push(await handledAbortCongruenceSample());
  samples.push(await backoffCongruenceSample());
  samples.push(await lateClaimStopSample());
  samples.push(await timerBoundarySample());
  samples.push(await wakePollSample());
  return samples;
}

export function assertLocalRunnerRefinementSamples(samples) {
  assert.equal(samples.length, 23, 'local runner refinement sample family unexpectedly changed');
  for (const sample of samples) {
    const name = JSON.stringify(sample);
    switch (sample.kind) {
      case 'stopReclaim':
        assert.equal(sample.exactCause, true, name);
        assert.equal(sample.leftRunning, true, name);
        assert.equal(sample.reclaimAdvanced, true, name);
        break;
      case 'undefinedHeartbeat':
        assert.equal(sample.interrupted, true, name);
        assert.equal(sample.exactUndefined, true, name);
        break;
      case 'settleCause':
        assert.equal(sample.exactCause, true, name);
        assert.equal(sample.stillRunning, true, name);
        break;
      case 'competingRunners':
        assert.equal(sample.bothOwners, true, name);
        assert.equal(sample.exactlyOnce, true, name);
        break;
      case 'dynamicArrival':
        assert.equal(sample.allTen, true, name);
        assert.equal(sample.boundedCapacity, true, name);
        assert.equal(sample.refilledAroundSlow, true, name);
        break;
      case 'handledRecovery':
        assert.equal(sample.exactErrors, true, name);
        assert.equal(sample.eventuallyRanOnce, true, name);
        break;
      case 'completionOrder':
        assert.equal(sample.sameProjection, true, name);
        assert.equal(sample.sameFuture, true, name);
        break;
      case 'handledAbortHistory':
        assert.equal(sample.sameDurable, true, name);
        assert.equal(sample.sameFuture, true, name);
        break;
      case 'backoffHistory':
        assert.equal(sample.handledOnce, true, name);
        assert.equal(sample.sameDurable, true, name);
        assert.equal(sample.sameFuture, true, name);
        break;
      case 'lateClaimStop':
        assert.equal(sample.oneHandler, true, name);
        assert.equal(sample.lateLeaseNotExecuted, true, name);
        break;
      case 'timerBoundary':
        for (const [field, value] of Object.entries(sample))
          if (field !== 'kind') assert.equal(value, true, `${sample.kind}.${field}`);
        break;
      case 'wakePoll':
        assert.equal(sample.exactCause, true, name);
        assert.equal(sample.promptlyWoken, true, name);
        break;
      default:
        assert.fail(`Unmapped local runner sample: ${name}`);
    }
  }
  return samples.length;
}
