import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';
import { createCompareExchangeStore } from '../dist/cas.js';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
import { createSqliteStore } from '../dist/sqlite.js';
import { assertExactBooleanSample } from './refinement-sample-schema.mjs';

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
    let store;
    try {
      store = createSqliteStore(join(directory, 'workonce.sqlite'), { now: () => now });
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    return {
      store,
      setNow(value) {
        now = value;
      },
      close() {
        try {
          store.close();
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
      async expire(leaseMs) {
        now += leaseMs + 1;
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
function within(promise, label, timeoutMs = 3000) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`local runner refinement timed out waiting for ${label}`)),
        timeoutMs,
      );
    }),
  ]);
}
function waitForAbort(signal, label) {
  if (signal.aborted) return Promise.resolve();
  return within(
    new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
    label,
  );
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
  const leaseMs = mode === 'heartbeat' ? 500 : 80;
  const callerStop = new Error(`${adapter}-caller-stop`);
  const heartbeatFailure = new Error(`${adapter}-heartbeat-failure`);
  let failHeartbeat = false;
  const heartbeatAttempted = deferred();
  let release;
  let stop;
  let running;
  try {
    const store = {
      ...fixture.store,
      async atomic(id, decide) {
        if (failHeartbeat) {
          heartbeatAttempted.resolve();
          throw heartbeatFailure;
        }
        return fixture.store.atomic(id, decide);
      },
    };
    const queue = createWorkOnce({ store, scope: `runner-${adapter}-${mode}` }).define('job', {
      limits: { leaseMs, maxAttempts: 4, maxElapsedMs: 1000, maxDeferrals: 4 },
    });
    await queue.ensure(null, { key: 'job' });
    const entered = deferred();
    release = deferred();
    stop = new AbortController();
    running = queue.runAvailable(
      { workerId: 'A', heartbeatMs: mode === 'heartbeat' ? 5 : 20, signal: stop.signal },
      async (run) => {
        entered.resolve(run.ref);
        if (mode === 'heartbeat') {
          failHeartbeat = true;
          await within(heartbeatAttempted.promise, `${adapter}-heartbeat storage attempt`);
          await waitForAbort(run.signal, `${adapter}-heartbeat ownership abort`);
        } else {
          await within(release.promise, `${adapter}-${mode} handler release`);
        }
        return run.succeed();
      },
    );
    const oldRef = await within(entered.promise, `${adapter}-${mode} handler entry`);
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
    failHeartbeat = false;
    release?.resolve();
    stop?.abort(new Error(`${adapter}-${mode}-cleanup`));
    if (running) await within(Promise.allSettled([running]), `${adapter}-${mode} runner cleanup`);
    fixture.close();
  }
}

async function firstStopCauseSample() {
  const base = createMemoryStore();
  const heartbeatAttempted = deferred();
  let rejectHeartbeat;
  const heartbeatReply = new Promise((_, reject) => {
    rejectHeartbeat = reject;
  });
  let interceptHeartbeat = false;
  const store = {
    ...base,
    atomic(id, decide) {
      if (interceptHeartbeat) {
        interceptHeartbeat = false;
        heartbeatAttempted.resolve();
        return heartbeatReply;
      }
      return base.atomic(id, decide);
    },
  };
  const queue = createWorkOnce({ store, scope: 'runner-first-stop-cause' }).define('job', {
    limits: { leaseMs: 500, maxAttempts: 3, maxElapsedMs: 1000, maxDeferrals: 2 },
  });
  await queue.ensure(null, { key: 'job' });
  const stop = new AbortController();
  const callerStop = new Error('runner caller stopped first');
  const lateHeartbeatFailure = new Error('runner heartbeat failed later');
  let signalCauseExact = false;
  const [result] = await queue.runAvailable(
    { workerId: 'A', heartbeatMs: 10, signal: stop.signal },
    async (run) => {
      interceptHeartbeat = true;
      await within(heartbeatAttempted.promise, 'first-stop-cause heartbeat attempt');
      stop.abort(callerStop);
      rejectHeartbeat(lateHeartbeatFailure);
      await nextTurn();
      signalCauseExact = run.signal.reason === callerStop;
      return run.succeed();
    },
  );
  return {
    kind: 'firstStopCause',
    exactCause: result.status === 'interrupted' && result.error === callerStop,
    signalCauseExact,
    leftRunning: (await queue.inspect('job')).phase.state === 'running',
  };
}

