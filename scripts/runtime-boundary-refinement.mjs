import assert from 'node:assert/strict';
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';
import { createWorkOnce, runExternal, exponentialBackoff } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
import {
  assertTypedReadBoundarySamples,
  runTypedReadBoundarySamples,
  typedReadAdapterEvidenceFields,
} from './read-boundary-refinement.mjs';

export const auditPhases = [
  'queued',
  'running',
  'waitingRetry',
  'waitingDefer',
  'failedManual',
  'failedDenied',
  'succeeded',
  'cancelled',
];

export async function seedAuditPhase(store, scope, phase) {
  const queue = createWorkOnce({ store, scope }).define('job', {
    version: '1',
    limits: { leaseMs: 5000 },
    retry: { retry: true, afterMs: 0, maxRetries: 3, manualRetry: true },
  });
  await queue.ensure({ value: 1 }, { key: 'job' });
  let run, outcome;
  if (phase !== 'queued') {
    [run] = await queue.claim({ workerId: 'owner' });
    if (phase === 'waitingRetry') outcome = run.retry('pending', { afterMs: 0 });
    if (phase === 'waitingDefer') outcome = run.wait('pending', { afterMs: 0 });
    if (phase === 'failedManual' || phase === 'failedDenied')
      outcome = run.fail('failed', { manualRetry: phase === 'failedManual' });
    if (phase === 'succeeded') outcome = run.succeed({ value: 2 });
    if (outcome) await run.settle(outcome);
    if (phase === 'cancelled') await queue.cancel({ key: 'job', generation: 1 });
  }
  return { queue, run, outcome, snapshot: await queue.inspect('job') };
}

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

function runnerFailureValue(error) {
  if (error === undefined) return 'undefined';
  if (error === null) return 'null';
  if (error === 0) return 'zero';
  if (error === '') return 'empty';
  if (error instanceof Error && /B$/u.test(error.message)) return 'errorB';
  return 'errorA';
}

async function runnerSample(mode, site, error, errorValue = runnerFailureValue(error)) {
  const stop = new AbortController();
  const base = createMemoryStore();
  const claimError = new Error('claim fault');
  let queries = 0,
    handlerFinished = false,
    observedError,
    timedOut = false;
  const release = deferred();
  const claimFails = site === 'claim' || site === 'claimObserver' || site === 'handledClaim';
  const backoff = site.startsWith('backoff');
  const store = {
    ...base,
    async query(query) {
      if (claimFails || (backoff && ++queries > 1))
        throw site === 'claim' || site === 'handledClaim' ? error : claimError;
      return base.query(query);
    },
  };
  const queue = createWorkOnce({ store, scope: 'runner-boundary' }).define('job', {
    limits: { leaseMs: 5000 },
  });
  if (!claimFails) await queue.ensure(null, { key: 'job' });
  const service = queue.serveExternal({
    prepare: (run) => run.handoff(run.input),
    onPrepareError: (run) => run.fail('prepare'),
  });
  const options = {
    workerId: mode,
    concurrency: backoff ? 2 : 1,
    heartbeatMs: 100,
    idleMs: 10000,
    signal: stop.signal,
  };
  if (site.endsWith('Observer') || site.startsWith('handled') || backoff) {
    options.onError = async (failure) => {
      if (backoff && failure === claimError) {
        if (site === 'backoffBefore') {
          release.resolve();
          await nextTurn();
        } else setTimeout(release.resolve, 0);
        return;
      }
      observedError = failure;
      if (site.startsWith('handled')) {
        stop.abort();
        return;
      }
      throw error;
    };
  }
  const handler = async () => {
    if (backoff) await within(release.promise, 'runtime-boundary release');
    handlerFinished = true;
    throw site === 'activeObserver' ? new Error('handler fault') : error;
  };
  const watchdog = setTimeout(() => {
    timedOut = true;
    stop.abort();
    release.resolve();
  }, 1000);
  let result;
  try {
    result = await observe(
      mode === 'local' ? queue.run(options, handler) : runExternal(service, options, handler),
    );
  } finally {
    clearTimeout(watchdog);
    stop.abort();
  }
  const handled = site.startsWith('handled');
  return {
    kind: 'runner',
    mode,
    site,
    errorKind: error === undefined ? 'undefined' : 'defined',
    failureValue: handled ? 'none' : errorValue,
    returnedValue: result.rejected ? runnerFailureValue(result.error) : 'none',
    handled,
    rejected: result.rejected,
    preserved: handled ? observedError === error : result.error === error,
    drained: claimFails || handlerFinished,
    timedOut,
  };
}

