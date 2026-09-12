import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';

test('runAvailable starts jobs in parallel and automatic renewal keeps long jobs owned', async () => {
  const q = createWorkOnce({ store: createMemoryStore(), scope: 't' }).define('work', {
    limits: { leaseMs: 300 },
  });
  for (let i = 0; i < 4; i++) await q.ensure({ i }, { key: String(i) });
  let active = 0,
    peak = 0;
  const results = await q.runAvailable(
    { workerId: 'worker', concurrency: 4, heartbeatMs: 40 },
    async (run, input) => {
      active++;
      peak = Math.max(peak, active);
      await sleep(450);
      run.signal.throwIfAborted();
      active--;
      return run.succeed(input.i);
    },
  );
  assert.equal(peak, 4);
  assert.ok(results.every((x) => x.status === 'settled'));
  assert.equal((await q.inspect('0')).attempts, 1);
});
test('a one-millisecond lease does not fail solely because automatic heartbeat cannot fit', async () => {
  const q = createWorkOnce({
    store: createMemoryStore({ now: () => 100 }),
    scope: 'one-ms',
  }).define('work', {
    limits: { leaseMs: 1, maxAttempts: 2 },
  });
  await q.ensure(null, { key: 'job' });
  let handlerCalls = 0;
  const [result] = await q.runAvailable({ workerId: 'worker' }, async (run) => {
    handlerCalls++;
    return run.succeed();
  });
  if (result.status === 'interrupted') {
    assert.ok(result.error instanceof Error);
    assert.equal(result.error.message, 'Confirmed lease deadline passed');
  } else {
    assert.equal(result.status, 'settled');
    assert.equal(handlerCalls, 1);
  }
});

test('claim discovery latency is not charged to a lease granted afterward', async () => {
  const base = createMemoryStore();
  const store = {
    ...base,
    async query(query) {
      await sleep(120);
      return base.query(query);
    },
  };
  const q = createWorkOnce({ store, scope: 'claim-latency' }).define('work', {
    limits: { leaseMs: 80 },
  });
  await q.ensure(null, { key: 'job' });
  let handlerCalls = 0;
  const [result] = await q.runAvailable({ workerId: 'worker', heartbeatMs: 20 }, async (run) => {
    handlerCalls++;
    return run.succeed();
  });
  assert.equal(handlerCalls, 1);
  assert.equal(result.status, 'settled');
});

test('one bad handler does not discard its healthy neighbor', async () => {
  const q = createWorkOnce({ store: createMemoryStore(), scope: 't' }).define('work');
  await q.ensure({ bad: true }, { key: 'a' });
  await q.ensure({ bad: false }, { key: 'b' });
  const results = await q.runAvailable(
    { workerId: 'worker', concurrency: 2 },
    async (run, input) => {
      if (input.bad) throw new Error('handler bug');
      return run.succeed();
    },
  );
  assert.equal(results.filter((r) => r.status === 'interrupted').length, 1);
  assert.equal(results.filter((r) => r.status === 'settled').length, 1);
});
test('the managed runner refills free capacity without waiting for the slowest job', async () => {
  const q = createWorkOnce({ store: createMemoryStore(), scope: 't' }).define('work');
  for (let i = 0; i < 5; i++) await q.ensure({ i }, { key: String(i) });
  const controller = new AbortController();
  const starts = [];
  let finished = 0;
  await q.run(
    { workerId: 'worker', concurrency: 2, idleMs: 5, signal: controller.signal },
    async (run, input) => {
      starts.push(input.i);
      await sleep(input.i === 0 ? 120 : 10);
      finished++;
      if (finished === 5) setTimeout(() => controller.abort(), 20);
      return run.succeed();
    },
  );
  assert.deepEqual(starts, [0, 1, 2, 3, 4]);
});
test('loss of renewal aborts the local handler and cannot manufacture success', async () => {
  const base = createMemoryStore();
  let fail = false;
  const store = {
    ...base,
    async atomic(id, fn) {
      if (fail) throw new Error('storage down');
      return base.atomic(id, fn);
    },
  };
  const q = createWorkOnce({ store, scope: 't' }).define('work', { limits: { leaseMs: 500 } });
  await q.ensure(null, { key: 'job' });
  let abortedInHandler = false;
  const results = await q.runAvailable({ workerId: 'worker', heartbeatMs: 20 }, async (run) => {
    fail = true;
    await sleep(80);
    abortedInHandler = run.signal.aborted;
    return run.succeed();
  });
  fail = false;
  assert.equal(abortedInHandler, true);
  assert.equal(results[0].status, 'interrupted');
  assert.equal((await q.inspect('job')).phase.state, 'running');
});

