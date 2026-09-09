import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createCompareExchangeStore } from '../dist/cas.js';
import { createWorkOnce, runExternal, runExternalAvailable } from '../dist/index.js';
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
function adapterFixture(kind, scope, options = {}) {
  let now = options.now ?? 100;
  if (kind === 'memory') {
    return {
      kind,
      store: createMemoryStore({ now: () => now }),
      setNow(value) {
        now = value;
      },
      close() {},
    };
  }
  if (kind === 'sqlite') {
    const directory = mkdtempSync(join(tmpdir(), 'workonce-external-proof-'));
    const store = createSqliteStore(join(directory, 'workonce.sqlite'), { now: () => now });
    return {
      kind,
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
  if (kind === 'cas') {
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
      kind,
      store: createCompareExchangeStore(port),
      setNow(value) {
        now = value;
      },
      close() {},
    };
  }
  throw new Error(`Unknown adapter ${kind} for ${scope}`);
}
function serviceFor(fixture, scope, options = {}) {
  const work = createWorkOnce({ store: fixture.store, scope });
  const queue = work.define('job', {
    key: (input) => input.id,
    retry: { retry: true, afterMs: 0, maxRetries: 2, manualRetry: true },
    limits: { leaseMs: options.leaseMs ?? 20, maxAttempts: 4, maxElapsedMs: 1000 },
  });
  const service = queue.serveExternal({
    prepare: options.prepare ?? ((run) => run.handoff(run.input)),
    onPrepareError: options.onPrepareError ?? ((run) => run.retry('prepare_error')),
  });
  return { work, queue, service };
}

async function handoffHistoryLane(asyncPrepare) {
  const fixture = adapterFixture('memory', 'external-history');
  const prepareHistory = [];
  try {
    const { queue, service } = serviceFor(fixture, 'external-history', {
      prepare: asyncPrepare
        ? async (run) => {
            prepareHistory.push('entered');
            await Promise.resolve();
            prepareHistory.push('resumed');
            return run.handoff(run.input);
          }
        : (run) => {
            prepareHistory.push('entered');
            return run.handoff(run.input);
          },
    });
    await queue.ensure({ id: 'x', value: 1 });
    const [lease] = await service.claim({ workerId: 'relay', limit: 1 });
    const afterClaim = (await fixture.store.getMany([lease.attempt.workId])).rows[0];
    const heartbeat = await service.heartbeat(lease.attempt);
    const phase = await service.settle(lease.attempt, { type: 'succeed', result: null, next: [] });
    return { lease, afterClaim, heartbeat, phase, final: await queue.inspect('x'), prepareHistory };
  } finally {
    fixture.close();
  }
}
async function handoffHistorySample() {
  const direct = await handoffHistoryLane(false);
  const asyncLane = await handoffHistoryLane(true);
  return {
    kind: 'handoffHistory',
    materiallyDifferentHistory: stable(direct.prepareHistory) !== stable(asyncLane.prepareHistory),
    sameLease: stable(direct.lease) === stable(asyncLane.lease),
    sameDurableProjection: stable(direct.afterClaim) === stable(asyncLane.afterClaim),
    sameFuture:
      stable({ heartbeat: direct.heartbeat, phase: direct.phase, final: direct.final }) ===
      stable({ heartbeat: asyncLane.heartbeat, phase: asyncLane.phase, final: asyncLane.final }),
  };
}

async function prepareRaceSample(race) {
  const fixture = adapterFixture('memory', `external-prepare-${race}`);
  const entered = deferred();
  const release = deferred();
  let onErrorCalls = 0;
  try {
    const { queue, service } = serviceFor(fixture, `external-prepare-${race}`, {
      leaseMs: 5,
      prepare: async (run) => {
        entered.resolve();
        await within(release.promise, 'external prepare-race release');
        return run.handoff(run.input);
      },
      onPrepareError: (run) => {
        onErrorCalls++;
        return run.retry('prepare_error');
      },
    });
    await queue.ensure({ id: 'x' });
    const claiming = service.claim({ workerId: 'relay', limit: 1 });
    await within(entered.promise, 'external prepare-race entry');
    let winner;
    if (race === 'cancel') {
      winner = await queue.cancel({ key: 'x', generation: 1, reason: 'cancelled' });
    } else {
      fixture.setNow(105);
      [winner] = await queue.claim({ workerId: 'reclaimer', limit: 1 });
      assert.ok(winner);
    }
    release.resolve();
    const leases = await claiming;
    const snapshot = await queue.inspect('x');
    return {
      kind: 'prepareRace',
      race,
      noStaleLeaseExported: leases.length === 0,
      noDomainErrorConversion: onErrorCalls === 0,
      winnerPreserved:
        race === 'cancel'
          ? winner.phase.state === 'cancelled' && snapshot.phase.state === 'cancelled'
          : winner.ref.fence === 2 &&
            snapshot.phase.state === 'running' &&
            snapshot.phase.attempt.fence === 2,
    };
  } finally {
    release.resolve();
    fixture.close();
  }
}

async function preparationDispositionSample() {
  const fixture = adapterFixture('memory', 'external-preparation-disposition');
  const sentinel = new Error('prepare exploded');
  let exactErrorObserved = false;
  try {
    const { queue, service } = serviceFor(fixture, 'external-preparation-disposition', {
      prepare: (run) => {
        if (run.input.mode === 'wait') return run.wait('not_ready', { afterMs: 0 });
        if (run.input.mode === 'error') throw sentinel;
        return run.handoff(run.input);
      },
      onPrepareError: (run, error) => {
        exactErrorObserved = error === sentinel;
        return run.retry('prepare_error', { afterMs: 0 });
      },
    });
    await queue.ensure({ id: 'wait', mode: 'wait' });
    await queue.ensure({ id: 'error', mode: 'error' });
    await queue.ensure({ id: 'go', mode: 'handoff' });
    const leases = await service.claim({ workerId: 'relay', limit: 3 });
    const wait = await queue.inspect('wait');
    const error = await queue.inspect('error');
    const go = await queue.inspect('go');
    return {
      kind: 'prepareDisposition',
      oneLease: leases.length === 1 && leases[0].input.id === 'go',
      waitSettledLocally: wait.phase.state === 'waiting' && wait.phase.cause === 'defer',
      errorSettledLocally: error.phase.state === 'waiting' && error.phase.cause === 'retry',
      healthyStillRunning: go.phase.state === 'running',
      exactPrepareError: exactErrorObserved,
    };
  } finally {
    fixture.close();
  }
}

async function unknownSettleAckSample() {
  const fixture = adapterFixture('memory', 'external-unknown-ack');
  const ackError = new Error('settle ACK lost');
  let lose = true;
  let handlerCalls = 0;
  let savedAttempt;
  let savedOutcome;
  try {
    const { queue, service } = serviceFor(fixture, 'external-unknown-ack');
    await queue.ensure({ id: 'x' });
    const transport = {
      ...service,
      async settle(attempt, outcome) {
        savedAttempt = attempt;
        savedOutcome = outcome;
        const phase = await service.settle(attempt, outcome);
        if (lose) {
          lose = false;
          throw ackError;
        }
        return phase;
      },
    };
    const [result] = await runExternalAvailable(
      transport,
      { workerId: 'relay', signal: new AbortController().signal },
      async (run) => {
        handlerCalls++;
        return run.succeed();
      },
    );
    const committed = await queue.inspect('x');
    const replay = await service.settle(savedAttempt, savedOutcome);
    let laterCalls = 0;
    const later = await runExternalAvailable(
      service,
      { workerId: 'later', signal: new AbortController().signal },
      async (run) => {
        laterCalls++;
        return run.succeed();
      },
    );
    return {
      kind: 'unknownSettleAck',
      exactAckError: result.status === 'interrupted' && result.error === ackError,
      handlerOnce: handlerCalls === 1,
      durableSuccess: committed.phase.state === 'succeeded',
      replayConverged: replay.state === 'succeeded',
      noLocalRerun: later.length === 0 && laterCalls === 0,
    };
  } finally {
    fixture.close();
  }
}

async function staleForeignAttemptSample() {
  const fixture = adapterFixture('memory', 'external-stale-foreign');
  try {
    const { queue, service } = serviceFor(fixture, 'external-stale-foreign', { leaseMs: 5 });
    await queue.ensure({ id: 'x' });
    const [oldLease] = await service.claim({ workerId: 'old', limit: 1 });
    fixture.setNow(105);
    const [newLease] = await service.claim({ workerId: 'new', limit: 1 });
    const oldHeartbeat = await observe(service.heartbeat(oldLease.attempt));
    const oldSettle = await observe(
      service.settle(oldLease.attempt, { type: 'succeed', result: null, next: [] }),
    );
    const before = await queue.inspect('x');
    const winner = await service.settle(newLease.attempt, {
      type: 'succeed',
      result: null,
      next: [],
    });
    return {
      kind: 'staleForeignAttempt',
      fenceAdvanced: newLease.attempt.fence === oldLease.attempt.fence + 1,
      heartbeatExact: oldHeartbeat.error?.code === 'stale_attempt',
      settleExact: oldSettle.error?.code === 'stale_attempt',
      winnerPreserved:
        before.phase.state === 'running' && before.phase.attempt.fence === newLease.attempt.fence,
      winnerSettled: winner.state === 'succeeded',
    };
  } finally {
    fixture.close();
  }
}

async function syntheticCapacitySample() {
  const stop = new AbortController();
  const sentinel = new Error('bad external handler');
  const starts = [];
  const claimLimits = [];
  const settled = [];
  let claimCall = 0;
  let observedExact = false;
  const lease = (id, fence = 1) => ({
    input: { id },
    attempt: { workId: id, generation: 1, fence },
    observedAt: 0,
    leaseUntil: 10_000,
  });
  const transport = {
    async claim({ limit }) {
      claimLimits.push(limit);
      claimCall++;
      if (claimCall === 1) return [lease('bad'), lease('healthy-1')].slice(0, limit);
      if (claimCall === 2) return [lease('healthy-2')].slice(0, limit);
      return [];
    },
    async heartbeat() {
      return { observedAt: 0, leaseUntil: 10_000 };
    },
    async settle(attempt) {
      settled.push(attempt.workId);
      if (settled.includes('healthy-1') && settled.includes('healthy-2'))
        setTimeout(() => stop.abort(), 0);
      return { state: 'succeeded', result: null };
    },
  };
  let observedWithinDeadline = true;
  const deadline = setTimeout(() => {
    observedWithinDeadline = false;
    stop.abort(new Error('capacity sample deadline'));
  }, 3000);
  let managed;
  try {
    managed = await observe(
      runExternal(
        transport,
        {
          workerId: 'relay',
          concurrency: 2,
          idleMs: 1,
          signal: stop.signal,
          onError(error) {
            observedExact ||= error === sentinel;
          },
        },
        async (run, input) => {
          starts.push(input.id);
          if (input.id === 'bad') throw sentinel;
          if (input.id === 'healthy-1') await sleep(40);
          return run.succeed();
        },
      ),
    );
  } finally {
    clearTimeout(deadline);
  }
  return {
    kind: 'capacityFairness',
    observedWithinDeadline,
    exactHandledFailure: observedExact,
    laterHealthyAdmitted: starts.includes('healthy-2'),
    healthySettled: settled.includes('healthy-1') && settled.includes('healthy-2'),
    boundedClaims: claimLimits.every((limit) => limit <= 2) && claimLimits.includes(1),
    noFatalEscape: managed !== undefined && !managed.rejected,
  };
}

async function oversizedClaimSample() {
  let handlers = 0;
  const lease = (id) => ({
    input: { id },
    attempt: { workId: id, generation: 1, fence: 1 },
    observedAt: 0,
    leaseUntil: 100,
  });
  const transport = {
    async claim() {
      return [lease('a'), lease('b')];
    },
    async heartbeat() {
      return { observedAt: 0, leaseUntil: 100 };
    },
    async settle() {
      return { state: 'succeeded', result: null };
    },
  };
  const result = await observe(
    runExternalAvailable(
      transport,
      { workerId: 'relay', concurrency: 1, signal: new AbortController().signal },
      async (run) => {
        handlers++;
        return run.succeed();
      },
    ),
  );
  return {
    kind: 'oversizedClaim',
    exactError:
      result.error instanceof RangeError &&
      result.error.message === 'External claim returned more leases than requested',
    noHandlerStarted: handlers === 0,
  };
}

async function stopSignalSample() {
  const pre = new AbortController();
  pre.abort(new Error('already stopped'));
  let preClaims = 0;
  const preTransport = {
    async claim() {
      preClaims++;
      return [];
    },
    async heartbeat() {
      throw new Error('unexpected');
    },
    async settle() {
      throw new Error('unexpected');
    },
  };
  const preResult = await runExternalAvailable(
    preTransport,
    { workerId: 'relay', signal: pre.signal },
    async (run) => run.succeed(),
  );

  const stop = new AbortController();
  let exactSignal = false;
  let claimEntered = false;
  const transport = {
    claim(request) {
      claimEntered = true;
      exactSignal = request.signal === stop.signal;
      return new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), {
          once: true,
        });
      });
    },
    async heartbeat() {
      throw new Error('unexpected');
    },
    async settle() {
      throw new Error('unexpected');
    },
  };
  const running = runExternal(transport, { workerId: 'relay', signal: stop.signal }, async (run) =>
    run.succeed(),
  );
  await within(
    (async () => {
      while (!claimEntered) await sleep(1);
    })(),
    'external stop-signal claim entry',
  );
  stop.abort(new Error('shutdown'));
  const managed = await observe(running);
  return {
    kind: 'stopSignal',
    preAbortedNoClaim: preResult.length === 0 && preClaims === 0,
    sameSignalPropagated: exactSignal,
    abortDuringClaimFulfills: !managed.rejected,
  };
}