async function firstFatalSample(mode) {
  const queue = createWorkOnce({ store: createMemoryStore(), scope: `first-fatal-${mode}` }).define(
    'job',
    { key: (input) => input.id, limits: { leaseMs: 5000 } },
  );
  await queue.ensure({ id: 'a' });
  await queue.ensure({ id: 'b' });
  const first = new Error('first fatal A');
  const second = new Error('second fatal B');
  const bothStarted = deferred();
  let started = 0;
  const stop = new AbortController();
  const handler = async (_run, input) => {
    started++;
    if (started === 2) bothStarted.resolve();
    await within(bothStarted.promise, `${mode} first-fatal both-active`);
    if (input.id === 'a') throw first;
    await sleep(20);
    throw second;
  };
  const service = queue.serveExternal({
    prepare: (run) => run.handoff(run.input),
    onPrepareError: (run) => run.fail('prepare'),
  });
  let result;
  try {
    result = await within(
      observe(
        mode === 'local'
          ? queue.run(
              {
                workerId: mode,
                concurrency: 2,
                heartbeatMs: 100,
                idleMs: 1000,
                signal: stop.signal,
              },
              handler,
            )
          : runExternal(
              service,
              {
                workerId: mode,
                concurrency: 2,
                heartbeatMs: 100,
                idleMs: 1000,
                signal: stop.signal,
              },
              handler,
            ),
      ),
      `${mode} first-fatal runner exit`,
    );
  } finally {
    stop.abort();
  }
  return {
    kind: 'runner',
    mode,
    site: 'firstFatal',
    errorKind: 'defined',
    failureValue: 'errorA',
    returnedValue: result.rejected ? runnerFailureValue(result.error) : 'none',
    handled: false,
    rejected: result.rejected,
    preserved: result.error === first,
    drained: started === 2,
    timedOut: false,
  };
}

async function drainSample(mode, error) {
  const queue = createWorkOnce({ store: createMemoryStore(), scope: 'drain-boundary' }).define(
    'job',
    {
      limits: { leaseMs: 5000 },
    },
  );
  await queue.ensure('bad', { key: 'a' });
  await queue.ensure('healthy', { key: 'b' });
  const entered = deferred(),
    release = deferred(),
    stop = new AbortController();
  let finished = false,
    ended = false,
    timedOut = false;
  const handler = async (run, input) => {
    if (input === 'bad') throw error;
    entered.resolve();
    await within(release.promise, 'runtime-boundary release');
    finished = true;
    return run.succeed();
  };
  const options = {
    workerId: mode,
    concurrency: 2,
    heartbeatMs: 100,
    idleMs: 10000,
    signal: stop.signal,
  };
  const service = queue.serveExternal({
    prepare: (r) => r.handoff(r.input),
    onPrepareError: (r) => r.fail('prepare'),
  });
  const watchdog = setTimeout(() => {
    timedOut = true;
    stop.abort();
    release.resolve();
    entered.resolve();
  }, 1000);
  const running = observe(
    mode === 'local' ? queue.run(options, handler) : runExternal(service, options, handler),
  ).then((result) => {
    ended = true;
    return result;
  });
  await within(entered.promise, 'runtime-boundary entry');
  await nextTurn();
  const rejectedBeforeDrain = ended;
  release.resolve();
  const result = await running;
  clearTimeout(watchdog);
  stop.abort();
  return {
    kind: 'runner',
    mode,
    site: 'drain',
    errorKind: error === undefined ? 'undefined' : 'defined',
    failureValue: runnerFailureValue(error),
    returnedValue: result.rejected ? runnerFailureValue(result.error) : 'none',
    handled: false,
    rejected: result.rejected,
    preserved: result.error === error,
    drained:
      finished && !rejectedBeforeDrain && (await queue.inspect('b')).phase.state === 'succeeded',
    timedOut,
  };
}

