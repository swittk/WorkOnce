import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createWorkOnce, runExternalAvailable, runExternal, WorkConflict } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';

const coverageKeys = [
  'queued',
  'running',
  'waitingRetry',
  'waitingDefer',
  'succeeded',
  'failed',
  'cancelled',
  'claimA',
  'claimB',
  'renew',
  'leaseReclaim',
  'staleRenew',
  'staleSettle',
  'retryAllowed',
  'retryDenied',
  'retryBudgetExhausted',
  'defer',
  'deferralBudgetExhausted',
  'wake',
  'manualRetry',
  'manualRetryDenied',
  'rerun',
  'rerunDenied',
  'cancelQueued',
  'cancelRunning',
  'cancelWaiting',
  'attemptBudgetExhausted',
  'deadlineExceeded',
  'timestampRange',
  'successFollowup',
  'failureFollowup',
  'followupDispatch',
  'followupBlocksReset',
  'identicalSettlementReplay',
  'conflictingSettlementRejected',
  'dynamicLimits',
  'dynamicRetry',
  'dynamicDefer',
  'dynamicNext',
  'outcomeHelperAuthority',
  'itemHandleKeyBinding',
  'workerErrorIsolation',
  'managedRunnerFatalWake',
  'managedExternalFatalWake',
  'managedRunnerFatalClaimBackoffWake',
  'managedExternalFatalClaimBackoffWake',
  'managedRunnerFatalClaimGate',
  'managedExternalFatalClaimGate',
  'generationTwo',
  'fenceIncrease',
  'parallelClaimCompetition',
  'dualExecutorCompetition',
  'externalSuccessFollowup',
  'externalClaimLimit',
  'oneMillisecondLease',
  'invalidExternalRenewal',
  'missingHandlerPromiseRejection',
];
function newCoverage() {
  return Object.fromEntries(coverageKeys.map((key) => [key, 0]));
}
function hit(coverage, ...keys) {
  for (const key of keys) coverage[key] += 1;
}
function snapshotCoverage(coverage, snapshot) {
  if (!snapshot) return;
  if (snapshot.phase.state === 'queued') hit(coverage, 'queued');
  if (snapshot.phase.state === 'running') hit(coverage, 'running');
  if (snapshot.phase.state === 'waiting')
    hit(coverage, snapshot.phase.cause === 'retry' ? 'waitingRetry' : 'waitingDefer');
  if (snapshot.phase.state === 'succeeded') hit(coverage, 'succeeded');
  if (snapshot.phase.state === 'failed') hit(coverage, 'failed');
  if (snapshot.phase.state === 'cancelled') hit(coverage, 'cancelled');
  if (snapshot.generation === 2) hit(coverage, 'generationTwo');
}
function assertSnapshot(snapshot) {
  assert.ok(snapshot);
  assert.ok(Number.isSafeInteger(snapshot.generation) && snapshot.generation >= 1);
  assert.ok(snapshot.attempts >= 0 && snapshot.retries >= 0 && snapshot.deferrals >= 0);
  assert.ok(snapshot.retries <= snapshot.attempts);
  assert.ok(snapshot.deferrals <= snapshot.attempts);
  if (snapshot.pendingFollowups > 0)
    assert.ok(snapshot.phase.state === 'succeeded' || snapshot.phase.state === 'failed');
  if (snapshot.phase.state === 'running') {
    assert.equal(snapshot.phase.attempt.generation, snapshot.generation);
    assert.equal(snapshot.phase.attempt.number, snapshot.attempts);
    assert.ok(snapshot.phase.attempt.fence > 0);
    assert.ok(snapshot.phase.attempt.leaseUntil > 0);
  }
}
function fixture(options = {}) {
  let now = options.now ?? 1000;
  const store = createMemoryStore({ now: () => now });
  const work = createWorkOnce({ store, scope: options.scope ?? 'formal' });
  const child = work.define('child', { key: (input) => input.id });
  const queue = work.define('job', {
    key: (input) => input.id,
    executionLimits: (input) => ({
      leaseMs: input.leaseMs ?? 2,
      maxAttempts: input.maxAttempts ?? 3,
      maxElapsedMs: input.maxElapsedMs ?? 8,
      maxDeferrals: input.maxDeferrals ?? 2,
    }),
    retry: async ({ input, reason, retries }) =>
      reason === 'retryable'
        ? {
            retry: true,
            afterMs: input.retryAfterMs ?? 1,
            maxRetries: input.maxRetries ?? 1,
            manualRetry: true,
          }
        : { retry: false, manualRetry: reason === 'manual-only' },
    wait: async ({ input, deferrals }) => ({
      afterMs: (input.deferAfterMs ?? 1) + Math.min(deferrals, 1),
    }),
    ...(options.dynamicNext
      ? {
          thenDo: async ({ input, result, attempt, outcome }) => [
            child.request(
              { id: `${input.id}:${outcome}:${attempt.generation}:${result.value}` },
              { key: `${input.id}:${outcome}:${attempt.generation}:${result.value}` },
            ),
          ],
        }
      : {}),
  });
  return {
    work,
    queue,
    child,
    now: () => now,
    advance: (amount = 1) => {
      now += amount;
    },
    setNow: (value) => {
      now = value;
    },
  };
}
async function inspect(f, coverage, id = 'x') {
  const snapshot = await f.queue.item({ id }).inspect();
  assertSnapshot(snapshot);
  snapshotCoverage(coverage, snapshot);
  return snapshot;
}
async function expectConflict(promise, code) {
  await assert.rejects(promise, (error) => error instanceof WorkConflict && error.code === code);
}