async function leaseBoundarySample() {
  async function one(lease, claimDelayMs = 0) {
    let handlerCalls = 0;
    let settleCalls = 0;
    let heartbeatCalls = 0;
    const transport = {
      async claim() {
        if (claimDelayMs > 0) await sleep(claimDelayMs);
        return [lease];
      },
      async heartbeat() {
        heartbeatCalls++;
        return { observedAt: lease.observedAt, leaseUntil: lease.leaseUntil };
      },
      async settle() {
        settleCalls++;
        return { state: 'succeeded', result: null };
      },
    };
    const [result] = await runExternalAvailable(
      transport,
      { workerId: 'relay', signal: new AbortController().signal },
      async (run) => {
        handlerCalls++;
        return run.succeed();
      },
    );
    return { result, handlerCalls, settleCalls, heartbeatCalls };
  }
  const invalidZero = await one({
    input: null,
    attempt: { workId: 'zero', generation: 1, fence: 1 },
    observedAt: 100,
    leaseUntil: 100,
  });
  const invalidNaN = await one({
    input: null,
    attempt: { workId: 'nan', generation: 1, fence: 1 },
    observedAt: Number.NaN,
    leaseUntil: Number.NaN,
  });
  const maxFinite = await one({
    input: null,
    attempt: { workId: 'max', generation: 1, fence: 1 },
    observedAt: 0,
    leaseUntil: Number.MAX_SAFE_INTEGER,
  });
  const oneTick = await one({
    input: null,
    attempt: { workId: 'one-tick', generation: 1, fence: 1 },
    observedAt: 100,
    leaseUntil: 101,
  });
  const delayedOneTick = await one(
    {
      input: null,
      attempt: { workId: 'delayed-one-tick', generation: 1, fence: 1 },
      observedAt: 100,
      leaseUntil: 101,
    },
    5,
  );
  let heartbeatConfigHandlers = 0;
  const heartbeatConfig = await observe(
    runExternalAvailable(
      {
        async claim() {
          return [
            {
              input: null,
              attempt: { workId: 'config', generation: 1, fence: 1 },
              observedAt: 100,
              leaseUntil: 110,
            },
          ];
        },
        async heartbeat() {
          return { observedAt: 100, leaseUntil: 110 };
        },
        async settle() {
          return { state: 'succeeded', result: null };
        },
      },
      { workerId: 'relay', heartbeatMs: 10, signal: new AbortController().signal },
      async (run) => {
        heartbeatConfigHandlers++;
        return run.succeed();
      },
    ),
  );
  const renewedLeaseError = new RangeError('External renewed lease must be positive');
  let invalidRenewalSettleCalls = 0;
  const invalidRenewal = await runExternalAvailable(
    {
      async claim() {
        return [
          {
            input: null,
            attempt: { workId: 'invalid-renewal', generation: 1, fence: 1 },
            observedAt: 0,
            leaseUntil: 20,
          },
        ];
      },
      async heartbeat() {
        return { observedAt: 10, leaseUntil: 10 };
      },
      async settle() {
        invalidRenewalSettleCalls++;
        return { state: 'succeeded', result: null };
      },
    },
    { workerId: 'relay', heartbeatMs: 5, signal: new AbortController().signal },
    async (run) => {
      await sleep(20);
      return run.succeed();
    },
  );
  return {
    kind: 'leaseBoundary',
    zeroRejectedBeforeHandler:
      invalidZero.result.status === 'interrupted' &&
      String(invalidZero.result.error).includes('External lease must be positive') &&
      invalidZero.handlerCalls === 0 &&
      invalidZero.settleCalls === 0,
    nanRejectedBeforeHandler:
      invalidNaN.result.status === 'interrupted' &&
      String(invalidNaN.result.error).includes('External lease must be positive') &&
      invalidNaN.handlerCalls === 0 &&
      invalidNaN.settleCalls === 0,
    maxSafeAccepted:
      maxFinite.result.status === 'settled' &&
      maxFinite.handlerCalls === 1 &&
      maxFinite.settleCalls === 1,
    oneTickHeartbeatCompatible:
      oneTick.heartbeatCalls === 0 &&
      ((oneTick.result.status === 'settled' &&
        oneTick.handlerCalls === 1 &&
        oneTick.settleCalls === 1) ||
        (oneTick.result.status === 'interrupted' &&
          String(oneTick.result.error).includes('Confirmed external lease deadline passed') &&
          oneTick.handlerCalls <= 1 &&
          oneTick.settleCalls === 0)) &&
      delayedOneTick.result.status === 'interrupted' &&
      String(delayedOneTick.result.error).includes('Confirmed external lease deadline passed') &&
      delayedOneTick.handlerCalls === 0 &&
      delayedOneTick.settleCalls === 0 &&
      delayedOneTick.heartbeatCalls === 0,
    invalidRenewalExact:
      invalidRenewal[0]?.status === 'interrupted' &&
      invalidRenewal[0]?.error instanceof RangeError &&
      invalidRenewal[0]?.error.message === renewedLeaseError.message &&
      invalidRenewalSettleCalls === 0,
    exactHeartbeatBoundary:
      heartbeatConfig.rejected === false &&
      heartbeatConfig.value[0]?.status === 'interrupted' &&
      String(heartbeatConfig.value[0]?.error).includes(
        'heartbeatMs must be shorter than the lease',
      ) &&
      heartbeatConfigHandlers === 0,
  };
}

