import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkOnce, defer, exponentialBackoff, retry, wait } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';

test('outcome helpers keep authoritative discriminants and reasons ahead of timing extras', () => {
  const timing = { afterMs: 7, type: 'succeed', reason: 'hijacked' };
  assert.deepEqual(retry('busy', timing), { afterMs: 7, type: 'retry', reason: 'busy' });
  assert.deepEqual(wait('pending', timing), { afterMs: 7, type: 'defer', reason: 'pending' });
  assert.deepEqual(defer('pending', timing), { afterMs: 7, type: 'defer', reason: 'pending' });
});

test('WorkItem keeps its bound key even when runtime option objects contain another key', async () => {
  let now = 1000;
  const work = createWorkOnce({
    store: createMemoryStore({ now: () => now }),
    scope: 'item-key-authority',
  });

  const cancelQueue = work.define('cancel');
  await cancelQueue.ensure(null, { key: 'a' });
  await cancelQueue.ensure(null, { key: 'b' });
  await cancelQueue.item(null, 'a').cancel({ key: 'b', reason: 'owner-cancel' });
  assert.equal((await cancelQueue.inspect('a')).phase.state, 'cancelled');
  assert.equal((await cancelQueue.inspect('b')).phase.state, 'queued');

  const restartQueue = work.define('restart');
  await restartQueue.ensure(null, { key: 'a' });
  await restartQueue.ensure(null, { key: 'b' });
  for (const run of await restartQueue.claim({ workerId: 'finish', limit: 2 }))
    await run.settle(run.succeed());
  await restartQueue.item(null, 'a').restart({ key: 'b', expectedGeneration: 1 });
  assert.equal((await restartQueue.inspect('a')).generation, 2);
  assert.equal((await restartQueue.inspect('b')).generation, 1);

  const wakeQueue = work.define('wake', { wait: { afterMs: 100 } });
  await wakeQueue.ensure(null, { key: 'a' });
  await wakeQueue.ensure(null, { key: 'b' });
  for (const run of await wakeQueue.claim({ workerId: 'wait', limit: 2 }))
    await run.settle(run.wait('pending'));
  await wakeQueue.item(null, 'a').wake({ key: 'b', expectedGeneration: 1 });
  assert.equal((await wakeQueue.inspect('a')).phase.availableAt, now);
  assert.equal((await wakeQueue.inspect('b')).phase.availableAt, now + 100);
});

test('readable API names map to the same hardened lifecycle semantics', async () => {
  let now = 1000;
  const work = createWorkOnce({ store: createMemoryStore({ now: () => now }), scope: 'readable' });
  const follow = work.define('follow', { key: (input) => input.id });
  const backoff = exponentialBackoff({
    initialDelayMs: 5,
    maxDelayMs: 20,
    maxRetries: 3,
    manualRetry: true,
  });
  const job = work.define('job', {
    key: (input) => input.id,
    executionLimits: { leaseMs: 50, maxElapsedMs: 500, maxAttempts: 8 },
    wait: ({ deferrals }) => ({ afterMs: deferrals + 1 }),
    retry: (context) =>
      context.reason === 'temporary' ? backoff(context) : { retry: false, manualRetry: false },
    thenDo: ({ result }) => [follow.request({ id: `follow:${result}` })],
  });

  const item = job.item({ id: 'x' });
  await item.ensure();
  let [run] = await job.claim({ workerId: 'A' });
  assert.equal((await run.settle(run.wait('dependency_pending'))).state, 'waiting');
  now += 1;
  [run] = await job.claim({ workerId: 'B' });
  assert.equal((await run.settle(run.retry('temporary'))).state, 'waiting');
  now += 5;
  [run] = await job.claim({ workerId: 'C' });
  await run.settle(run.succeed('done'));
  assert.equal((await item.inspect()).pendingFollowups, 1);
  assert.equal(await work.dispatch(), 1);
  assert.ok(await follow.item({ id: 'follow:done' }).inspect());
  const rerun = await item.rerun();
  assert.equal(rerun.generation, 2);
});