async function undefinedHeartbeatSample(adapter) {
  const fixture = adapterFixture(adapter);
  let failHeartbeat = false;
  const heartbeatAttempted = deferred();
  try {
    const store = {
      ...fixture.store,
      async atomic(id, decide) {
        if (failHeartbeat) {
          heartbeatAttempted.resolve();
          throw undefined;
        }
        return fixture.store.atomic(id, decide);
      },
    };
    const queue = createWorkOnce({ store, scope: `runner-undefined-${adapter}` }).define('job', {
      limits: { leaseMs: 500, maxAttempts: 3, maxElapsedMs: 1000, maxDeferrals: 2 },
    });
    await queue.ensure(null, { key: 'job' });
    const [result] = await queue.runAvailable({ workerId: 'A', heartbeatMs: 5 }, async (run) => {
      failHeartbeat = true;
      await within(heartbeatAttempted.promise, `${adapter}-undefined-heartbeat storage attempt`);
      await waitForAbort(run.signal, `${adapter}-undefined-heartbeat ownership abort`);
      return run.succeed();
    });
    return {
      kind: 'undefinedHeartbeat',
      adapter,
      interrupted: result.status === 'interrupted',
      exactUndefined:
        result.status === 'interrupted' &&
        Object.prototype.hasOwnProperty.call(result, 'error') &&
        result.error === undefined,
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

async function firstFatalPreservationSample() {
  const queue = createWorkOnce({ store: createMemoryStore(), scope: 'local-first-fatal' }).define(
    'job',
    { key: (input) => input.id, limits: { leaseMs: 5000 } },
  );
  await queue.ensure({ id: 'a' });
  await queue.ensure({ id: 'b' });
  const first = new Error('local first fatal A');
  const second = new Error('local second fatal B');
  const bothStarted = deferred();
  let started = 0;
  const stop = new AbortController();
  let result;
  try {
    result = await within(
      observe(
        queue.run(
          {
            workerId: 'local-first-fatal',
            concurrency: 2,
            heartbeatMs: 100,
            idleMs: 1000,
            signal: stop.signal,
          },
          async (_run, input) => {
            started++;
            if (started === 2) bothStarted.resolve();
            await within(bothStarted.promise, 'local first-fatal both-active');
            if (input.id === 'a') throw first;
            await sleep(20);
            throw second;
          },
        ),
      ),
      'local first-fatal runner exit',
    );
  } finally {
    stop.abort();
  }
  return {
    kind: 'firstFatal',
    bothActive: started === 2,
    exactFirst: result.rejected && result.error === first,
  };
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
  try {
    await waitUntil(() => starts.length >= 2);
    for (let index = 6; index < 10; index++) await queue.ensure({ index }, { key: String(index) });
    await waitUntil(async () => {
      const snapshots = await queue.inspectMany(
        Array.from({ length: 10 }, (_, index) => String(index)),
      );
      return snapshots.every((snapshot) => snapshot?.phase.state === 'succeeded');
    });
    stop.abort();
    await within(running, 'dynamic-arrival runner exit');
    return {
      kind: 'dynamicArrival',
      allTen: counts.size === 10 && [...counts.values()].every((count) => count === 1),
      boundedCapacity: peak === 3,
      refilledAroundSlow: laterBeforeSlow,
    };
  } finally {
    stop.abort();
    await within(Promise.allSettled([running]), 'dynamic-arrival runner cleanup');
  }
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
  try {
    await waitUntil(async () => (await queue.inspect('job')).phase.state === 'succeeded');
    stop.abort();
    await within(running, 'handled-recovery runner exit');
    return {
      kind: 'handledRecovery',
      exactErrors: observed.length === 3 && observed.every((error) => error === failure),
      eventuallyRanOnce: calls === 1,
    };
  } finally {
    stop.abort();
    await within(Promise.allSettled([running]), 'handled-recovery runner cleanup');
  }
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
        await within(release.promise, `competing runner release ${input.index}`);
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
    try {
      await within(firstWave.promise, 'competing runners first wave');
      release.resolve();
      await waitUntil(async () => {
        const snapshots = await first.inspectMany(['0', '1', '2', '3']);
        return snapshots.every((snapshot) => snapshot?.phase.state === 'succeeded');
      });
      stopA.abort();
      stopB.abort();
      await within(Promise.all([runningA, runningB]), `competing runners exit ${adapter}`);
      return {
        kind: 'competingRunners',
        adapter,
        bothOwners: owners.has('A') && owners.has('B'),
        exactlyOnce: counts.size === 4 && [...counts.values()].every((count) => count === 1),
      };
    } finally {
      release.resolve();
      stopA.abort();
      stopB.abort();
      await within(
        Promise.allSettled([runningA, runningB]),
        `competing runners cleanup ${adapter}`,
      );
    }
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
    await within(release[input].promise, `completion-order ${input} release`);
    return run.succeed(input);
  });
  await within(Promise.all([entered.a.promise, entered.b.promise]), 'completion-order entries');
  const order = reverse ? ['b', 'a'] : ['a', 'b'];
  release[order[0]].resolve();
  await nextTurn();
  release[order[1]].resolve();
  await within(running, 'completion-order runner exit');
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
  const running = queue.run(
    {
      workerId: 'history',
      idleMs: 1,
      signal: stop.signal,
      onError(error) {
        stop.abort(new Error('handled-stop'));
        assert.equal(error, failure);
      },
    },
    async (run) => run.succeed(),
  );
  try {
    await within(running, `history-${handled} runner exit`);
    const durable = semanticSnapshot(await queue.inspect('job'));
    const [future] = await queue.runAvailable({ workerId: 'future' }, async (run) => run.succeed());
    return { durable, future: future.status };
  } finally {
    stop.abort(new Error('history-cleanup'));
    await within(Promise.allSettled([running]), `history-${handled} runner cleanup`);
  }
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
      await within(release.promise, 'observer-backoff handler release');
      return run.succeed();
    },
  );
  try {
    await waitUntil(async () => (await queue.inspect('job')).phase.state === 'succeeded');
    stop.abort();
    await within(running, 'observer-backoff runner exit');
    const durable = semanticSnapshot(await queue.inspect('job'));
    await queue.ensure(null, { key: 'future' });
    const [future] = await queue.runAvailable({ workerId: 'future' }, async (run) => run.succeed());
    return { observed, durable, future: future.status };
  } finally {
    release.resolve();
    stop.abort();
    await within(Promise.allSettled([running]), 'observer-backoff runner cleanup');
  }
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
    await within(releaseSecondClaim.promise, 'late second claim release');
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
        await within(releaseFirstHandler.promise, 'late first handler release');
      }
      return run.succeed();
    },
  );
  try {
    await within(
      Promise.all([firstHandlerEntered.promise, secondClaimEntered.promise]),
      'late claim/handler entries',
    );
    stop.abort(new Error('late-claim-stop'));
    releaseFirstHandler.resolve();
    await nextTurn();
    releaseSecondClaim.resolve();
    await within(running, 'late-claim-stop runner exit');
    const late = await queue.inspect('b');
    return {
      kind: 'lateClaimStop',
      oneHandler: started.length === 1 && started[0] === 'a',
      lateLeaseNotExecuted: late.phase.state === 'running',
    };
  } finally {
    stop.abort(new Error('late-claim-stop-cleanup'));
    releaseFirstHandler.resolve();
    releaseSecondClaim.resolve();
    await within(Promise.allSettled([running]), 'late-claim-stop runner cleanup');
  }
}