async function admissionSample(mode, error) {
  const base = createMemoryStore();
  const entered = deferred(),
    release = deferred(),
    stop = new AbortController();
  let queries = 0,
    timedOut = false;
  const started = [];
  const store = {
    ...base,
    async query(query) {
      queries++;
      if (queries === 2) {
        entered.resolve();
        await within(release.promise, 'runtime-boundary release');
      }
      const result = await base.query(query);
      return { ...result, rows: result.rows.slice(0, 1) };
    },
  };
  const queue = createWorkOnce({ store, scope: 'admission-boundary' }).define('job', {
    limits: { leaseMs: 5000 },
  });
  await queue.ensure('a', { key: 'a' });
  await queue.ensure('b', { key: 'b' });
  const service = queue.serveExternal({
    prepare: (run) => run.handoff(run.input),
    onPrepareError: (run) => run.fail('prepare'),
  });
  const handler = async (run, input) => {
    started.push(input);
    if (input === 'a') {
      await within(entered.promise, 'runtime-boundary entry');
      throw error;
    }
    stop.abort();
    return run.succeed();
  };
  const options = {
    workerId: mode,
    concurrency: 2,
    heartbeatMs: 100,
    idleMs: 10000,
    signal: stop.signal,
  };
  const watchdog = setTimeout(() => {
    timedOut = true;
    stop.abort();
    entered.resolve();
    release.resolve();
  }, 1000);
  const running = observe(
    mode === 'local' ? queue.run(options, handler) : runExternal(service, options, handler),
  );
  await within(entered.promise, 'runtime-boundary entry');
  await nextTurn();
  release.resolve();
  const result = await running;
  clearTimeout(watchdog);
  stop.abort();
  return {
    kind: 'runner',
    mode,
    site: 'claimGate',
    errorKind: error === undefined ? 'undefined' : 'defined',
    failureValue: runnerFailureValue(error),
    returnedValue: result.rejected ? runnerFailureValue(result.error) : 'none',
    handled: false,
    rejected: result.rejected,
    preserved: result.error === error,
    drained: started.includes('a'),
    started: started.length,
    timedOut,
  };
}

async function abortClaimReplySample() {
  let now = 100;
  const base = createMemoryStore({ now: () => now });
  const entered = deferred();
  const release = deferred();
  let firstDueQuery = true;
  const store = {
    ...base,
    async query(query) {
      if (query.select === 'due' && firstDueQuery) {
        firstDueQuery = false;
        entered.resolve();
        await within(release.promise, 'runtime-boundary release');
      }
      return base.query(query);
    },
  };
  const queue = createWorkOnce({ store, scope: 'runner-abort-claim-reply' }).define('job', {
    limits: { leaseMs: 10, maxAttempts: 3 },
  });
  await queue.ensure(null, { key: 'job' });
  const stop = new AbortController();
  let started = 0;
  const running = observe(
    queue.run(
      { workerId: 'stopping', concurrency: 1, idleMs: 1000, signal: stop.signal },
      async (run) => {
        started++;
        return run.succeed();
      },
    ),
  );
  await within(entered.promise, 'runtime-boundary entry');
  stop.abort();
  release.resolve();
  const result = await within(running, 'abort-claim-reply runner exit');
  const stranded = await queue.inspect('job');
  now = 111;
  const [reclaimed] = await queue.runAvailable({ workerId: 'reclaimer' }, async (run) =>
    run.succeed(),
  );
  return {
    kind: 'runner',
    mode: 'local',
    site: 'abortClaimReply',
    errorKind: 'defined',
    failureValue: 'none',
    returnedValue: 'none',
    handled: true,
    rejected: result.rejected,
    preserved: !result.rejected,
    drained: started === 0 && !result.rejected,
    started,
    reclaimed:
      stranded.phase.state === 'running' &&
      reclaimed?.status === 'settled' &&
      (await queue.inspect('job')).phase.state === 'succeeded',
    timedOut: false,
  };
}

