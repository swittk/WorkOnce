import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';

test('process starts jobs in parallel and automatic renewal keeps long jobs owned', async () => {
  const q = createWorkOnce({ store: createMemoryStore(), scope: 't' }).define('work', {
    limits: { leaseMs: 300 },
  });
  for (let i = 0; i < 4; i++) await q.enqueue({ i }, { key: String(i) });
  let active = 0,
    peak = 0;
  const results = await q.process(
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
  await q.enqueue(null, { key: 'job' });
  let handlerCalls = 0;
  const [result] = await q.process({ workerId: 'worker', heartbeatMs: 20 }, async (run) => {
    handlerCalls++;
    return run.succeed();
  });
  assert.equal(handlerCalls, 1);
  assert.equal(result.status, 'settled');
});

test('one bad handler does not discard its healthy neighbor', async () => {
  const q = createWorkOnce({ store: createMemoryStore(), scope: 't' }).define('work');
  await q.enqueue({ bad: true }, { key: 'a' });
  await q.enqueue({ bad: false }, { key: 'b' });
  const results = await q.process({ workerId: 'worker', concurrency: 2 }, async (run, input) => {
    if (input.bad) throw new Error('handler bug');
    return run.succeed();
  });
  assert.equal(results.filter((r) => r.status === 'interrupted').length, 1);
  assert.equal(results.filter((r) => r.status === 'settled').length, 1);
});
test('the managed runner refills free capacity without waiting for the slowest job', async () => {
  const q = createWorkOnce({ store: createMemoryStore(), scope: 't' }).define('work');
  for (let i = 0; i < 5; i++) await q.enqueue({ i }, { key: String(i) });
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
  await q.enqueue(null, { key: 'job' });
  let abortedInHandler = false;
  const results = await q.process({ workerId: 'worker', heartbeatMs: 20 }, async (run) => {
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

test('invalid static heartbeat configuration fails before local work is claimed', async () => {
  const q = createWorkOnce({ store: createMemoryStore(), scope: 'heartbeat-config' }).define(
    'work',
  );
  await q.enqueue(null, { key: 'process' });
  await assert.rejects(
    q.process({ workerId: 'worker', heartbeatMs: 0 }, async (run) => run.succeed()),
    /heartbeatMs/,
  );
  assert.equal((await q.inspect('process')).phase.state, 'queued');
  assert.equal((await q.inspect('process')).attempts, 0);

  await q.enqueue(null, { key: 'run' });
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
