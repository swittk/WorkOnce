import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompareExchangeStore } from '../dist/cas.js';
import { createWorkOnce } from '../dist/index.js';
import { changed, claimRecord, retryRecord } from '../dist/kernel.js';
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
    const directory = mkdtempSync(join(tmpdir(), 'workonce-lifecycle-proof-'));
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

function lifecycleProjection(row) {
  return JSON.stringify({
    id: row.id,
    definition: row.definition,
    generation: row.generation,
    fence: row.fence,
    attempts: row.attempts,
    retries: row.retries,
    deferrals: row.deferrals,
    firstStartedAt: row.firstStartedAt,
    phase: row.phase,
    outbox: row.outbox,
    receipt: row.receipt,
  });
}

async function revisionLane(extraWake) {
  const fixture = adapterFixture('memory');
  try {
    const queue = createWorkOnce({ store: fixture.store, scope: 'revision-split' }).define('job', {
      limits: { leaseMs: 20, maxAttempts: 4, maxElapsedMs: 100, maxDeferrals: 4 },
    });
    await queue.ensure(null, { key: 'job' });
    const run = await claimOne(queue);
    await run.settle(run.wait('pending', { afterMs: 10 }));
    let snapshot = await queue.inspect('job');
    snapshot = await queue.wake({
      key: 'job',
      generation: snapshot.generation,
      revision: snapshot.revision,
    });
    const staleRevision = snapshot.revision;
    if (extraWake) {
      snapshot = await queue.wake({
        key: 'job',
        generation: snapshot.generation,
        revision: snapshot.revision,
      });
    }
    const row = (await fixture.store.getMany([snapshot.id])).rows[0];
    const future = await observe(
      queue.wake({ key: 'job', generation: snapshot.generation, revision: staleRevision }),
    );
    return { row, future, staleRevision };
  } finally {
    fixture.close();
  }
}

async function revisionHistorySplitSample() {
  const first = await revisionLane(false);
  const second = await revisionLane(true);
  const abstractFirst = structuredClone(first.row);
  const abstractSecond = structuredClone(second.row);
  for (const row of [abstractFirst, abstractSecond]) {
    delete row.revision;
    delete row.updatedAt;
    delete row.history;
  }
  return {
    kind: 'revisionHistorySplit',
    sameOldAbstraction: JSON.stringify(abstractFirst) === JSON.stringify(abstractSecond),
    revisionsDiffer: first.row.revision + 1 === second.row.revision,
    historiesDiffer: JSON.stringify(first.row.history) !== JSON.stringify(second.row.history),
    sameFutureCommand:
      first.staleRevision === second.staleRevision && first.staleRevision === first.row.revision,
    futureDiverges:
      !first.future.rejected &&
      second.future.rejected &&
      second.future.error?.code === 'generation_conflict',
  };
}

async function terminalReceiptSample(outcomeKind) {
  const fixture = adapterFixture('memory');
  try {
    const queue = createWorkOnce({ store: fixture.store, scope: `terminal-${outcomeKind}` }).define(
      'job',
      { limits: { leaseMs: 20, maxAttempts: 4, maxElapsedMs: 100, maxDeferrals: 4 } },
    );
    await queue.ensure(null, { key: 'job' });
    const run = await claimOne(queue);
    const outcome =
      outcomeKind === 'succeed'
        ? run.succeed({ value: 1 })
        : run.fail('bad', { manualRetry: true });
    const first = await run.settle(outcome);
    const row = (await fixture.store.getMany([run.ref.workId])).rows[0];
    const replay = await run.settle(outcome);
    const conflict = await observe(
      run.settle(
        outcomeKind === 'succeed'
          ? run.succeed({ value: 2 })
          : run.fail('different', { manualRetry: true }),
      ),
    );
    const cancel = await queue.cancel({ key: 'job', generation: 1, reason: 'late-cancel' });
    const reset =
      outcomeKind === 'succeed'
        ? await queue.rerun({ key: 'job', generation: 1 })
        : await queue.retry({ key: 'job', generation: 1 });
    const resetRow = (await fixture.store.getMany([run.ref.workId])).rows[0];
    const oldReplay = await observe(run.settle(outcome));
    const next = await claimOne(queue, 'B');
    return {
      kind: 'terminalReceipt',
      outcomeKind,
      terminalState: first.state,
      receiptBound: row.receipt?.attempt.fence === run.ref.fence,
      replayExact: JSON.stringify(replay) === JSON.stringify(first),
      conflictExact: conflict.error?.code === 'settlement_conflict',
      lateCancelNoop: cancel.phase.state === first.state,
      resetGeneration: reset.generation === 2 && reset.phase.state === 'queued',
      resetClearsReceipt: resetRow.receipt === undefined,
      resetCounters: resetRow.attempts === 0 && resetRow.retries === 0 && resetRow.deferrals === 0,
      oldReplayStale: oldReplay.error?.code === 'stale_attempt',
      fenceMonotone: next.ref.fence > run.ref.fence && next.ref.generation === 2,
    };
  } finally {
    fixture.close();
  }
}

