import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompareExchangeStore } from '../dist/cas.js';
import { createWorkOnce, exponentialBackoff } from '../dist/index.js';
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
function adapterFixture(kind) {
  let now = 100;
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
    const directory = mkdtempSync(join(tmpdir(), 'workonce-policy-proof-'));
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
  throw new Error(`Unknown adapter ${kind}`);
}
async function claimOne(queue, workerId = 'A') {
  const [run] = await queue.claim({ workerId, limit: 1 });
  assert.ok(run, 'expected one claim');
  return run;
}
function stableRow(row) {
  return JSON.stringify(row);
}
function stableSnapshot(snapshot) {
  return JSON.stringify(snapshot);
}

async function retryBoundarySample(policyAllows, retryLimit, attemptLimit, deadlineLimit) {
  const fixture = adapterFixture('memory');
  try {
    const decision = policyAllows
      ? { retry: true, afterMs: 0, maxRetries: retryLimit ? 0 : 2, manualRetry: true }
      : { retry: false, manualRetry: true };
    const queue = createWorkOnce({ store: fixture.store, scope: 'retry-boundary' }).define('job', {
      retry: decision,
      limits: {
        leaseMs: 20,
        maxAttempts: attemptLimit ? 1 : 2,
        maxElapsedMs: deadlineLimit ? 1 : 10,
        maxDeferrals: 2,
      },
    });
    await queue.ensure(null, { key: 'job' });
    const run = await claimOne(queue);
    const phase = await run.settle(run.retry('busy', { afterMs: deadlineLimit ? 1 : 0 }));
    const expected = !policyAllows
      ? 'retry_not_allowed'
      : retryLimit
        ? 'retry_budget_exhausted'
        : attemptLimit
          ? 'attempt_budget_exhausted'
          : deadlineLimit
            ? 'deadline_exceeded'
            : 'none';
    return {
      kind: 'retryBoundary',
      policyAllows,
      retryLimit,
      attemptLimit,
      deadlineLimit,
      stop: phase.state === 'waiting' ? 'none' : phase.stoppedBy,
      expected,
      reasonPreserved: phase.reason === 'busy',
      counterExact: (await queue.inspect('job')).retries === (expected === 'none' ? 1 : 0),
    };
  } finally {
    fixture.close();
  }
}

async function deferBoundarySample(attemptLimit, deadlineLimit, deferralLimit) {
  const fixture = adapterFixture('memory');
  try {
    const queue = createWorkOnce({ store: fixture.store, scope: 'defer-boundary' }).define('job', {
      limits: {
        leaseMs: 20,
        maxAttempts: attemptLimit ? 1 : 2,
        maxElapsedMs: deadlineLimit ? 1 : 10,
        maxDeferrals: deferralLimit ? 0 : 2,
      },
    });
    await queue.ensure(null, { key: 'job' });
    const run = await claimOne(queue);
    const phase = await run.settle(run.wait('pending', { afterMs: deadlineLimit ? 1 : 0 }));
    const expected = attemptLimit
      ? 'attempt_budget_exhausted'
      : deadlineLimit
        ? 'deadline_exceeded'
        : deferralLimit
          ? 'deferral_budget_exhausted'
          : 'none';
    return {
      kind: 'deferBoundary',
      attemptLimit,
      deadlineLimit,
      deferralLimit,
      stop: phase.state === 'waiting' ? 'none' : phase.stoppedBy,
      expected,
      reasonPreserved: phase.reason === 'pending',
      counterExact: (await queue.inspect('job')).deferrals === (expected === 'none' ? 1 : 0),
    };
  } finally {
    fixture.close();
  }
}