async function heartbeatFailureSample() {
  const failure = new Error('heartbeat network failure');
  let settleCalls = 0;
  let sawAbort = false;
  const transport = {
    async claim() {
      return [
        {
          input: null,
          attempt: { workId: 'x', generation: 1, fence: 1 },
          observedAt: 0,
          leaseUntil: 100,
        },
      ];
    },
    async heartbeat() {
      throw failure;
    },
    async settle() {
      settleCalls++;
      return { state: 'succeeded', result: null };
    },
  };
  const [result] = await runExternalAvailable(
    transport,
    { workerId: 'relay', heartbeatMs: 5, signal: new AbortController().signal },
    async (run) => {
      await sleep(20);
      sawAbort = run.signal.aborted;
      return run.succeed();
    },
  );
  return {
    kind: 'heartbeatFailure',
    exactAbortObserved: sawAbort,
    interruptedBeforeSettle: result.status === 'interrupted' && settleCalls === 0,
    ownershipLossCause: result.status === 'interrupted' && result.error === failure,
  };
}

async function adapterProjection(adapter) {
  const fixture = adapterFixture(adapter, 'external-adapter');
  try {
    const { queue, service } = serviceFor(fixture, 'external-adapter');
    await queue.ensure({ id: 'x', payload: 1 });
    const [lease] = await service.claim({ workerId: 'relay', limit: 1 });
    const beat = await service.heartbeat(lease.attempt);
    const outcome = { type: 'succeed', result: null, next: [] };
    const first = await service.settle(lease.attempt, outcome);
    const replay = await service.settle(lease.attempt, outcome);
    const conflict = await observe(
      service.settle(lease.attempt, {
        type: 'fail',
        reason: 'different',
        manualRetry: false,
        result: null,
        next: [],
      }),
    );
    return {
      lease,
      beat,
      first,
      replay,
      conflict: conflict.error?.code,
      snapshot: await queue.inspect('x'),
      nextClaim: (await service.claim({ workerId: 'later', limit: 1 })).length,
    };
  } finally {
    fixture.close();
  }
}
async function adapterEquivalenceSample() {
  const values = [];
  for (const adapter of ['memory', 'sqlite', 'cas']) values.push(await adapterProjection(adapter));
  return {
    kind: 'externalAdapterEquivalence',
    equivalent: values.every((value) => stable(value) === stable(values[0])),
    adapters: 'memory,sqlite,cas',
    exactConflict: values.every((value) => value.conflict === 'settlement_conflict'),
  };
}