async function cancellationOrderingSample(first) {
  const fixture = adapterFixture('memory');
  try {
    const queue = createWorkOnce({ store: fixture.store, scope: `cancel-order-${first}` }).define(
      'job',
    );
    await queue.ensure(null, { key: 'job' });
    const run = await claimOne(queue);
    let completion;
    let cancellation;
    if (first === 'cancel') {
      cancellation = await observe(queue.cancel({ key: 'job', generation: 1, reason: 'stop' }));
      completion = await observe(run.settle(run.succeed('done')));
    } else {
      completion = await observe(run.settle(run.succeed('done')));
      cancellation = await observe(queue.cancel({ key: 'job', generation: 1, reason: 'stop' }));
    }
    const final = await queue.inspect('job');
    return {
      kind: 'cancelOrdering',
      first,
      finalState: final.phase.state,
      cancelAccepted: !cancellation.rejected,
      completionRejected: completion.rejected,
      completionCause: completion.error?.code ?? 'none',
    };
  } finally {
    fixture.close();
  }
}

async function leaseFenceCauseSample() {
  const fixture = adapterFixture('memory');
  try {
    const queue = createWorkOnce({ store: fixture.store, scope: 'lease-cause' }).define('job', {
      limits: { leaseMs: 5, maxAttempts: 3, maxElapsedMs: 100, maxDeferrals: 2 },
    });
    await queue.ensure(null, { key: 'job' });
    const first = await claimOne(queue, 'A');
    fixture.setNow(105);
    const expired = await observe(first.renew());
    const second = await claimOne(queue, 'B');
    const staleRenew = await observe(first.renew());
    const staleSettle = await observe(first.settle(first.succeed()));
    return {
      kind: 'leaseFenceCause',
      exactBoundaryExpired: expired.error?.code === 'lease_expired',
      reclaimedFence: second.ref.fence === first.ref.fence + 1,
      staleRenewCause: staleRenew.error?.code === 'stale_attempt',
      staleSettleCause: staleSettle.error?.code === 'stale_attempt',
    };
  } finally {
    fixture.close();
  }
}

async function retryGenerationCompetitionSample() {
  const fixture = adapterFixture('memory');
  try {
    const queue = createWorkOnce({ store: fixture.store, scope: 'retry-race' }).define('job');
    await queue.ensure(null, { key: 'job' });
    const run = await claimOne(queue);
    await run.settle(run.fail('bad', { manualRetry: true }));
    const outcomes = await Promise.allSettled([
      queue.retry({ key: 'job', generation: 1 }),
      queue.retry({ key: 'job', generation: 1 }),
    ]);
    const fulfilled = outcomes.filter((x) => x.status === 'fulfilled');
    const rejected = outcomes.filter((x) => x.status === 'rejected');
    const current = await queue.inspect('job');
    return {
      kind: 'generationCompetition',
      exactlyOneReset: fulfilled.length === 1 && current.generation === 2,
      exactLoser: rejected.length === 1 && rejected[0].reason?.code === 'generation_conflict',
      queuedOnce: current.phase.state === 'queued' && current.attempts === 0,
    };
  } finally {
    fixture.close();
  }
}