async function oneTickCompletionSample() {
  const queue = createWorkOnce({
    store: createMemoryStore({ now: () => 100 }),
    scope: 'runner-one-tick-completion',
  }).define('job', { limits: { leaseMs: 1 } });
  await queue.ensure(null, { key: 'job' });
  let handlerCalls = 0;
  const [result] = await queue.runAvailable({ workerId: 'one-tick' }, async (run) => {
    handlerCalls++;
    return run.succeed();
  });
  const snapshot = await queue.inspect('job');
  const settled =
    result.status === 'settled' && handlerCalls === 1 && snapshot.phase.state === 'succeeded';
  return {
    settled,
    compatible:
      settled ||
      (result.status === 'interrupted' &&
        result.error instanceof Error &&
        result.error.message === 'Confirmed lease deadline passed' &&
        snapshot.phase.state === 'running'),
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
    await within(running, 'huge-idle runner exit');
    return performance.now() - started < 250;
  }
  return {
    kind: 'timerBoundary',
    exactLeaseRejects: await exactLease(),
    oneBelowAccepts: await justBelow(),
    hugeFiniteAccepted: await hugeTimer(),
    expiryCauseExact: await oneMsExpiry(),
    oneTickCompletionCompatible: (await oneTickCompletionSample()).compatible,
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
  const running = observe(
    queue.run(
      { workerId: 'wake', concurrency: 2, heartbeatMs: 20, idleMs: 800, signal: stop.signal },
      async (run) => {
        failAtomic = true;
        await sleep(80);
        return run.succeed();
      },
    ),
  );
  let result;
  try {
    result = await within(running, 'wake-poll runner exit');
  } finally {
    failAtomic = false;
    stop.abort();
    await within(Promise.allSettled([running]), 'wake-poll runner drain');
  }
  return {
    kind: 'wakePoll',
    exactCause: result.rejected && result.error === failure,
    promptlyWoken: performance.now() - started < 400,
  };
}

export async function assertLocalRunnerMutationWitness(kind) {
  if (kind === 'oneTickCompletion') {
    // This selector runs in an isolated mutation subprocess. Freeze only its monotonic
    // clock to prove completion before expiry without relying on sub-millisecond CPU speed.
    // The normal formal sample above and the delayed-expiry sibling retain real timers.
    const originalNow = performance.now;
    try {
      performance.now = () => 0;
      const sample = await oneTickCompletionSample();
      assert.equal(sample.settled, true, `oneTickCompletion:${JSON.stringify(sample)}`);
    } finally {
      performance.now = originalNow;
    }
    return;
  }
  if (kind === 'firstStopCause') {
    const sample = await firstStopCauseSample();
    assert.equal(sample.exactCause, true, `firstStopCause:${JSON.stringify(sample)}`);
    assert.equal(sample.signalCauseExact, true, `firstStopCause:${JSON.stringify(sample)}`);
    assert.equal(sample.leftRunning, true, `firstStopCause:${JSON.stringify(sample)}`);
    return;
  }
  if (kind === 'firstFatal') {
    const sample = await firstFatalPreservationSample();
    assert.equal(sample.bothActive, true, `firstFatal:${JSON.stringify(sample)}`);
    assert.equal(sample.exactFirst, true, `firstFatal:${JSON.stringify(sample)}`);
    return;
  }
  if (kind === 'ownershipCause') {
    const sample = await stopReclaimSample('memory', 'heartbeat');
    assert.equal(sample.exactCause, true, `ownershipCause:${JSON.stringify(sample)}`);
    return;
  }
  if (kind === 'lateClaimStop') {
    const sample = await lateClaimStopSample();
    assert.equal(sample.oneHandler, true, `lateClaimStop:${JSON.stringify(sample)}`);
    assert.equal(sample.lateLeaseNotExecuted, true, `lateClaimStop:${JSON.stringify(sample)}`);
    return;
  }
  if (kind === 'wakePoll') {
    const sample = await wakePollSample();
    assert.equal(sample.exactCause, true, `wakePoll:${JSON.stringify(sample)}`);
    assert.equal(sample.promptlyWoken, true, `wakePoll:${JSON.stringify(sample)}`);
    return;
  }
  assert.fail(`Unknown local-runner mutation witness: ${kind}`);
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
  samples.push(await firstFatalPreservationSample());
  samples.push(await firstStopCauseSample());
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
  assert.equal(samples.length, 25, 'local runner refinement sample family unexpectedly changed');
  assert.deepEqual(
    samples.map((sample) => sample.kind).sort(),
    [
      'backoffHistory',
      'competingRunners',
      'competingRunners',
      'competingRunners',
      'completionOrder',
      'dynamicArrival',
      'firstFatal',
      'firstStopCause',
      'handledAbortHistory',
      'handledRecovery',
      'lateClaimStop',
      'settleCause',
      'settleCause',
      'settleCause',
      'stopReclaim',
      'stopReclaim',
      'stopReclaim',
      'stopReclaim',
      'stopReclaim',
      'stopReclaim',
      'timerBoundary',
      'undefinedHeartbeat',
      'undefinedHeartbeat',
      'undefinedHeartbeat',
      'wakePoll',
    ],
    'local runner refinement kind coverage drifted',
  );
  assert.deepEqual(
    samples
      .filter((sample) => sample.kind === 'stopReclaim')
      .map((sample) => `${sample.adapter}:${sample.mode}`)
      .sort(),
    [
      'cas:caller',
      'cas:heartbeat',
      'memory:caller',
      'memory:heartbeat',
      'sqlite:caller',
      'sqlite:heartbeat',
    ],
    'stopReclaim adapter/mode coverage drifted',
  );
  for (const kind of ['undefinedHeartbeat', 'settleCause', 'competingRunners'])
    assert.deepEqual(
      samples
        .filter((sample) => sample.kind === kind)
        .map((sample) => sample.adapter)
        .sort(),
      ['cas', 'memory', 'sqlite'],
      `${kind} adapter coverage drifted`,
    );
  const booleanFields = {
    stopReclaim: ['exactCause', 'leftRunning', 'reclaimAdvanced'],
    undefinedHeartbeat: ['interrupted', 'exactUndefined'],
    settleCause: ['exactCause', 'stillRunning'],
    competingRunners: ['bothOwners', 'exactlyOnce'],
    firstFatal: ['bothActive', 'exactFirst'],
    firstStopCause: ['exactCause', 'signalCauseExact', 'leftRunning'],
    dynamicArrival: ['allTen', 'boundedCapacity', 'refilledAroundSlow'],
    handledRecovery: ['exactErrors', 'eventuallyRanOnce'],
    completionOrder: ['sameProjection', 'sameFuture'],
    handledAbortHistory: ['sameDurable', 'sameFuture'],
    backoffHistory: ['handledOnce', 'sameDurable', 'sameFuture'],
    lateClaimStop: ['oneHandler', 'lateLeaseNotExecuted'],
    timerBoundary: [
      'exactLeaseRejects',
      'oneBelowAccepts',
      'hugeFiniteAccepted',
      'expiryCauseExact',
      'oneTickCompletionCompatible',
      'hugeIdleInterruptible',
    ],
    wakePoll: ['exactCause', 'promptlyWoken'],
  };
  const metadataFields = {
    stopReclaim: ['adapter', 'mode'],
    undefinedHeartbeat: ['adapter'],
    settleCause: ['adapter'],
    competingRunners: ['adapter'],
  };
  for (const sample of samples) {
    const fields = booleanFields[sample.kind];
    assert.ok(fields, `Unmapped local runner sample: ${JSON.stringify(sample)}`);
    assertExactBooleanSample(sample, fields, metadataFields[sample.kind] ?? []);
  }
  return samples.length;
}