test('a late heartbeat failure cannot replace an earlier caller cancellation cause', async () => {
  const base = createMemoryStore();
  let heartbeatReject;
  const heartbeatReply = new Promise((_, reject) => {
    heartbeatReject = reject;
  });
  let heartbeatStartedResolve;
  const heartbeatStarted = new Promise((resolve) => {
    heartbeatStartedResolve = resolve;
  });
  let interceptHeartbeat = false;
  const store = {
    ...base,
    atomic(id, decide) {
      if (interceptHeartbeat) {
        interceptHeartbeat = false;
        heartbeatStartedResolve();
        return heartbeatReply;
      }
      return base.atomic(id, decide);
    },
  };
  const q = createWorkOnce({ store, scope: 'first-stop-cause' }).define('work', {
    limits: { leaseMs: 500 },
  });
  await q.ensure(null, { key: 'job' });
  const stop = new AbortController();
  const callerStop = new Error('caller stopped first');
  const lateHeartbeatFailure = new Error('heartbeat failed later');
  let signalCause;
  const [result] = await q.runAvailable(
    { workerId: 'worker', heartbeatMs: 10, signal: stop.signal },
    async (run) => {
      interceptHeartbeat = true;
      await heartbeatStarted;
      stop.abort(callerStop);
      heartbeatReject(lateHeartbeatFailure);
      await new Promise((resolve) => setImmediate(resolve));
      signalCause = run.signal.reason;
      return run.succeed();
    },
  );
  assert.equal(signalCause, callerStop);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.error, callerStop);
  assert.equal((await q.inspect('job')).phase.state, 'running');
});

test('managed runner wakes an empty poll when an active claim becomes fatal', async () => {
  const base = createMemoryStore();
  const renewalFailure = new Error('renewal storage down');
  let failAtomic = false;
  const store = {
    ...base,
    async atomic(id, decide) {
      if (failAtomic) throw renewalFailure;
      return base.atomic(id, decide);
    },
  };
  const q = createWorkOnce({ store, scope: 'fatal-wake' }).define('work', {
    limits: { leaseMs: 500 },
  });
  await q.ensure(null, { key: 'job' });
  const stop = new AbortController();
  const startedAt = performance.now();
  await assert.rejects(
    q.run(
      { workerId: 'worker', concurrency: 2, heartbeatMs: 20, idleMs: 2000, signal: stop.signal },
      async (run) => {
        failAtomic = true;
        await sleep(80);
        return run.succeed();
      },
    ),
    (error) => error === renewalFailure,
  );
  assert.ok(performance.now() - startedAt < 500);
  stop.abort();
});

test('managed runner does not start claims returned after an active claim becomes fatal', async () => {
  const q = createWorkOnce({ store: createMemoryStore(), scope: 'fatal-claim-gate' }).define(
    'work',
    {
      key: (input) => input.id,
      limits: { leaseMs: 500 },
    },
  );
  await q.ensure({ id: 'a' });
  await q.ensure({ id: 'b' });
  const originalClaim = q.claim.bind(q);
  let claimCalls = 0;
  let releaseSecondClaim;
  const secondClaimGate = new Promise((resolve) => {
    releaseSecondClaim = resolve;
  });
  let staleSettleError;
  q.claim = async (options) => {
    claimCalls++;
    if (claimCalls === 1) {
      const claims = await originalClaim({ ...options, limit: 1 });
      const [claimed] = claims;
      if (claimed) {
        const settle = claimed.settle.bind(claimed);
        claimed.settle = async (outcome) => {
          try {
            return await settle(outcome);
          } catch (error) {
            if (error?.code === 'stale_attempt') staleSettleError = error;
            throw error;
          }
        };
      }
      return claims;
    }
    await secondClaimGate;
    return originalClaim({ ...options, limit: 1 });
  };
  let releaseHandler;
  const handlerGate = new Promise((resolve) => {
    releaseHandler = resolve;
  });
  const started = [];
  const stop = new AbortController();
  const running = q.run(
    { workerId: 'worker', concurrency: 2, heartbeatMs: 100, idleMs: 1000, signal: stop.signal },
    async (run, input) => {
      started.push(input.id);
      if (input.id === 'a') await handlerGate;
      return run.succeed();
    },
  );
  const secondClaimDeadline = performance.now() + 5000;
  while (started.length < 1 || claimCalls < 2) {
    assert.ok(performance.now() < secondClaimDeadline, 'runner did not reach the second claim');
    await sleep(1);
  }
  await q.cancelCurrent({ key: 'a', reason: 'revoked' });
  releaseHandler();
  const fatalDeadline = performance.now() + 5000;
  while (staleSettleError === undefined) {
    assert.ok(performance.now() < fatalDeadline, 'runner did not observe stale settlement');
    await sleep(1);
  }
  assert.equal(staleSettleError.code, 'stale_attempt');
  // Let processClaim publish the interrupted result and runWorker record the fatal before unblocking claim #2.
  await new Promise((resolve) => setImmediate(resolve));
  releaseSecondClaim();
  await assert.rejects(running, /stale_attempt/);
  assert.deepEqual(started, ['a']);
  assert.equal((await q.inspect('b')).phase.state, 'running');
  stop.abort();
});

test('invalid static heartbeat configuration fails before local work is claimed', async () => {
  const q = createWorkOnce({ store: createMemoryStore(), scope: 'heartbeat-config' }).define(
    'work',
  );
  await q.ensure(null, { key: 'run-available' });
  await assert.rejects(
    q.runAvailable({ workerId: 'worker', heartbeatMs: 0 }, async (run) => run.succeed()),
    /heartbeatMs/,
  );
  assert.equal((await q.inspect('run-available')).phase.state, 'queued');
  assert.equal((await q.inspect('run-available')).attempts, 0);

  await q.ensure(null, { key: 'run' });
  await assert.rejects(
    q.run(
      { workerId: 'worker', heartbeatMs: 1.5, signal: new AbortController().signal },
      async (run) => run.succeed(),
    ),
    /heartbeatMs/,
  );
  assert.equal((await q.inspect('run')).phase.state, 'queued');
  assert.equal((await q.inspect('run')).attempts, 0);
});