async function resetCheckRaceSample(resetKind) {
  const fixture = adapterFixture('memory');
  const entered = deferred();
  const release = deferred();
  let checkCalls = 0;
  let pending;
  try {
    const queue = createWorkOnce({
      store: fixture.store,
      scope: `reset-check-${resetKind}`,
    }).define('job');
    await queue.ensure(null, { key: 'job' });
    const run = await claimOne(queue);
    if (resetKind === 'retry') await run.settle(run.fail('bad', { manualRetry: true }));
    else await run.settle(run.succeed('done'));
    pending = queue[resetKind]({
      key: 'job',
      generation: 1,
      check: async (snapshot) => {
        checkCalls++;
        entered.resolve();
        assert.equal(snapshot.generation, 1);
        assert.equal(snapshot.phase.state, resetKind === 'retry' ? 'failed' : 'succeeded');
        await within(release.promise, 'reset-check callback release');
        return true;
      },
    });
    await Promise.race([entered.promise, pending]);
    const winner = await queue[resetKind]({ key: 'job', generation: 1 });
    release.resolve();
    const late = await observe(pending);
    const current = await queue.inspect('job');
    return {
      kind: 'resetCheckRace',
      resetKind,
      checkOnce: checkCalls === 1,
      winnerAdvanced: winner.generation === 2 && winner.phase.state === 'queued',
      exactLateCause: late.error?.code === 'generation_conflict',
      noDoubleGeneration: current.generation === 2 && current.phase.state === 'queued',
    };
  } finally {
    release.resolve();
    if (pending) await observe(pending);
    fixture.close();
  }
}

async function claimOrderProjection(adapter) {
  const fixture = adapterFixture(adapter);
  try {
    const queue = createWorkOnce({ store: fixture.store, scope: `claim-order-${adapter}` }).define(
      'job',
    );
    const inputs = [
      ['z', 100],
      ['a', 99],
      ['y', 100],
      ['b', 99],
      ['m', 100],
    ];
    for (const [key, availableAt] of inputs)
      await queue.ensure({ key, availableAt }, { key, availableAt });
    const runs = await queue.claim({ workerId: 'order', limit: 5 });
    return runs.map((run) => `${run.input.availableAt}:${run.input.key}`);
  } finally {
    fixture.close();
  }
}

async function claimOrderEquivalenceSample() {
  const values = [];
  for (const adapter of ['memory', 'sqlite', 'cas'])
    values.push(await claimOrderProjection(adapter));
  return {
    kind: 'claimOrderEquivalence',
    adapters: 'memory,sqlite,cas',
    exactOrder: values[0].join(',') === '99:a,99:b,100:m,100:y,100:z',
    adaptersEquivalent: values.every(
      (value) => JSON.stringify(value) === JSON.stringify(values[0]),
    ),
  };
}

async function exhaustedPageContinuationSample(adapter) {
  const fixture = adapterFixture(adapter);
  try {
    const queue = createWorkOnce({ store: fixture.store, scope: `scan-${adapter}` }).define('job', {
      limits: { leaseMs: 5, maxAttempts: 1, maxElapsedMs: 100, maxDeferrals: 1 },
    });
    for (const key of ['a', 'b', 'c', 'd']) await queue.ensure(key, { key });
    await queue.ensure('healthy', { key: 'e', availableAt: 110 });
    const first = await queue.claim({ workerId: 'first', limit: 4 });
    assert.equal(first.length, 4);
    fixture.setNow(105);
    const exhaustedPass = await queue.claim({ workerId: 'sweeper', limit: 1 });
    const exhaustedStates = await queue.inspectMany(['a', 'b', 'c', 'd']);
    fixture.setNow(110);
    const healthy = await queue.claim({ workerId: 'healthy', limit: 1 });
    return {
      kind: 'claimScanContinuation',
      adapter,
      firstPageFull: first.length === 4,
      exhaustedPassReturnsNone: exhaustedPass.length === 0,
      wholeCandidatePageTerminalized: exhaustedStates.every(
        (snapshot) =>
          snapshot.phase.state === 'failed' &&
          snapshot.phase.stoppedBy === 'attempt_budget_exhausted',
      ),
      nextInvocationReachesLater: healthy.length === 1 && healthy[0].input === 'healthy',
    };
  } finally {
    fixture.close();
  }
}