async function unknownAckHistorySample() {
  async function lane(loseAck) {
    const fixture = adapterFixture('memory', 'external-ack-history');
    try {
      const { queue, service } = serviceFor(fixture, 'external-ack-history');
      await queue.ensure({ id: 'x' });
      let firstAttempt;
      let firstOutcome;
      let lose = loseAck;
      const transport = {
        ...service,
        async heartbeat() {
          return { observedAt: 100, leaseUntil: 120 };
        },
        async settle(attempt, outcome) {
          firstAttempt = attempt;
          firstOutcome = outcome;
          const phase = await service.settle(attempt, outcome);
          if (lose) {
            lose = false;
            throw new Error('unknown ACK');
          }
          return phase;
        },
      };
      const [result] = await runExternalAvailable(
        transport,
        { workerId: 'relay', signal: new AbortController().signal },
        async (run) => run.succeed(),
      );
      const durable = (await fixture.store.getMany([firstAttempt.workId])).rows[0];
      const future = {
        replay: (await service.settle(firstAttempt, firstOutcome)).state,
        laterClaims: (await service.claim({ workerId: 'later', limit: 1 })).length,
      };
      return { result: result.status, durable, future };
    } finally {
      fixture.close();
    }
  }
  const acked = await lane(false);
  const unknown = await lane(true);
  return {
    kind: 'unknownAckHistory',
    materiallyDifferentCallerHistory:
      acked.result === 'settled' && unknown.result === 'interrupted',
    sameDurableProjection: stable(acked.durable) === stable(unknown.durable),
    sameFuture: stable(acked.future) === stable(unknown.future),
  };
}

export async function runExternalTransportSamples() {
  return [
    await handoffHistorySample(),
    await prepareRaceSample('cancel'),
    await prepareRaceSample('reclaim'),
    await preparationDispositionSample(),
    await unknownSettleAckSample(),
    await staleForeignAttemptSample(),
    await syntheticCapacitySample(),
    await oversizedClaimSample(),
    await stopSignalSample(),
    await leaseBoundarySample(),
    await heartbeatFailureSample(),
    await adapterEquivalenceSample(),
    await unknownAckHistorySample(),
  ];
}

export function assertExternalTransportSamples(samples) {
  assert.equal(samples.length, 13, 'external transport sample family unexpectedly changed');
  for (const sample of samples) {
    const name = JSON.stringify(sample);
    for (const [field, value] of Object.entries(sample)) {
      if (field === 'kind' || field === 'race' || field === 'adapters') continue;
      if (typeof value === 'boolean') assert.equal(value, true, `${sample.kind}.${field}: ${name}`);
    }
  }
  return samples.length;
}