async function terminalMatrix(coverage) {
  let scenarios = 0;
  for (const workerId of ['A', 'B'])
    for (const terminal of ['success', 'fail-manual', 'fail-hard'])
      for (const withNext of [false, true]) {
        scenarios++;
        const f = fixture({ scope: `terminal-${workerId}-${terminal}-${withNext}` });
        const item = f.queue.item({ id: 'x' });
        await item.ensure();
        await inspect(f, coverage);
        const [run] = await f.queue.claim({ workerId });
        assert.ok(run);
        hit(coverage, workerId === 'A' ? 'claimA' : 'claimB');
        await inspect(f, coverage);
        const next = withNext
          ? [
              f.child.request(
                { id: `child-${workerId}-${terminal}` },
                { key: `child-${workerId}-${terminal}` },
              ),
            ]
          : [];
        const outcome =
          terminal === 'success'
            ? run.succeed({ value: 1 }, { next })
            : run.fail('terminal', {
                manualRetry: terminal === 'fail-manual',
                result: { value: 1 },
                next,
              });
        const phase = await run.settle(outcome);
        assert.equal(phase.state, terminal === 'success' ? 'succeeded' : 'failed');
        let snapshot = await inspect(f, coverage);
        if (withNext) {
          hit(
            coverage,
            terminal === 'success' ? 'successFollowup' : 'failureFollowup',
            'followupBlocksReset',
          );
          if (terminal === 'success')
            await expectConflict(f.queue.rerun({ key: 'x', generation: 1 }), 'retry_denied');
          else if (terminal === 'fail-manual')
            await expectConflict(f.queue.retry({ key: 'x', generation: 1 }), 'retry_denied');
          hit(coverage, terminal === 'success' ? 'rerunDenied' : 'manualRetryDenied');
          assert.equal(await f.work.dispatch(), 1);
          hit(coverage, 'followupDispatch');
          snapshot = await inspect(f, coverage);
          assert.equal(snapshot.pendingFollowups, 0);
        }
        if (terminal === 'success') {
          await f.queue.rerun({ key: 'x', generation: 1 });
          hit(coverage, 'rerun');
          await inspect(f, coverage);
        } else if (terminal === 'fail-manual') {
          await f.queue.retry({ key: 'x', generation: 1 });
          hit(coverage, 'manualRetry');
          await inspect(f, coverage);
        } else {
          await expectConflict(f.queue.retry({ key: 'x', generation: 1 }), 'retry_denied');
          hit(coverage, 'manualRetryDenied');
        }
      }
  return scenarios;
}
async function waitingMatrix(coverage) {
  let scenarios = 0;
  for (const reason of ['retryable', 'denied', 'manual-only']) {
    scenarios++;
    const f = fixture({ scope: `retry-${reason}` });
    await f.queue.item({ id: 'x', maxRetries: 1 }).ensure();
    const [run] = await f.queue.claim({ workerId: 'A' });
    const phase = await run.settle(run.retry(reason));
    hit(coverage, 'dynamicRetry');
    if (reason === 'retryable') {
      assert.equal(phase.state, 'waiting');
      hit(coverage, 'retryAllowed');
      await inspect(f, coverage);
      f.advance(1);
      const [again] = await f.queue.claim({ workerId: 'B' });
      assert.ok(again);
      hit(coverage, 'claimB');
      const exhausted = await again.settle(again.retry('retryable'));
      assert.equal(exhausted.state, 'failed');
      assert.equal(exhausted.stoppedBy, 'retry_budget_exhausted');
      hit(coverage, 'retryBudgetExhausted');
      await inspect(f, coverage);
    } else {
      assert.equal(phase.state, 'failed');
      hit(coverage, 'retryDenied');
      if (reason === 'manual-only') assert.equal(phase.manualRetry, true);
      await inspect(f, coverage);
    }
  }
  for (const maxDeferrals of [1, 2]) {
    scenarios++;
    const f = fixture({ scope: `defer-${maxDeferrals}` });
    await f.queue.item({ id: 'x', maxDeferrals }).ensure();
    let [run] = await f.queue.claim({ workerId: 'A' });
    let phase = await run.settle(run.wait('pending'));
    hit(coverage, 'defer', 'dynamicDefer');
    assert.equal(phase.state, 'waiting');
    let waiting = await inspect(f, coverage);
    await f.queue.wake({ key: 'x', generation: waiting.generation, revision: waiting.revision });
    hit(coverage, 'wake');
    [run] = await f.queue.claim({ workerId: 'B' });
    phase = await run.settle(run.wait('pending'));
    hit(coverage, 'defer');
    if (maxDeferrals === 1) {
      assert.equal(phase.state, 'failed');
      assert.equal(phase.stoppedBy, 'deferral_budget_exhausted');
      hit(coverage, 'deferralBudgetExhausted');
    } else assert.equal(phase.state, 'waiting');
    await inspect(f, coverage);
  }
  return scenarios;
}
async function fencingAndBudgets(coverage) {
  let scenarios = 0;
  for (const [firstWorker, secondWorker] of [
    ['A', 'B'],
    ['B', 'A'],
  ]) {
    scenarios++;
    const f = fixture({ scope: `fence-${firstWorker}` });
    await f.queue.item({ id: 'x', leaseMs: 1 }).ensure();
    const [old] = await f.queue.claim({ workerId: firstWorker });
    const oldFence = old.ref.fence;
    f.advance(1);
    const [current] = await f.queue.claim({ workerId: secondWorker });
    assert.ok(current.ref.fence > oldFence);
    hit(coverage, 'leaseReclaim', 'fenceIncrease');
    await expectConflict(old.heartbeat(), 'stale_attempt');
    hit(coverage, 'staleRenew');
    for (const outcome of [
      old.succeed({ value: 1 }),
      old.fail('terminal'),
      old.retry('retryable'),
      old.wait('pending'),
    ]) {
      await expectConflict(old.settle(outcome), 'stale_attempt');
      hit(coverage, 'staleSettle');
    }
    await current.heartbeat();
    hit(coverage, 'renew');
    await current.settle(current.succeed({ value: 2 }));
    await inspect(f, coverage);
  }
  {
    scenarios++;
    const f = fixture({ scope: 'attempt-budget' });
    await f.queue.item({ id: 'x', leaseMs: 1, maxAttempts: 2 }).ensure();
    await f.queue.claim({ workerId: 'A' });
    f.advance(1);
    await f.queue.claim({ workerId: 'B' });
    f.advance(1);
    assert.equal((await f.queue.claim({ workerId: 'C' })).length, 0);
    const s = await inspect(f, coverage);
    assert.equal(s.phase.state, 'failed');
    assert.equal(s.phase.stoppedBy, 'attempt_budget_exhausted');
    hit(coverage, 'attemptBudgetExhausted');
  }
  {
    scenarios++;
    const f = fixture({ scope: 'deadline' });
    await f.queue.item({ id: 'x', leaseMs: 2, maxAttempts: 3, maxElapsedMs: 2 }).ensure();
    const [a] = await f.queue.claim({ workerId: 'A' });
    f.advance(1);
    await a.heartbeat();
    f.advance(1);
    assert.equal((await f.queue.claim({ workerId: 'B' })).length, 0);
    const s = await inspect(f, coverage);
    assert.equal(s.phase.state, 'failed');
    assert.equal(s.phase.stoppedBy, 'deadline_exceeded');
    hit(coverage, 'deadlineExceeded');
  }
  {
    scenarios++;
    let now = 1000;
    const work = createWorkOnce({
      store: createMemoryStore({ now: () => now }),
      scope: 'timestamp-range',
    });
    const queue = work.define('job', {
      executionLimits: { leaseMs: 1000, maxElapsedMs: 400, maxAttempts: 3 },
      retry: { retry: true, afterMs: 1000, maxRetries: 2, manualRetry: true },
    });
    await queue.ensure(null, { key: 'x' });
    now = Number.MAX_SAFE_INTEGER - 500;
    const [run] = await queue.claim({ workerId: 'late' });
    assert.equal(run.attempt.leaseUntil, Number.MAX_SAFE_INTEGER - 100);
    now = Number.MAX_SAFE_INTEGER - 200;
    assert.equal((await run.heartbeat()).attempt.leaseUntil, Number.MAX_SAFE_INTEGER - 100);
    const phase = await run.settle(run.retry('busy', { afterMs: 1000 }));
    assert.equal(phase.state, 'failed');
    assert.equal(phase.stoppedBy, 'deadline_exceeded');
    hit(coverage, 'timestampRange', 'deadlineExceeded');
  }
  return scenarios;
}
async function cancellationMatrix(coverage) {
  let scenarios = 0;
  {
    scenarios++;
    const f = fixture({ scope: 'cancel-queued' });
    const item = f.queue.item({ id: 'x' });
    await item.ensure();
    await item.cancel();
    hit(coverage, 'cancelQueued');
    await inspect(f, coverage);
  }
  {
    scenarios++;
    const f = fixture({ scope: 'cancel-running' });
    const item = f.queue.item({ id: 'x' });
    await item.ensure();
    const [run] = await f.queue.claim({ workerId: 'A' });
    const result = await item.cancel();
    assert.equal(result.activeAttempt.fence, run.ref.fence);
    hit(coverage, 'cancelRunning');
    await expectConflict(run.settle(run.succeed({ value: 1 })), 'stale_attempt');
    await inspect(f, coverage);
  }
  {
    scenarios++;
    const f = fixture({ scope: 'cancel-waiting' });
    const item = f.queue.item({ id: 'x' });
    await item.ensure();
    const [run] = await f.queue.claim({ workerId: 'A' });
    await run.settle(run.wait('pending'));
    await item.cancel();
    hit(coverage, 'cancelWaiting');
    await inspect(f, coverage);
  }
  return scenarios;
}
async function replayAndDynamicPolicies(coverage) {
  let scenarios = 0;
  {
    scenarios++;
    const f = fixture({ scope: 'receipt' });
    await f.queue.item({ id: 'x' }).ensure();
    const [run] = await f.queue.claim({ workerId: 'A' });
    const outcome = run.succeed({ value: 1 });
    const first = await run.settle(outcome);
    assert.deepEqual(await run.settle(outcome), first);
    hit(coverage, 'identicalSettlementReplay');
    await expectConflict(run.settle(run.fail('terminal')), 'settlement_conflict');
    hit(coverage, 'conflictingSettlementRejected');
  }
  {
    scenarios++;
    const f = fixture({ scope: 'dynamic-next', dynamicNext: true });
    await f.queue.item({ id: 'x', leaseMs: 3 }).ensure();
    const [run] = await f.queue.claim({ workerId: 'A' });
    assert.equal(run.attempt.leaseUntil, run.observedAt + 3);
    hit(coverage, 'dynamicLimits');
    await run.settle(run.succeed({ value: 7 }));
    hit(coverage, 'dynamicNext');
    const s = await inspect(f, coverage);
    assert.equal(s.pendingFollowups, 1);
    await f.work.dispatch();
    hit(coverage, 'followupDispatch');
  }
  {
    scenarios++;
    const f = fixture({ scope: 'parallel' });
    await f.queue.item({ id: 'x' }).ensure();
    const groups = await Promise.all(
      Array.from({ length: 16 }, (_, index) => f.queue.claim({ workerId: `W${index}` })),
    );
    assert.equal(groups.flat().length, 1);
    hit(coverage, 'parallelClaimCompetition');
  }
  {
    scenarios++;
    const f = fixture({ scope: 'outcome-helper-authority' });
    await f.queue.item({ id: 'x' }).ensure();
    let [run] = await f.queue.claim({ workerId: 'A' });
    const timing = { afterMs: 1, type: 'succeed', reason: 'hijacked' };
    const retried = run.retry('retryable', timing);
    assert.equal(retried.type, 'retry');
    assert.equal(retried.reason, 'retryable');
    await run.settle(retried);
    f.advance(1);
    [run] = await f.queue.claim({ workerId: 'B' });
    const waited = run.wait('pending', timing);
    assert.equal(waited.type, 'defer');
    assert.equal(waited.reason, 'pending');
    await run.settle(waited);
    hit(coverage, 'outcomeHelperAuthority');
  }
  {
    scenarios++;
    let now = 1000;
    const store = createMemoryStore({ now: () => now });
    const work = createWorkOnce({ store, scope: 'item-handle-key-binding' });

    const cancelQueue = work.define('cancel');
    await cancelQueue.ensure(null, { key: 'a' });
    await cancelQueue.ensure(null, { key: 'b' });
    await cancelQueue.item(null, 'a').cancel({ key: 'b', reason: 'owner-cancel' });
    assert.equal((await cancelQueue.inspect('a')).phase.state, 'cancelled');
    assert.equal((await cancelQueue.inspect('b')).phase.state, 'queued');

    const restartQueue = work.define('restart');
    await restartQueue.ensure(null, { key: 'a' });
    await restartQueue.ensure(null, { key: 'b' });
    for (const claimed of await restartQueue.claim({ workerId: 'finish', limit: 2 }))
      await claimed.settle(claimed.succeed());
    await restartQueue.item(null, 'a').restart({ key: 'b', expectedGeneration: 1 });
    assert.equal((await restartQueue.inspect('a')).generation, 2);
    assert.equal((await restartQueue.inspect('b')).generation, 1);

    const wakeQueue = work.define('wake', { wait: { afterMs: 100 } });
    await wakeQueue.ensure(null, { key: 'a' });
    await wakeQueue.ensure(null, { key: 'b' });
    for (const claimed of await wakeQueue.claim({ workerId: 'wait', limit: 2 }))
      await claimed.settle(claimed.wait('pending'));
    await wakeQueue.item(null, 'a').wake({ key: 'b', expectedGeneration: 1 });
    assert.equal((await wakeQueue.inspect('a')).phase.availableAt, now);
    assert.equal((await wakeQueue.inspect('b')).phase.availableAt, now + 100);
    hit(coverage, 'itemHandleKeyBinding');
  }
  {
    scenarios++;
    let localExecutions = 0;
    const store = createMemoryStore();
    const work = createWorkOnce({ store, scope: 'dual-executor' });
    const queue = work.define('job', {
      key: (input) => input.id,
      perform: async (run) => {
        localExecutions++;
        return run.succeed({ value: 1 });
      },
    });
    const external = queue.serveExternal({
      prepare: (run) => run.handoff({ id: run.input.id }),
      onPrepareError: (run) => run.fail('terminal'),
    });
    await queue.ensure({ id: 'x' });
    const [local, leased] = await Promise.all([
      queue.runAvailable({ workerId: 'local' }),
      external.claim({ workerId: 'external', limit: 1 }),
    ]);
    assert.equal(local.length + leased.length, 1);
    assert.ok(localExecutions === 0 || localExecutions === 1);
    if (leased.length) {
      await external.settle(leased[0].attempt, {
        type: 'succeed',
        result: { value: 2 },
        next: [],
      });
    }
    assert.equal((await queue.item({ id: 'x' }).inspect()).phase.state, 'succeeded');
    hit(coverage, 'parallelClaimCompetition', 'dualExecutorCompetition');
  }
  {
    scenarios++;
    const store = createMemoryStore();
    const work = createWorkOnce({ store, scope: 'external-success-followup' });
    const parent = work.define('parent');
    const child = work.define('child');
    const external = parent.serveExternal({
      prepare: (run) => run.handoff(run.input),
      onPrepareError: (run) => run.fail('terminal'),
    });
    await external.ensure({ id: 'x' }, { key: 'x' });
    const [result] = await runExternalAvailable(
      external,
      { workerId: 'external', concurrency: 1, signal: new AbortController().signal },
      async (run, input) =>
        run.succeed(
          { value: 2 },
          { thenDo: [child.request({ parent: input.id }, { key: `child:${input.id}` })] },
        ),
    );
    assert.equal(result.status, 'settled');
    let snapshot = await parent.inspect('x');
    assertSnapshot(snapshot);
    snapshotCoverage(coverage, snapshot);
    assert.equal(snapshot.pendingFollowups, 1);
    hit(coverage, 'externalSuccessFollowup', 'successFollowup', 'followupBlocksReset');
    assert.equal(await work.dispatch(), 1);
    hit(coverage, 'followupDispatch');
    snapshot = await parent.inspect('x');
    assertSnapshot(snapshot);
    snapshotCoverage(coverage, snapshot);
    assert.equal(snapshot.pendingFollowups, 0);
    assert.equal((await child.inspect('child:x')).phase.state, 'queued');
  }
  {
    scenarios++;
    const store = createMemoryStore();
    const work = createWorkOnce({ store, scope: 'external-claim-limit' });
    const queue = work.define('job', { executionLimits: { leaseMs: 1000 } });
    const base = queue.serveExternal({
      prepare: (run) => run.handoff(run.input),
      onPrepareError: (run) => run.fail('terminal'),
    });
    await base.ensure({ id: 'a' }, { key: 'a' });
    await base.ensure({ id: 'b' }, { key: 'b' });
    const oversized = {
      ...base,
      claim(request) {
        return base.claim({ ...request, limit: 2 });
      },
    };
    let started = 0;
    await assert.rejects(
      runExternalAvailable(
        oversized,
        { workerId: 'external', concurrency: 1, signal: new AbortController().signal },
        async (run) => {
          started++;
          return run.succeed();
        },
      ),
      /more leases than requested/,
    );
    assert.equal(started, 0);
    hit(coverage, 'externalClaimLimit');
  }
  {
    scenarios++;
    const f = fixture({ scope: 'one-millisecond-lease' });
    await f.queue.item({ id: 'x', leaseMs: 1, maxAttempts: 2 }).ensure();
    const [result] = await f.queue.runAvailable({ workerId: 'A' }, async (run) =>
      run.succeed({ value: 1 }),
    );
    if (result.status === 'interrupted') {
      assert.doesNotMatch(String(result.error), /heartbeatMs must be shorter than the lease/);
    } else {
      assert.equal(result.status, 'settled');
    }
    hit(coverage, 'oneMillisecondLease');
  }
  {
    scenarios++;
    let settleCalls = 0;
    const transport = {
      async claim() {
        return [
          {
            input: null,
            attempt: { workId: 'renewal-invalid', generation: 1, fence: 1 },
            observedAt: 100,
            leaseUntil: 200,
          },
        ];
      },
      async heartbeat() {
        return { leaseUntil: Number.NaN, observedAt: Number.NaN };
      },
      async settle() {
        settleCalls++;
        return { state: 'succeeded', result: null };
      },
    };
    let sawAbort = false;
    const [result] = await runExternalAvailable(
      transport,
      { workerId: 'external', heartbeatMs: 1, signal: new AbortController().signal },
      async (run) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        sawAbort = run.signal.aborted;
        run.signal.throwIfAborted();
        return run.succeed();
      },
    );
    assert.equal(sawAbort, true);
    assert.equal(result.status, 'interrupted');
    assert.equal(settleCalls, 0);
    hit(coverage, 'invalidExternalRenewal');
  }
  {
    scenarios++;
    const work = createWorkOnce({
      store: createMemoryStore({ now: () => 1000 }),
      scope: 'missing-handler',
    });
    const queue = work.define('job');
    await queue.ensure(null, { key: 'x' });
    const available = queue.runAvailable({ workerId: 'A' });
    const compat = queue.process({ workerId: 'A' });
    const managed = queue.run({ workerId: 'A', signal: new AbortController().signal });
    assert.equal(typeof available.then, 'function');
    assert.equal(typeof compat.then, 'function');
    assert.equal(typeof managed.then, 'function');
    await assert.rejects(available, /no perform handler/);
    await assert.rejects(compat, /no perform handler/);
    await assert.rejects(managed, /no perform handler/);
    hit(coverage, 'missingHandlerPromiseRejection');
  }
  {
    scenarios++;
    const f = fixture({ scope: 'worker-isolation' });
    await f.queue.item({ id: 'bad', leaseMs: 1000 }).ensure();
    await f.queue.item({ id: 'good', leaseMs: 1000 }).ensure();
    const results = await f.queue.runAvailable(
      { workerId: 'batch', concurrency: 2 },
      async (run) => {
        if (run.input.id === 'bad') throw new Error('synthetic handler failure');
        return run.succeed({ value: 1 });
      },
    );
    assert.equal(results.filter((result) => result.status === 'interrupted').length, 1);
    assert.equal(results.filter((result) => result.status === 'settled').length, 1);
    assert.equal((await f.queue.item({ id: 'good' }).inspect()).phase.state, 'succeeded');
    hit(coverage, 'workerErrorIsolation');
  }
  {
    scenarios++;
    const base = createMemoryStore();
    let failAtomic = false;
    const store = {
      ...base,
      async atomic(id, decide) {
        if (failAtomic) throw new Error('renewal storage down');
        return base.atomic(id, decide);
      },
    };
    const queue = createWorkOnce({ store, scope: 'managed-runner-fatal-wake' }).define('job', {
      limits: { leaseMs: 500 },
    });
    await queue.ensure(null, { key: 'x' });
    const stop = new AbortController();
    const startedAt = performance.now();
    await assert.rejects(
      queue.run(
        { workerId: 'A', concurrency: 2, heartbeatMs: 20, idleMs: 2000, signal: stop.signal },
        async (run) => {
          failAtomic = true;
          await new Promise((resolve) => setTimeout(resolve, 80));
          return run.succeed();
        },
      ),
      /Worker ownership lost/,
    );
    assert.ok(performance.now() - startedAt < 500);
    stop.abort();
    hit(coverage, 'managedRunnerFatalWake');
  }
  {
    scenarios++;
    const work = createWorkOnce({
      store: createMemoryStore(),
      scope: 'managed-external-fatal-wake',
    });
    const queue = work.define('job', { limits: { leaseMs: 500 } });
    const base = queue.serveExternal({
      prepare: (run) => run.handoff(run.input),
      onPrepareError: (run) => run.fail('terminal'),
    });
    await base.ensure(null, { key: 'x' });
    let claims = 0;
    const transport = {
      ...base,
      async claim(request) {
        claims++;
        if (claims === 1) return base.claim(request);
        return [];
      },
      async heartbeat() {
        throw new Error('external renewal down');
      },
    };
    const stop = new AbortController();
    const startedAt = performance.now();
    await assert.rejects(
      runExternal(
        transport,
        {
          workerId: 'external',
          concurrency: 2,
          heartbeatMs: 20,
          idleMs: 2000,
          signal: stop.signal,
        },
        async (run) => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return run.succeed();
        },
      ),
      /External ownership lost/,
    );
    assert.ok(performance.now() - startedAt < 500);
    stop.abort();
    hit(coverage, 'managedExternalFatalWake');
  }
  {
    scenarios++;
    const base = createMemoryStore();
    let failAtomic = false;
    const store = {
      ...base,
      async atomic(id, decide) {
        if (failAtomic) throw new Error('renewal storage down');
        return base.atomic(id, decide);
      },
    };
    const queue = createWorkOnce({
      store,
      scope: 'managed-runner-fatal-claim-backoff-wake',
    }).define('job', { limits: { leaseMs: 500 } });
    await queue.ensure(null, { key: 'x' });
    const originalClaim = queue.claim.bind(queue);
    let claimCalls = 0;
    queue.claim = async (options) => {
      claimCalls++;
      if (claimCalls === 1) return originalClaim({ ...options, limit: 1 });
      throw new Error('claim poll failed');
    };
    const stop = new AbortController();
    const startedAt = performance.now();
    await assert.rejects(
      queue.run(
        {
          workerId: 'local',
          concurrency: 2,
          heartbeatMs: 20,
          idleMs: 2000,
          signal: stop.signal,
          onError: async (error) => {
            if (error instanceof Error && error.message === 'claim poll failed') {
              await new Promise((resolve) => setTimeout(resolve, 120));
              return;
            }
            throw error;
          },
        },
        async (run) => {
          failAtomic = true;
          await new Promise((resolve) => setTimeout(resolve, 80));
          return run.succeed();
        },
      ),
      /Worker ownership lost/,
    );
    assert.ok(performance.now() - startedAt < 500);
    stop.abort();
    hit(coverage, 'managedRunnerFatalClaimBackoffWake');
  }
  {
    scenarios++;
    const work = createWorkOnce({
      store: createMemoryStore(),
      scope: 'managed-external-fatal-claim-backoff-wake',
    });
    const queue = work.define('job', { limits: { leaseMs: 500 } });
    const base = queue.serveExternal({
      prepare: (run) => run.handoff(run.input),
      onPrepareError: (run) => run.fail('terminal'),
    });
    await base.ensure(null, { key: 'x' });
    let claimCalls = 0;
    const transport = {
      ...base,
      async claim(request) {
        claimCalls++;
        if (claimCalls === 1) return base.claim({ ...request, limit: 1 });
        throw new Error('claim poll failed');
      },
      async heartbeat() {
        throw new Error('external renewal down');
      },
    };
    const stop = new AbortController();
    const startedAt = performance.now();
    await assert.rejects(
      runExternal(
        transport,
        {
          workerId: 'external',
          concurrency: 2,
          heartbeatMs: 20,
          idleMs: 2000,
          signal: stop.signal,
          onError: async (error) => {
            if (error instanceof Error && error.message === 'claim poll failed') {
              await new Promise((resolve) => setTimeout(resolve, 120));
              return;
            }
            throw error;
          },
        },
        async (run) => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return run.succeed();
        },
      ),
      /External ownership lost/,
    );
    assert.ok(performance.now() - startedAt < 500);
    stop.abort();
    hit(coverage, 'managedExternalFatalClaimBackoffWake');
  }
  {
    scenarios++;
    const queue = createWorkOnce({
      store: createMemoryStore(),
      scope: 'managed-runner-fatal-claim-gate',
    }).define('job', { key: (input) => input.id, limits: { leaseMs: 500 } });
    await queue.ensure({ id: 'a' });
    await queue.ensure({ id: 'b' });
    const originalClaim = queue.claim.bind(queue);
    let claimCalls = 0;
    let releaseSecondClaim;
    const secondClaimGate = new Promise((resolve) => {
      releaseSecondClaim = resolve;
    });
    queue.claim = async (options) => {
      claimCalls++;
      if (claimCalls === 1) return originalClaim({ ...options, limit: 1 });
      await secondClaimGate;
      return originalClaim({ ...options, limit: 1 });
    };
    let releaseHandler;
    const handlerGate = new Promise((resolve) => {
      releaseHandler = resolve;
    });
    const started = [];
    const stop = new AbortController();
    const running = queue.run(
      { workerId: 'local', concurrency: 2, heartbeatMs: 100, idleMs: 1000, signal: stop.signal },
      async (run, input) => {
        started.push(input.id);
        if (input.id === 'a') await handlerGate;
        return run.succeed();
      },
    );
    while (started.length < 1 || claimCalls < 2)
      await new Promise((resolve) => setTimeout(resolve, 1));
    await queue.cancelCurrent({ key: 'a', reason: 'revoked' });
    releaseHandler();
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseSecondClaim();
    await assert.rejects(running, /stale_attempt/);
    assert.deepEqual(started, ['a']);
    stop.abort();
    hit(coverage, 'managedRunnerFatalClaimGate');
  }
  {
    scenarios++;
    const queue = createWorkOnce({
      store: createMemoryStore(),
      scope: 'managed-external-fatal-claim-gate',
    }).define('job', { limits: { leaseMs: 500 } });
    const base = queue.serveExternal({
      prepare: (run) => run.handoff(run.input),
      onPrepareError: (run) => run.fail('terminal'),
    });
    await base.ensure({ id: 'a' }, { key: 'a' });
    await base.ensure({ id: 'b' }, { key: 'b' });
    let claimCalls = 0;
    let releaseSecondClaim;
    const secondClaimGate = new Promise((resolve) => {
      releaseSecondClaim = resolve;
    });
    const transport = {
      ...base,
      async claim(request) {
        claimCalls++;
        if (claimCalls === 1) return base.claim({ ...request, limit: 1 });
        await secondClaimGate;
        return base.claim({ ...request, limit: 1 });
      },
      async heartbeat() {
        throw new Error('external renewal down');
      },
    };
    const started = [];
    const stop = new AbortController();
    const running = runExternal(
      transport,
      { workerId: 'external', concurrency: 2, heartbeatMs: 20, idleMs: 1000, signal: stop.signal },
      async (run, input) => {
        started.push(input.id);
        if (input.id === 'a') await new Promise((resolve) => setTimeout(resolve, 80));
        return run.succeed();
      },
    );
    while (claimCalls < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 120));
    releaseSecondClaim();
    await assert.rejects(running, /External ownership lost/);
    assert.deepEqual(started, ['a']);
    stop.abort();
    hit(coverage, 'managedExternalFatalClaimGate');
  }
  return scenarios;
}
function xorshift(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x >>> 0;
  };
}
const FUZZ_STEPS_PER_TRACE = 10;