async function stolenPageContinuationSample(adapter) {
  const fixture = adapterFixture(adapter);
  let stealFirstPage = true;
  const base = fixture.store;
  const store = {
    getMany: (ids) => base.getMany(ids),
    atomic: (id, decision) => base.atomic(id, decision),
    async query(query) {
      const result = await base.query(query);
      if (stealFirstPage && query.select === 'due') {
        stealFirstPage = false;
        for (const candidate of result.rows) {
          await base.atomic(candidate.id, (row, clock) => {
            if (!row) return { value: null };
            const next = claimRecord(row, 'competitor', clock);
            return next ? { next, value: null } : { value: null };
          });
        }
      }
      return result;
    },
  };
  try {
    const queue = createWorkOnce({ store, scope: `stolen-page-${adapter}` }).define('job', {
      limits: { leaseMs: 20, maxAttempts: 3, maxElapsedMs: 100, maxDeferrals: 1 },
    });
    for (const key of ['a', 'b', 'c', 'd', 'e']) await queue.ensure(key, { key });
    const stalePass = await queue.claim({ workerId: 'local', limit: 1 });
    const nextPass = await queue.claim({ workerId: 'local', limit: 1 });
    return {
      kind: 'stolenPageContinuation',
      adapter,
      stalePassCanReturnShort: stalePass.length === 0,
      nextInvocationReachesBeyondPage: nextPass.length === 1 && nextPass[0].input === 'e',
      stolenRowsRemainOwned: (await queue.inspectMany(['a', 'b', 'c', 'd'])).every(
        (snapshot) =>
          snapshot.phase.state === 'running' && snapshot.phase.attempt.workerId === 'competitor',
      ),
    };
  } finally {
    fixture.close();
  }
}

async function claimLimitSample(adapter) {
  const fixture = adapterFixture(adapter);
  try {
    const queue = createWorkOnce({ store: fixture.store, scope: `claim-limit-${adapter}` }).define(
      'job',
    );
    for (const key of ['a', 'b', 'c', 'd', 'e']) await queue.ensure(key, { key });
    const runs = await queue.claim({ workerId: 'limit', limit: 2 });
    const snapshots = await queue.inspectMany(['a', 'b', 'c', 'd', 'e']);
    return {
      kind: 'claimLimit',
      adapter,
      exactReturnedLimit: runs.length === 2,
      exactRunningCount:
        snapshots.filter((snapshot) => snapshot.phase.state === 'running').length === 2,
      laterDueRemainReachable:
        snapshots.filter((snapshot) => snapshot.phase.state === 'queued').length === 3,
    };
  } finally {
    fixture.close();
  }
}

async function finiteDrainSample(adapter) {
  const fixture = adapterFixture(adapter);
  try {
    const queue = createWorkOnce({ store: fixture.store, scope: `finite-drain-${adapter}` }).define(
      'job',
    );
    for (let i = 0; i < 9; i++) await queue.ensure(i, { key: String(i) });
    const seen = [];
    const maxPasses = 6;
    let passes = 0;
    for (; passes < maxPasses; passes++) {
      const runs = await queue.claim({ workerId: 'drain', limit: 2 });
      if (!runs.length) break;
      for (const run of runs) {
        seen.push(run.input);
        await run.settle(run.succeed());
      }
    }
    return {
      kind: 'finiteClaimDrain',
      adapter,
      allUnique: new Set(seen).size === 9,
      allReached: seen.length === 9,
      boundedPasses: passes < maxPasses,
    };
  } finally {
    fixture.close();
  }
}

