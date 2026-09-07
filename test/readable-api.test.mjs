import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkOnce, exponentialBackoff } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';

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
  await item.enqueue();
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
  await assert.rejects(badLimits.enqueue(null, { key: 'x' }), /executionLimits or limits/);

  const badWait = work.define('bad-wait', { wait: { afterMs: 1 }, defer: { afterMs: 2 } });
  await badWait.enqueue(null, { key: 'x' });
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
  await queue.enqueue({ id: 'a' });
  await queue.process({ workerId: 'local' });
  assert.equal(defaultCalls, 1);
  assert.equal((await queue.item({ id: 'a' }).inspect()).phase.result, 'default:a');

  await queue.enqueue({ id: 'b' });
  await queue.process({ workerId: 'override' }, async (run, input) => {
    overrideCalls++;
    return run.succeed(`override:${input.id}`);
  });
  assert.equal(defaultCalls, 1);
  assert.equal(overrideCalls, 1);
  assert.equal((await queue.item({ id: 'b' }).inspect()).phase.result, 'override:b');
});

test('process and run fail before claiming when no bound or explicit perform handler exists', async () => {
  const work = createWorkOnce({ store: createMemoryStore(), scope: 'missing-perform' });
  const queue = work.define('job');
  await queue.enqueue(null, { key: 'a' });
  assert.throws(() => queue.process({ workerId: 'local' }), /no perform handler/);
  assert.equal((await queue.inspect('a')).phase.state, 'queued');
  const stop = new AbortController();
  assert.throws(() => queue.run({ workerId: 'local', signal: stop.signal }), /no perform handler/);
  assert.equal((await queue.inspect('a')).phase.state, 'queued');
});