async function abortActiveSample() {
  let now = 100;
  const base = createMemoryStore({ now: () => now });
  const queue = createWorkOnce({ store: base, scope: 'runner-abort-active' }).define('job', {
    limits: { leaseMs: 1000, maxAttempts: 3 },
  });
  await queue.ensure(null, { key: 'job' });
  const entered = deferred();
  const release = deferred();
  const stop = new AbortController();
  let handlerFinished = false;
  let runSignalAborted = false;
  const running = observe(
    queue.run(
      {
        workerId: 'stopping',
        concurrency: 1,
        heartbeatMs: 500,
        idleMs: 1000,
        signal: stop.signal,
      },
      async (run) => {
        entered.resolve();
        await within(release.promise, 'runtime-boundary release');
        runSignalAborted = run.signal.aborted;
        handlerFinished = true;
        return run.succeed();
      },
    ),
  );
  await within(entered.promise, 'runtime-boundary entry');
  stop.abort();
  release.resolve();
  const result = await within(running, 'abort-active runner exit');
  const stranded = await queue.inspect('job');
  now = 1101;
  const [reclaimed] = await queue.runAvailable({ workerId: 'reclaimer' }, async (run) =>
    run.succeed(),
  );
  return {
    kind: 'runner',
    mode: 'local',
    site: 'abortActive',
    errorKind: 'defined',
    failureValue: 'none',
    returnedValue: 'none',
    handled: true,
    rejected: result.rejected,
    preserved: !result.rejected,
    drained: handlerFinished,
    runSignalAborted,
    reclaimed:
      stranded.phase.state === 'running' &&
      reclaimed?.status === 'settled' &&
      (await queue.inspect('job')).phase.state === 'succeeded',
    timedOut: false,
  };
}

async function localHistoryCongruenceSample(pair, firstSite, secondSite, errorValue) {
  const error = new Error(errorValue === 'errorB' ? 'history B' : 'history A');
  const first = await runnerSample('local', firstSite, error, errorValue);
  const second = await runnerSample('local', secondSite, error, errorValue);
  return {
    kind: 'runnerHistory',
    mode: 'local',
    pair,
    failureValue: errorValue,
    bothRejected: first.rejected && second.rejected,
    exactIdentityPreserved: first.preserved && second.preserved,
    sameTerminalProjection:
      first.rejected === second.rejected &&
      first.drained === second.drained &&
      first.timedOut === second.timedOut,
    sameReturnedValue: first.returnedValue === second.returnedValue,
  };
}