async function adapterLifecycleProjection(adapter) {
  const fixture = adapterFixture(adapter);
  try {
    const queue = createWorkOnce({ store: fixture.store, scope: 'adapter-lifecycle' }).define(
      'job',
      {
        limits: { leaseMs: 10, maxAttempts: 3, maxElapsedMs: 100, maxDeferrals: 2 },
      },
    );
    const created = await queue.ensure({ value: 1 }, { key: 'job' });
    const first = await claimOne(queue, 'A');
    fixture.setNow(102);
    const renewed = await first.renew();
    const failed = await first.settle(first.fail('bad', { manualRetry: true }));
    const retried = await queue.retry({ key: 'job', generation: 1 });
    const second = await claimOne(queue, 'B');
    const succeeded = await second.settle(second.succeed({ value: 2 }));
    const lateCancel = await queue.cancel({ key: 'job', generation: 2, reason: 'late' });
    const row = (await fixture.store.getMany([second.ref.workId])).rows[0];
    return {
      created: {
        state: created.phase.state,
        generation: created.generation,
        revision: created.revision,
      },
      first: {
        generation: first.ref.generation,
        fence: first.ref.fence,
        number: first.attempt.number,
      },
      renewed: {
        leaseUntil: renewed.attempt.leaseUntil,
        revision: (await queue.inspect('job')).revision,
      },
      failed: { state: failed.state, stoppedBy: failed.stoppedBy },
      retried: {
        state: retried.phase.state,
        generation: retried.generation,
        attempts: retried.attempts,
      },
      second: {
        generation: second.ref.generation,
        fence: second.ref.fence,
        number: second.attempt.number,
      },
      succeeded: succeeded.state,
      lateCancel: lateCancel.phase.state,
      final: {
        generation: row.generation,
        fence: row.fence,
        attempts: row.attempts,
        retries: row.retries,
        deferrals: row.deferrals,
        phase: row.phase.state,
        receiptFence: row.receipt?.attempt.fence,
      },
    };
  } finally {
    fixture.close();
  }
}

async function adapterLifecycleEquivalenceSample() {
  const values = [];
  for (const adapter of ['memory', 'sqlite', 'cas'])
    values.push(await adapterLifecycleProjection(adapter));
  return {
    kind: 'adapterLifecycleEquivalence',
    adapters: 'memory,sqlite,cas',
    equivalent: values.every((value) => JSON.stringify(value) === JSON.stringify(values[0])),
  };
}

async function casTerminalAckLossSample(outcomeKind) {
  let now = 100;
  const native = createMemoryStore({ now: () => now });
  let loseTerminalAck = false;
  const ackError = new Error(`${outcomeKind}-terminal-ack-lost`);
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
      if (
        applied &&
        loseTerminalAck &&
        (change.next.phase.state === 'succeeded' || change.next.phase.state === 'failed')
      ) {
        loseTerminalAck = false;
        throw ackError;
      }
      return applied;
    },
  };
  const store = createCompareExchangeStore(port);
  const queue = createWorkOnce({ store, scope: `terminal-ack-${outcomeKind}` }).define('job');
  await queue.ensure(null, { key: 'job' });
  const run = await claimOne(queue);
  const outcome =
    outcomeKind === 'succeed' ? run.succeed('ok') : run.fail('bad', { manualRetry: true });
  loseTerminalAck = true;
  const first = await observe(run.settle(outcome));
  const committed = (await store.getMany([run.ref.workId])).rows[0];
  const replay = await run.settle(outcome);
  const after = (await store.getMany([run.ref.workId])).rows[0];
  return {
    kind: 'terminalAckLoss',
    outcomeKind,
    exactAckError: first.error === ackError,
    durableTerminal: committed.phase.state === (outcomeKind === 'succeed' ? 'succeeded' : 'failed'),
    receiptDurable: committed.receipt?.attempt.fence === run.ref.fence,
    replayConverges: JSON.stringify(replay) === JSON.stringify(committed.phase),
    noSecondWrite: committed.revision === after.revision,
  };
}