function backoffSamples() {
  const cases = [
    {
      category: 'zeroOverflow',
      initial: 0,
      max: 64,
      multiplier: 2,
      retries: Number.MAX_SAFE_INTEGER,
      expected: 0,
    },
    {
      category: 'positiveOverflow',
      initial: 1,
      max: 64,
      multiplier: 2,
      retries: 1024,
      expected: 64,
    },
    { category: 'capped', initial: 8, max: 64, multiplier: 2, retries: 4, expected: 64 },
    {
      category: 'noGrowth',
      initial: 1,
      max: 64,
      multiplier: 1,
      retries: Number.MAX_SAFE_INTEGER,
      expected: 1,
    },
    {
      category: 'maxFiniteCap',
      initial: Number.MAX_SAFE_INTEGER,
      max: Number.MAX_SAFE_INTEGER,
      multiplier: 1,
      retries: Number.MAX_SAFE_INTEGER,
      expected: Number.MAX_SAFE_INTEGER,
    },
  ];
  return cases.map((item) => {
    const decision = exponentialBackoff({
      initialDelayMs: item.initial,
      maxDelayMs: item.max,
      multiplier: item.multiplier,
      maxRetries: Number.MAX_SAFE_INTEGER,
    })({ retries: item.retries });
    return {
      kind: 'backoffFinite',
      category: item.category,
      matchesExpected: decision.afterMs === item.expected,
      safeInteger: Number.isSafeInteger(decision.afterMs),
    };
  });
}

function assertBackoffValidation() {
  assert.throws(
    () =>
      exponentialBackoff({ initialDelayMs: 1, maxDelayMs: 2, multiplier: Infinity, maxRetries: 1 }),
    /multiplier must be a finite number >= 1/,
  );
  assert.throws(
    () => exponentialBackoff({ initialDelayMs: 1, maxDelayMs: 2, multiplier: 0.5, maxRetries: 1 }),
    /multiplier must be a finite number >= 1/,
  );
  const fractional = exponentialBackoff({
    initialDelayMs: 1,
    maxDelayMs: 64,
    multiplier: 1.5,
    maxRetries: 10,
  })({ retries: 4 });
  assert.equal(fractional.afterMs, 6);
}