export async function runRuntimeBoundarySamples() {
  const samples = [];
  const fatalCases = [
    [undefined, 'undefined'],
    [null, 'null'],
    [0, 'zero'],
    ['', 'empty'],
    [new Error('original failure A'), 'errorA'],
    [new Error('original failure B'), 'errorB'],
  ];
  const handledCases = [
    [undefined, 'undefined'],
    [new Error('original failure A'), 'errorA'],
    [new Error('original failure B'), 'errorB'],
  ];
  for (const mode of ['local', 'external']) {
    samples.push(await firstFatalSample(mode));
    for (const [error, errorValue] of fatalCases)
      for (const site of ['claim', 'claimObserver', 'active', 'activeObserver'])
        samples.push(await runnerSample(mode, site, error, errorValue));
    for (const [error, errorValue] of handledCases) {
      for (const site of ['handledClaim', 'handledActive', 'backoffBefore', 'backoffDuring'])
        samples.push(await runnerSample(mode, site, error, errorValue));
      samples.push(await drainSample(mode, error));
      samples.push(await admissionSample(mode, error));
    }
  }
  samples.push(await abortClaimReplySample());
  samples.push(await abortActiveSample());
  samples.push(
    await localHistoryCongruenceSample('claim-observer', 'claim', 'claimObserver', 'errorA'),
  );
  samples.push(
    await localHistoryCongruenceSample('active-observer', 'active', 'activeObserver', 'errorB'),
  );
  for (const phase of auditPhases) {
    const store = createMemoryStore({ now: () => 100 });
    const { queue, snapshot } = await seedAuditPhase(store, 'read-boundary', phase);
    const newer = createWorkOnce({ store, scope: 'read-boundary' }).define('job', { version: '2' });
    for (const matched of [true, false]) {
      const reader = matched ? queue : newer;
      for (const method of ['inspect', 'inspectMany', 'item', 'inspectId', 'history']) {
        const result = await observe(
          method === 'item'
            ? reader.item(null, 'job').inspect()
            : method === 'inspectMany'
              ? reader.inspectMany(['missing', 'job', 'job'])
              : method === 'inspectId'
                ? reader.inspectId(snapshot.id)
                : reader[method]('job'),
        );
        let snapshotExact = false;
        if (matched) {
          assert.equal(result.rejected, false);
          if (method === 'inspectMany') {
            assert.deepEqual(result.value, [undefined, snapshot, snapshot]);
            snapshotExact = true;
          } else if (method === 'history') {
            const stored = await store.getMany([snapshot.id]);
            const expectedHistory = stored.rows[0]?.history;
            assert.deepEqual(result.value, expectedHistory);
            snapshotExact = true;
          } else {
            assert.deepEqual(result.value, snapshot);
            snapshotExact = true;
          }
        }
        samples.push({
          kind: 'read',
          phase,
          method,
          matched,
          accepted: !result.rejected,
          snapshotExact,
          errorCause: result.rejected ? (result.error?.code ?? 'other') : 'none',
          definitionError: result.error?.code === 'definition_changed',
        });
      }
    }
  }
  const readAdapterSamples = await runTypedReadBoundarySamples();
  assertTypedReadBoundarySamples(readAdapterSamples);
  samples.push(...readAdapterSamples);
  for (const initial of [0, 1, 8])
    for (const factor of [1, 2])
      for (const retries of [0, 1, 4, 1023, 1024, Number.MAX_SAFE_INTEGER]) {
        const result = exponentialBackoff({
          initialDelayMs: initial,
          multiplier: factor,
          maxDelayMs: 64,
          maxRetries: Number.MAX_SAFE_INTEGER,
        })({ retries });
        samples.push({
          kind: 'backoff',
          initial,
          factor,
          steps: Math.min(retries, 7),
          delay: result.afterMs,
        });
      }
  for (const attemptsExhausted of [false, true])
    for (const elapsedExhausted of [false, true])
      for (const deferralsExhausted of [false, true])
        for (const delay of [0, 1, 2]) {
          let now = 0;
          const queue = createWorkOnce({
            store: createMemoryStore({ now: () => now }),
            scope: 'budget-boundary',
          }).define('job', {
            limits: {
              leaseMs: 20,
              maxAttempts: attemptsExhausted ? 2 : 4,
              maxElapsedMs: elapsedExhausted ? 2 : 10,
              maxDeferrals: deferralsExhausted ? 1 : 3,
            },
          });
          await queue.ensure(null, { key: 'job' });
          let [run] = await queue.claim({ workerId: 'a' });
          await run.settle(run.wait('pending', { afterMs: 0 }));
          now = 1;
          [run] = await queue.claim({ workerId: 'b' });
          const phase = await run.settle(run.wait('pending', { afterMs: delay }));
          samples.push({
            kind: 'budget',
            attemptsExhausted,
            deadlineExhausted: elapsedExhausted && delay >= 1,
            deferralsExhausted,
            stop: phase.state === 'waiting' ? 'none' : phase.stoppedBy,
            reasonPreserved: phase.reason === 'pending',
          });
        }
  for (const first of ['cancel', 'complete']) {
    const queue = createWorkOnce({ store: createMemoryStore(), scope: 'cancel-boundary' }).define(
      'job',
    );
    await queue.ensure(null, { key: 'job' });
    const [run] = await queue.claim({ workerId: 'a' });
    let cancelled, completed;
    if (first === 'cancel') {
      cancelled = await observe(queue.cancel({ key: 'job', generation: 1 }));
      completed = await observe(run.settle(run.succeed()));
    } else {
      completed = await observe(run.settle(run.succeed()));
      cancelled = await observe(queue.cancel({ key: 'job', generation: 1 }));
    }
    samples.push({
      kind: 'cancel',
      first,
      state: (await queue.inspect('job')).phase.state,
      cancelRejected: cancelled.rejected,
      completionRejected: completed.rejected,
      cancelState: cancelled.value?.phase.state ?? 'rejected',
    });
  }
  return samples;
}