async function arithmeticBoundarySample() {
  const fixture = adapterFixture('memory');
  try {
    const queue = createWorkOnce({ store: fixture.store, scope: 'arithmetic-boundary' }).define(
      'job',
      {
        limits: {
          leaseMs: 1,
          maxAttempts: Number.MAX_SAFE_INTEGER,
          maxElapsedMs: 100,
          maxDeferrals: 0,
        },
      },
    );
    await queue.ensure(null, { key: 'job' });
    const id = (await queue.inspect('job')).id;
    const base = (await fixture.store.getMany([id])).rows[0];
    const fenceOverflow = await observe(
      Promise.resolve().then(() =>
        claimRecord(
          { ...base, fence: Number.MAX_SAFE_INTEGER, phase: { state: 'queued', availableAt: 0 } },
          'A',
          100,
        ),
      ),
    );
    const revisionOverflow = await observe(
      Promise.resolve().then(() =>
        changed({ ...base, revision: Number.MAX_SAFE_INTEGER }, base.phase, 100, 'wake'),
      ),
    );
    const generationOverflow = await observe(
      Promise.resolve().then(() =>
        retryRecord(
          {
            ...base,
            generation: Number.MAX_SAFE_INTEGER,
            phase: {
              state: 'failed',
              reason: 'bad',
              manualRetry: true,
              failedAt: 100,
              stoppedBy: 'reported_failure',
            },
          },
          Number.MAX_SAFE_INTEGER,
          100,
        ),
      ),
    );
    const maxAttemptRow = {
      ...base,
      fence: Number.MAX_SAFE_INTEGER - 1,
      attempts: Number.MAX_SAFE_INTEGER - 1,
      limits: { ...base.limits, maxAttempts: Number.MAX_SAFE_INTEGER },
      phase: { state: 'queued', availableAt: 0 },
    };
    const maxAttempt = claimRecord(maxAttemptRow, 'A', 100);
    return {
      kind: 'lifecycleArithmetic',
      fenceOverflowExact: fenceOverflow.rejected && fenceOverflow.error instanceof RangeError,
      revisionOverflowExact:
        revisionOverflow.rejected && revisionOverflow.error instanceof RangeError,
      generationOverflowExact:
        generationOverflow.rejected && generationOverflow.error instanceof RangeError,
      maximumFiniteClaimAccepted:
        maxAttempt.phase.state === 'running' &&
        maxAttempt.fence === Number.MAX_SAFE_INTEGER &&
        maxAttempt.attempts === Number.MAX_SAFE_INTEGER,
    };
  } finally {
    fixture.close();
  }
}

export async function runLifecycleRefinementSamples() {
  const samples = [
    await revisionHistorySplitSample(),
    await cancellationOrderingSample('cancel'),
    await cancellationOrderingSample('complete'),
    await terminalReceiptSample('succeed'),
    await terminalReceiptSample('fail'),
    await leaseFenceCauseSample(),
    await retryGenerationCompetitionSample(),
    await resetCheckRaceSample('retry'),
    await resetCheckRaceSample('rerun'),
    await claimOrderEquivalenceSample(),
    await adapterLifecycleEquivalenceSample(),
    await casTerminalAckLossSample('succeed'),
    await casTerminalAckLossSample('fail'),
    await arithmeticBoundarySample(),
  ];
  for (const adapter of ['memory', 'sqlite', 'cas']) {
    samples.push(await exhaustedPageContinuationSample(adapter));
    samples.push(await stolenPageContinuationSample(adapter));
    samples.push(await claimLimitSample(adapter));
    samples.push(await finiteDrainSample(adapter));
  }
  return samples;
}