async function fuzz(coverage) {
  const traces = 96;
  const steps = FUZZ_STEPS_PER_TRACE;
  for (let seed = 1; seed <= traces; seed++) {
    const random = xorshift(seed * 0x9e3779b1);
    const f = fixture({ scope: `fuzz-${seed}` });
    const item = f.queue.item({
      id: 'x',
      leaseMs: 2,
      maxAttempts: 3,
      maxElapsedMs: 6,
      maxDeferrals: 2,
      maxRetries: 1,
    });
    await item.ensure();
    const runs = [];
    for (let step = 0; step < steps; step++) {
      const s = await inspect(f, coverage);
      const pick = random() % 7;
      try {
        if (s.phase.state === 'queued') {
          if (pick === 0) {
            await item.cancel();
            hit(coverage, 'cancelQueued');
          } else {
            const [run] = await f.queue.claim({ workerId: pick % 2 ? 'A' : 'B' });
            if (run) runs.push(run);
          }
        } else if (s.phase.state === 'running') {
          const run = runs.findLast((candidate) => candidate.ref.fence === s.phase.attempt.fence);
          if (!run) {
            f.advance(1);
            continue;
          }
          if (pick === 0) await run.heartbeat();
          else if (pick === 1) await run.settle(run.retry('retryable'));
          else if (pick === 2) await run.settle(run.retry('denied'));
          else if (pick === 3) await run.settle(run.wait('pending'));
          else if (pick === 4) await run.settle(run.fail('terminal', { manualRetry: true }));
          else if (pick === 5) await item.cancel();
          else await run.settle(run.succeed({ value: seed }));
        } else if (s.phase.state === 'waiting') {
          if (pick === 0) await item.cancel();
          else if (pick <= 2) await item.wake();
          else f.advance(1);
        } else if (s.phase.state === 'failed') {
          if (s.pendingFollowups) await f.work.dispatch();
          else if (s.phase.manualRetry && pick % 2) await item.restart();
          else break;
        } else if (s.phase.state === 'succeeded') {
          if (s.pendingFollowups) await f.work.dispatch();
          else if (pick % 2) await item.restart();
          else break;
        } else break;
      } catch (error) {
        if (!(error instanceof WorkConflict)) throw error;
      }
      if ((random() & 3) === 0) f.advance(1);
    }
  }
  return traces;
}

export async function runBoundedRefinementCorpus() {
  const coverage = newCoverage();
  let scenarios = 0;
  scenarios += await terminalMatrix(coverage);
  scenarios += await waitingMatrix(coverage);
  scenarios += await fencingAndBudgets(coverage);
  scenarios += await cancellationMatrix(coverage);
  scenarios += await replayAndDynamicPolicies(coverage);
  const fuzzTraces = await fuzz(coverage);
  const missing = Object.entries(coverage)
    .filter(([, count]) => count === 0)
    .map(([key]) => key);
  if (missing.length)
    throw new Error(`Bounded refinement corpus missed required coverage: ${missing.join(', ')}`);
  return {
    version: 1,
    deterministicScenarios: scenarios,
    fuzzTraces,
    fuzzStepsPerTrace: FUZZ_STEPS_PER_TRACE,
    coverage,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runBoundedRefinementCorpus(), null, 2));
}