async function asyncRaceSample(outcomeKind, race) {
  const fixture = adapterFixture('memory');
  const entered = deferred();
  const release = deferred();
  let callbackCalls = 0;
  let contextExact = false;
  try {
    const policy = async (context) => {
      callbackCalls++;
      contextExact =
        context.reason === (outcomeKind === 'retry' ? 'busy' : 'pending') &&
        context.retries === 0 &&
        context.deferrals === 0 &&
        context.elapsedMs === 0 &&
        context.attempt.generation === 1 &&
        context.attempt.fence === 1;
      entered.resolve();
      await release.promise;
      return outcomeKind === 'retry'
        ? { retry: true, afterMs: 0, maxRetries: 2, manualRetry: true }
        : { afterMs: 0 };
    };
    const queue = createWorkOnce({
      store: fixture.store,
      scope: `policy-${outcomeKind}-${race}`,
    }).define('job', {
      ...(outcomeKind === 'retry' ? { retry: policy } : { wait: policy }),
      limits: { leaseMs: 5, maxAttempts: 4, maxElapsedMs: 100, maxDeferrals: 4 },
    });
    await queue.ensure(null, { key: 'job' });
    const run = await claimOne(queue);
    const pending = run.settle(outcomeKind === 'retry' ? run.retry('busy') : run.wait('pending'));
    await entered.promise;
    let winner;
    if (race === 'cancel') {
      winner = await queue.cancel({ key: 'job', generation: 1, reason: 'cancel-race' });
    } else {
      fixture.setNow(105);
      winner = (await queue.claim({ workerId: 'B', limit: 1 }))[0];
      assert.ok(winner, 'reclaim race did not produce a new attempt');
    }
    release.resolve();
    const result = await observe(pending);
    const snapshot = await queue.inspect('job');
    return {
      kind: 'policyRace',
      outcomeKind,
      race,
      callbackOnce: callbackCalls === 1,
      contextExact,
      exactStale: result.rejected && result.error?.code === 'stale_attempt',
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

async function callbackFailureSample(outcomeKind) {
  const fixture = adapterFixture('memory');
  const sentinel = new Error(`${outcomeKind}-policy-failed`);
  let callbackCalls = 0;
  try {
    const policy = async () => {
      callbackCalls++;
      throw sentinel;
    };
    const queue = createWorkOnce({
      store: fixture.store,
      scope: `policy-failure-${outcomeKind}`,
    }).define('job', {
      ...(outcomeKind === 'retry' ? { retry: policy } : { wait: policy }),
      limits: { leaseMs: 20, maxAttempts: 4, maxElapsedMs: 100, maxDeferrals: 4 },
    });
    await queue.ensure(null, { key: 'job' });
    const run = await claimOne(queue);
    const before = (await fixture.store.getMany([run.ref.workId])).rows[0];
    const result = await observe(
      run.settle(outcomeKind === 'retry' ? run.retry('busy') : run.wait('pending')),
    );
    const after = (await fixture.store.getMany([run.ref.workId])).rows[0];
    return {
      kind: 'policyFailure',
      outcomeKind,
      exactError: result.rejected && result.error === sentinel,
      callbackOnce: callbackCalls === 1,
      noWrite: stableRow(before) === stableRow(after),
      stillRunning: after.phase.state === 'running',
    };
  } finally {
    fixture.close();
  }
}

async function duplicateReplaySample(outcomeKind) {
  const fixture = adapterFixture('memory');
  let callbackCalls = 0;
  try {
    const policy = async () => {
      callbackCalls++;
      return outcomeKind === 'retry'
        ? { retry: true, afterMs: 0, maxRetries: 2, manualRetry: true }
        : { afterMs: 0 };
    };
    const queue = createWorkOnce({
      store: fixture.store,
      scope: `policy-replay-${outcomeKind}`,
    }).define('job', {
      ...(outcomeKind === 'retry' ? { retry: policy } : { wait: policy }),
      limits: { leaseMs: 20, maxAttempts: 4, maxElapsedMs: 100, maxDeferrals: 4 },
    });
    await queue.ensure(null, { key: 'job' });
    const run = await claimOne(queue);
    const outcome = outcomeKind === 'retry' ? run.retry('busy') : run.wait('pending');
    const first = await run.settle(outcome);
    const second = await run.settle(outcome);
    return {
      kind: 'policyReplay',
      outcomeKind,
      callbackOnce: callbackCalls === 1,
      samePhase: stableSnapshot(first) === stableSnapshot(second),
      waiting: first.state === 'waiting',
    };
  } finally {
    fixture.close();
  }
}

async function receiptLane(explicit) {
  const fixture = adapterFixture('memory');
  try {
    const queue = createWorkOnce({ store: fixture.store, scope: 'receipt-history' }).define('job', {
      wait: { afterMs: 5 },
      limits: { leaseMs: 20, maxAttempts: 4, maxElapsedMs: 100, maxDeferrals: 4 },
    });
    await queue.ensure(null, { key: 'job' });
    const run = await claimOne(queue);
    const implicit = run.wait('pending');
    const explicitOutcome = run.wait('pending', { afterMs: 5 });
    await run.settle(explicit ? explicitOutcome : implicit);
    const publicSnapshot = await queue.inspect('job');
    const row = (await fixture.store.getMany([run.ref.workId])).rows[0];
    const sameReplay = await observe(run.settle(explicit ? explicitOutcome : implicit));
    const crossReplay = await observe(run.settle(explicit ? implicit : explicitOutcome));
    return { publicSnapshot, row, sameReplay, crossReplay };
  } finally {
    fixture.close();
  }
}

async function receiptSplitSample() {
  const explicit = await receiptLane(true);
  const implicit = await receiptLane(false);
  const explicitNormalized = structuredClone(explicit.row);
  const implicitNormalized = structuredClone(implicit.row);
  explicitNormalized.receipt.submissionHash = '<receipt>';
  implicitNormalized.receipt.submissionHash = '<receipt>';
  return {
    kind: 'receiptSplit',
    samePublic: stableSnapshot(explicit.publicSnapshot) === stableSnapshot(implicit.publicSnapshot),
    differentReceipt: explicit.row.receipt.submissionHash !== implicit.row.receipt.submissionHash,
    otherwiseSameDurable: stableRow(explicitNormalized) === stableRow(implicitNormalized),
    sameReplayAccepted: !explicit.sameReplay.rejected && !implicit.sameReplay.rejected,
    crossReplayConflict:
      explicit.crossReplay.error?.code === 'settlement_conflict' &&
      implicit.crossReplay.error?.code === 'settlement_conflict',
  };
}

async function receiptAcrossAttemptsSample(outcomeKind) {
  const fixture = adapterFixture('memory');
  try {
    const queue = createWorkOnce({
      store: fixture.store,
      scope: `receipt-attempts-${outcomeKind}`,
    }).define('job', {
      retry: { retry: true, afterMs: 0, maxRetries: 3, manualRetry: true },
      wait: { afterMs: 0 },
      limits: { leaseMs: 20, maxAttempts: 4, maxElapsedMs: 100, maxDeferrals: 4 },
    });
    await queue.ensure(null, { key: 'job' });
    const first = await claimOne(queue, 'A');
    const firstOutcome = outcomeKind === 'retry' ? first.retry('busy') : first.wait('pending');
    const firstAck = await first.settle(firstOutcome);
    const firstRow = (await fixture.store.getMany([first.ref.workId])).rows[0];
    const second = await claimOne(queue, 'B');
    const whileSecondRunning = await first.settle(firstOutcome);
    const oldConflict = await observe(
      first.settle(outcomeKind === 'retry' ? first.retry('different') : first.wait('different')),
    );
    const secondOutcome = outcomeKind === 'retry' ? second.retry('again') : second.wait('again');
    await second.settle(secondOutcome);
    const secondRow = (await fixture.store.getMany([second.ref.workId])).rows[0];
    const afterReplacement = await observe(first.settle(firstOutcome));
    return {
      kind: 'receiptAcrossAttempts',
      outcomeKind,
      firstReceiptFence: firstRow.receipt?.attempt.fence === first.ref.fence,
      oldReplayDuringNewAttempt: stableSnapshot(whileSecondRunning) === stableSnapshot(firstAck),
      oldConflictExact: oldConflict.error?.code === 'settlement_conflict',
      secondReceiptFence: secondRow.receipt?.attempt.fence === second.ref.fence,
      oldReplayAfterReplacementStale: afterReplacement.error?.code === 'stale_attempt',
    };
  } finally {
    fixture.close();
  }
}

async function congruenceLane(dynamic) {
  const fixture = adapterFixture('memory');
  let callbackCalls = 0;
  try {
    const decision = { retry: true, afterMs: 5, maxRetries: 2, manualRetry: true };
    const queue = createWorkOnce({ store: fixture.store, scope: 'policy-congruence' }).define(
      'job',
      {
        retry: dynamic
          ? async () => {
              callbackCalls++;
              return decision;
            }
          : decision,
        limits: { leaseMs: 20, maxAttempts: 4, maxElapsedMs: 100, maxDeferrals: 4 },
      },
    );
    await queue.ensure(null, { key: 'job' });
    const run = await claimOne(queue);
    const outcome = run.retry('busy');
    await run.settle(outcome);
    const durable = (await fixture.store.getMany([run.ref.workId])).rows[0];
    const waiting = await queue.inspect('job');
    const woken = await queue.wake({
      key: 'job',
      generation: waiting.generation,
      revision: waiting.revision,
    });
    const next = await claimOne(queue, 'B');
    return {
      callbackCalls,
      durable,
      future: {
        wokenState: woken.phase.state,
        wokenAt: woken.phase.availableAt,
        fence: next.ref.fence,
        attempts: next.attempt.number,
      },
    };
  } finally {
    fixture.close();
  }
}

async function historyCongruenceSample() {
  const staticLane = await congruenceLane(false);
  const dynamicLane = await congruenceLane(true);
  return {
    kind: 'historyCongruence',
    materiallyDifferentHistory: staticLane.callbackCalls === 0 && dynamicLane.callbackCalls === 1,
    sameDurableProjection: stableRow(staticLane.durable) === stableRow(dynamicLane.durable),
    sameFuture: stableRow(staticLane.future) === stableRow(dynamicLane.future),
  };
}

async function wakeCompetitionSample(adapter) {
  const fixture = adapterFixture(adapter);
  try {
    const queue = createWorkOnce({ store: fixture.store, scope: `wake-${adapter}` }).define('job', {
      limits: { leaseMs: 20, maxAttempts: 4, maxElapsedMs: 100, maxDeferrals: 4 },
    });
    await queue.ensure(null, { key: 'job' });
    const run = await claimOne(queue);
    await run.settle(run.wait('pending', { afterMs: 10 }));
    const waiting = await queue.inspect('job');
    const results = await Promise.allSettled([
      queue.wake({ key: 'job', generation: waiting.generation, revision: waiting.revision }),
      queue.wake({ key: 'job', generation: waiting.generation, revision: waiting.revision }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    const current = await queue.inspect('job');
    const reclaimed = await queue.claim({ workerId: 'B', limit: 1 });
    const terminalWake = await observe(
      queue.wake({
        key: 'job',
        generation: current.generation,
        revision: (await queue.inspect('job')).revision,
      }),
    );
    return {
      kind: 'wakeCompetition',
      adapter,
      exactlyOneWake: fulfilled.length === 1 && rejected.length === 1,
      exactLoser: rejected[0]?.reason?.code === 'generation_conflict',
      immediateEligibility: current.phase.state === 'waiting' && current.phase.availableAt === 100,
      claimable: reclaimed.length === 1,
      terminalCauseExact: terminalWake.error?.code === 'not_waiting',
    };
  } finally {
    fixture.close();
  }
}

async function casAckLossSample(outcomeKind) {
  let now = 100;
  const native = createMemoryStore({ now: () => now });
  let loseWaitingAck = false;
  const ackError = new Error(`${outcomeKind}-CAS-ACK-lost`);
  const port = {
    getMany: (ids) => native.getMany(ids),
    query: (query) => native.query(query),
    async compareExchange(change) {
      const applied = await native.atomic(change.id, (row, clock) => {
        if (
          row?.revision !== change.expectedRevision ||
          (change.validUntil !== undefined && clock >= change.validUntil)
        )
          return { value: false };
        return { next: change.next, value: true };
      });
      if (applied && loseWaitingAck && change.next.phase.state === 'waiting') {
        loseWaitingAck = false;
        throw ackError;
      }
      return applied;
    },
  };
  const store = createCompareExchangeStore(port);
  let callbackCalls = 0;
  const policy = async () => {
    callbackCalls++;
    return outcomeKind === 'retry'
      ? { retry: true, afterMs: 0, maxRetries: 2, manualRetry: true }
      : { afterMs: 0 };
  };
  const queue = createWorkOnce({ store, scope: `cas-ack-${outcomeKind}` }).define('job', {
    ...(outcomeKind === 'retry' ? { retry: policy } : { wait: policy }),
    limits: { leaseMs: 20, maxAttempts: 4, maxElapsedMs: 100, maxDeferrals: 4 },
  });
  await queue.ensure(null, { key: 'job' });
  const run = await claimOne(queue);
  const outcome = outcomeKind === 'retry' ? run.retry('busy') : run.wait('pending');
  loseWaitingAck = true;
  const first = await observe(run.settle(outcome));
  const committed = (await store.getMany([run.ref.workId])).rows[0];
  const replay = await run.settle(outcome);
  const after = (await store.getMany([run.ref.workId])).rows[0];
  return {
    kind: 'casAckLoss',
    outcomeKind,
    exactAckError: first.rejected && first.error === ackError,
    committedWaiting: committed.phase.state === 'waiting' && committed.receipt !== undefined,
    replayConverged: replay.state === 'waiting',
    callbackOnce: callbackCalls === 1,
    counterOnce:
      after.retries === (outcomeKind === 'retry' ? 1 : 0) &&
      after.deferrals === (outcomeKind === 'defer' ? 1 : 0),
  };
}

async function adapterPolicyProjection(adapter, outcomeKind) {
  const fixture = adapterFixture(adapter);
  try {
    const queue = createWorkOnce({
      store: fixture.store,
      scope: `adapter-policy-${outcomeKind}`,
    }).define('job', {
      retry: { retry: true, afterMs: 0, maxRetries: 2, manualRetry: true },
      wait: { afterMs: 0 },
      limits: { leaseMs: 20, maxAttempts: 4, maxElapsedMs: 100, maxDeferrals: 4 },
    });
    await queue.ensure(null, { key: 'job' });
    const run = await claimOne(queue);
    const outcome = outcomeKind === 'retry' ? run.retry('busy') : run.wait('pending');
    const first = await run.settle(outcome);
    const replay = await run.settle(outcome);
    const snap = await queue.inspect('job');
    const wake = await queue.wake({
      key: 'job',
      generation: snap.generation,
      revision: snap.revision,
    });
    const next = await claimOne(queue, 'B');
    return {
      first,
      replay,
      wake,
      next: { generation: next.ref.generation, fence: next.ref.fence, number: next.attempt.number },
    };
  } finally {
    fixture.close();
  }
}

async function adapterEquivalenceSample(outcomeKind) {
  const values = [];
  for (const adapter of ['memory', 'sqlite', 'cas'])
    values.push(await adapterPolicyProjection(adapter, outcomeKind));
  return {
    kind: 'adapterEquivalence',
    outcomeKind,
    adapters: 'memory,sqlite,cas',
    equivalent: values.every((value) => stableRow(value) === stableRow(values[0])),
  };
}

async function timingBoundarySample() {
  async function lane(mode) {
    const fixture = adapterFixture('memory');
    try {
      const queue = createWorkOnce({ store: fixture.store, scope: `timing-${mode}` }).define(
        'job',
        {
          limits: { leaseMs: 20, maxAttempts: 4, maxElapsedMs: 5, maxDeferrals: 4 },
        },
      );
      await queue.ensure(null, { key: 'job' });
      const run = await claimOne(queue);
      const before = (await fixture.store.getMany([run.ref.workId])).rows[0];
      if (mode === 'past') return await run.settle(run.wait('pending', { at: 99 }));
      if (mode === 'deadline') return await run.settle(run.wait('pending', { at: 105 }));
      if (mode === 'huge')
        return await run.settle(run.wait('pending', { afterMs: Number.MAX_SAFE_INTEGER }));
      const result = await observe(run.settle(run.wait('pending', { at: 101, afterMs: 1 })));
      const after = (await fixture.store.getMany([run.ref.workId])).rows[0];
      return { result, noWrite: stableRow(before) === stableRow(after) };
    } finally {
      fixture.close();
    }
  }
  const past = await lane('past');
  const deadline = await lane('deadline');
  const huge = await lane('huge');
  const both = await lane('both');
  return {
    kind: 'timingBoundary',
    pastClampedToNow: past.state === 'waiting' && past.availableAt === 100,
    exactDeadlineStops: deadline.state === 'failed' && deadline.stoppedBy === 'deadline_exceeded',
    hugeDelaySaturates: huge.state === 'failed' && huge.stoppedBy === 'deadline_exceeded',
    exactBothError:
      both.result.rejected &&
      both.result.error instanceof RangeError &&
      both.result.error.message === 'Use at or afterMs, not both',
    invalidTimingNoWrite: both.noWrite,
  };
}

export async function runPolicyRefinementSamples() {
  assertBackoffValidation();
  const samples = [];
  for (const policyAllows of [false, true]) {
    const retryLimits = policyAllows ? [false, true] : [false];
    for (const retryLimit of retryLimits)
      for (const attemptLimit of [false, true])
        for (const deadlineLimit of [false, true])
          samples.push(
            await retryBoundarySample(policyAllows, retryLimit, attemptLimit, deadlineLimit),
          );
  }
  for (const attemptLimit of [false, true])
    for (const deadlineLimit of [false, true])
      for (const deferralLimit of [false, true])
        samples.push(await deferBoundarySample(attemptLimit, deadlineLimit, deferralLimit));
  samples.push(...backoffSamples());
  for (const outcomeKind of ['retry', 'defer']) {
    samples.push(await asyncRaceSample(outcomeKind, 'cancel'));
    samples.push(await asyncRaceSample(outcomeKind, 'reclaim'));
    samples.push(await callbackFailureSample(outcomeKind));
    samples.push(await duplicateReplaySample(outcomeKind));
    samples.push(await casAckLossSample(outcomeKind));
  }
  samples.push(await receiptSplitSample());
  samples.push(await receiptAcrossAttemptsSample('retry'));
  samples.push(await receiptAcrossAttemptsSample('defer'));
  samples.push(await historyCongruenceSample());
  for (const adapter of ['memory', 'sqlite', 'cas'])
    samples.push(await wakeCompetitionSample(adapter));
  samples.push(await adapterEquivalenceSample('retry'));
  samples.push(await adapterEquivalenceSample('defer'));
  samples.push(await timingBoundarySample());
  return samples;
}

export function assertPolicyRefinementSamples(samples) {
  assert.ok(samples.length >= 30, 'policy refinement sample family unexpectedly shrank');
  for (const sample of samples) {
    const name = JSON.stringify(sample);
    if (sample.kind === 'retryBoundary' || sample.kind === 'deferBoundary') {
      assert.equal(sample.stop, sample.expected, name);
      assert.equal(sample.reasonPreserved, true, name);
      assert.equal(sample.counterExact, true, name);
    } else if (sample.kind === 'backoffFinite') {
      assert.equal(sample.matchesExpected, true, name);
      assert.equal(sample.safeInteger, true, name);
    } else if (sample.kind === 'policyRace') {
      assert.equal(sample.callbackOnce, true, name);
      assert.equal(sample.contextExact, true, name);
      assert.equal(sample.exactStale, true, name);
      assert.equal(sample.winnerPreserved, true, name);
    } else if (sample.kind === 'policyFailure') {
      assert.equal(sample.exactError, true, name);
      assert.equal(sample.callbackOnce, true, name);
      assert.equal(sample.noWrite, true, name);
      assert.equal(sample.stillRunning, true, name);
    } else if (sample.kind === 'policyReplay') {
      assert.equal(sample.callbackOnce, true, name);
      assert.equal(sample.samePhase, true, name);
      assert.equal(sample.waiting, true, name);
    } else if (sample.kind === 'casAckLoss') {
      assert.equal(sample.exactAckError, true, name);
      assert.equal(sample.committedWaiting, true, name);
      assert.equal(sample.replayConverged, true, name);
      assert.equal(sample.callbackOnce, true, name);
      assert.equal(sample.counterOnce, true, name);
    } else if (sample.kind === 'receiptSplit') {
      assert.equal(sample.samePublic, true, name);
      assert.equal(sample.differentReceipt, true, name);
      assert.equal(sample.otherwiseSameDurable, true, name);
      assert.equal(sample.sameReplayAccepted, true, name);
      assert.equal(sample.crossReplayConflict, true, name);
    } else if (sample.kind === 'receiptAcrossAttempts') {
      assert.equal(sample.firstReceiptFence, true, name);
      assert.equal(sample.oldReplayDuringNewAttempt, true, name);
      assert.equal(sample.oldConflictExact, true, name);
      assert.equal(sample.secondReceiptFence, true, name);
      assert.equal(sample.oldReplayAfterReplacementStale, true, name);
    } else if (sample.kind === 'historyCongruence') {
      assert.equal(sample.materiallyDifferentHistory, true, name);
      assert.equal(sample.sameDurableProjection, true, name);
      assert.equal(sample.sameFuture, true, name);
    } else if (sample.kind === 'wakeCompetition') {
      assert.equal(sample.exactlyOneWake, true, name);
      assert.equal(sample.exactLoser, true, name);
      assert.equal(sample.immediateEligibility, true, name);
      assert.equal(sample.claimable, true, name);
      assert.equal(sample.terminalCauseExact, true, name);
    } else if (sample.kind === 'adapterEquivalence') {
      assert.equal(sample.equivalent, true, name);
    } else if (sample.kind === 'timingBoundary') {
      for (const [field, value] of Object.entries(sample))
        if (field !== 'kind') assert.equal(value, true, `${sample.kind}.${field}`);
    } else assert.fail(`Unmapped policy sample: ${name}`);
  }
  return samples.length;
}