export function assertLifecycleRefinementSamples(samples) {
  assert.equal(samples.length, 26, 'lifecycle refinement sample family unexpectedly changed');
  for (const kind of [
    'claimScanContinuation',
    'stolenPageContinuation',
    'claimLimit',
    'finiteClaimDrain',
  ]) {
    assert.deepEqual(
      samples
        .filter((sample) => sample.kind === kind)
        .map((sample) => sample.adapter)
        .sort(),
      ['cas', 'memory', 'sqlite'],
      `${kind} adapter coverage drifted`,
    );
  }
  for (const sample of samples) {
    const name = JSON.stringify(sample);
    if (sample.kind === 'revisionHistorySplit') {
      assertExactBooleanSample(sample, [
        'sameOldAbstraction',
        'revisionsDiffer',
        'historiesDiffer',
        'sameFutureCommand',
        'futureDiverges',
      ]);
    } else if (sample.kind === 'terminalReceipt') {
      assertExactBooleanSample(
        sample,
        [
          'receiptBound',
          'replayExact',
          'conflictExact',
          'lateCancelNoop',
          'resetGeneration',
          'resetClearsReceipt',
          'resetCounters',
          'oldReplayStale',
          'fenceMonotone',
        ],
        ['outcomeKind', 'terminalState'],
      );
      assert.equal(
        sample.terminalState,
        sample.outcomeKind === 'succeed' ? 'succeeded' : 'failed',
        name,
      );
    } else if (sample.kind === 'cancelOrdering') {
      assertExactBooleanSample(
        sample,
        ['cancelAccepted'],
        ['first', 'finalState', 'completionRejected', 'completionCause'],
      );
      assert.equal(sample.finalState, sample.first === 'cancel' ? 'cancelled' : 'succeeded', name);
      assert.equal(sample.completionRejected, sample.first === 'cancel', name);
      assert.equal(
        sample.completionCause,
        sample.first === 'cancel' ? 'stale_attempt' : 'none',
        name,
      );
    } else if (sample.kind === 'leaseFenceCause') {
      assertExactBooleanSample(sample, [
        'exactBoundaryExpired',
        'reclaimedFence',
        'staleRenewCause',
        'staleSettleCause',
      ]);
    } else if (sample.kind === 'generationCompetition') {
      assertExactBooleanSample(sample, ['exactlyOneReset', 'exactLoser', 'queuedOnce']);
    } else if (sample.kind === 'resetCheckRace') {
      assertExactBooleanSample(
        sample,
        ['checkOnce', 'winnerAdvanced', 'exactLateCause', 'noDoubleGeneration'],
        ['resetKind'],
      );
      assert.ok(['retry', 'rerun'].includes(sample.resetKind), name);
    } else if (sample.kind === 'claimOrderEquivalence') {
      assertExactBooleanSample(sample, ['exactOrder', 'adaptersEquivalent'], ['adapters']);
      assert.equal(
        sample.adapters,
        'memory,sqlite,cas',
        'claimOrderEquivalence adapter coverage drifted',
      );
    } else if (sample.kind === 'claimScanContinuation') {
      assertExactBooleanSample(
        sample,
        [
          'firstPageFull',
          'exhaustedPassReturnsNone',
          'wholeCandidatePageTerminalized',
          'nextInvocationReachesLater',
        ],
        ['adapter'],
      );
    } else if (sample.kind === 'stolenPageContinuation') {
      assertExactBooleanSample(
        sample,
        ['stalePassCanReturnShort', 'nextInvocationReachesBeyondPage', 'stolenRowsRemainOwned'],
        ['adapter'],
      );
    } else if (sample.kind === 'claimLimit') {
      assertExactBooleanSample(
        sample,
        ['exactReturnedLimit', 'exactRunningCount', 'laterDueRemainReachable'],
        ['adapter'],
      );
    } else if (sample.kind === 'finiteClaimDrain') {
      assertExactBooleanSample(sample, ['allUnique', 'allReached', 'boundedPasses'], ['adapter']);
    } else if (sample.kind === 'adapterLifecycleEquivalence') {
      assertExactBooleanSample(sample, ['equivalent'], ['adapters']);
      assert.equal(
        sample.adapters,
        'memory,sqlite,cas',
        'adapterLifecycleEquivalence adapter coverage drifted',
      );
    } else if (sample.kind === 'terminalAckLoss') {
      assertExactBooleanSample(
        sample,
        ['exactAckError', 'durableTerminal', 'receiptDurable', 'replayConverges', 'noSecondWrite'],
        ['outcomeKind'],
      );
    } else if (sample.kind === 'lifecycleArithmetic') {
      assertExactBooleanSample(sample, [
        'fenceOverflowExact',
        'revisionOverflowExact',
        'generationOverflowExact',
        'maximumFiniteClaimAccepted',
      ]);
    } else assert.fail(`Unmapped lifecycle sample: ${name}`);
  }
  return samples.length;
}