test('readable aliases reject ambiguous duplicate configuration', async () => {
  const work = createWorkOnce({ store: createMemoryStore(), scope: 'readable-conflict' });
  const badLimits = work.define('bad-limits', {
    executionLimits: { maxAttempts: 2 },
    limits: { maxAttempts: 3 },
  });
  await assert.rejects(badLimits.ensure(null, { key: 'x' }), /executionLimits or limits/);

  const badWait = work.define('bad-wait', { wait: { afterMs: 1 }, defer: { afterMs: 2 } });
  await badWait.ensure(null, { key: 'x' });
  const [run] = await badWait.claim({ workerId: 'A' });
  await assert.rejects(run.settle(run.wait('pending')), /wait or defer/);
});

test('exponentialBackoff grows deterministically and caps the delay', () => {
  const policy = exponentialBackoff({
    initialDelayMs: 10,
    maxDelayMs: 25,
    multiplier: 2,
    maxRetries: 4,
    manualRetry: false,
  });
  assert.deepEqual(policy({ retries: 0 }), {
    retry: true,
    afterMs: 10,
    maxRetries: 4,
    manualRetry: false,
  });
  assert.equal(policy({ retries: 1 }).afterMs, 20);
  assert.equal(policy({ retries: 2 }).afterMs, 25);
  assert.equal(policy({ retries: 100 }).afterMs, 25);
});

test('a definition can bind its canonical perform handler once and still allow an explicit override', async () => {
  const work = createWorkOnce({ store: createMemoryStore(), scope: 'bound-perform' });
  let defaultCalls = 0;
  let overrideCalls = 0;
  const queue = work.define('job', {
    key: (input) => input.id,
    perform: async (run, input) => {
      defaultCalls++;
      return run.succeed(`default:${input.id}`);
    },
  });
  await queue.ensure({ id: 'a' });
  await queue.runAvailable({ workerId: 'local' });
  assert.equal(defaultCalls, 1);
  assert.equal((await queue.item({ id: 'a' }).inspect()).phase.result, 'default:a');

  await queue.ensure({ id: 'b' });
  await queue.runAvailable({ workerId: 'override' }, async (run, input) => {
    overrideCalls++;
    return run.succeed(`override:${input.id}`);
  });
  assert.equal(defaultCalls, 1);
  assert.equal(overrideCalls, 1);
  assert.equal((await queue.item({ id: 'b' }).inspect()).phase.result, 'override:b');
});

test('worker APIs reject their Promise before claiming when no perform handler exists', async () => {
  const work = createWorkOnce({ store: createMemoryStore(), scope: 'missing-perform' });
  const queue = work.define('job');
  await queue.ensure(null, { key: 'a' });
  await assert.rejects(queue.runAvailable({ workerId: 'local' }), /no perform handler/);
  await assert.rejects(queue.process({ workerId: 'local' }), /no perform handler/);
  const stop = new AbortController();
  await assert.rejects(queue.run({ workerId: 'local', signal: stop.signal }), /no perform handler/);
  assert.equal((await queue.inspect('a')).phase.state, 'queued');
});

test('enqueue/process remain exact compatibility aliases for ensure/runAvailable', async () => {
  const work = createWorkOnce({ store: createMemoryStore(), scope: 'readable-compat' });
  const queue = work.define('job', {
    key: (input) => input.id,
    perform: async (run, input) => run.succeed(input.id),
  });
  const viaEnqueue = await queue.enqueue({ id: 'x' });
  const viaEnsure = await queue.ensure({ id: 'x' });
  assert.equal(viaEnqueue.id, viaEnsure.id);
  const results = await queue.process({ workerId: 'compat' });
  assert.equal(results[0]?.status, 'settled');
  assert.equal((await queue.item({ id: 'x' }).inspect()).phase.result, 'x');
});