export function assertRuntimeBoundarySamples(samples) {
  for (const s of samples) {
    const name = JSON.stringify(s);
    if (s.kind === 'runner') {
      assert.equal(s.rejected, !s.handled, name);
      assert.equal(s.returnedValue, s.failureValue, name);
      assert.ok(s.preserved && s.drained && !s.timedOut, name);
      if (s.site === 'claimGate') assert.equal(s.started, 1, name);
      if (s.site === 'abortClaimReply') {
        assert.equal(s.started, 0, name);
        assert.equal(s.reclaimed, true, name);
      }
      if (s.site === 'abortActive') {
        assert.equal(s.runSignalAborted, true, name);
        assert.equal(s.reclaimed, true, name);
      }
    } else if (s.kind === 'runnerHistory') {
      assert.ok(
        s.bothRejected &&
          s.exactIdentityPreserved &&
          s.sameTerminalProjection &&
          s.sameReturnedValue,
        name,
      );
    } else if (s.kind === 'read') {
      assert.equal(s.accepted, s.matched, name);
      if (s.matched) {
        assert.equal(s.snapshotExact, true, name);
        assert.equal(s.errorCause, 'none', name);
      } else {
        assert.equal(s.definitionError, true, name);
        assert.equal(s.errorCause, 'definition_changed', name);
      }
    } else if (s.kind === 'readAdapter') {
      for (const field of typedReadAdapterEvidenceFields)
        assert.equal(s[field], true, `${name} missing or false: ${field}`);
    } else if (s.kind === 'backoff') {
      assert.equal(s.delay, Math.min(64, s.initial * s.factor ** s.steps), name);
    } else if (s.kind === 'budget') {
      const expected = s.attemptsExhausted
        ? 'attempt_budget_exhausted'
        : s.deadlineExhausted
          ? 'deadline_exceeded'
          : s.deferralsExhausted
            ? 'deferral_budget_exhausted'
            : 'none';
      assert.equal(s.stop, expected, name);
      assert.ok(s.reasonPreserved, name);
    } else if (s.kind === 'cancel') {
      assert.equal(s.cancelRejected, false, name);
      assert.equal(s.state, s.first === 'cancel' ? 'cancelled' : 'succeeded', name);
      assert.equal(s.cancelState, s.state, name);
      assert.equal(s.completionRejected, s.first === 'cancel', name);
    } else assert.fail(`Unmapped boundary sample: ${name}`);
  }
  assert.deepEqual([...new Set(samples.map((s) => s.kind))].sort(), [
    'backoff',
    'budget',
    'cancel',
    'read',
    'readAdapter',
    'runner',
    'runnerHistory',
  ]);
  return samples.length;
}
