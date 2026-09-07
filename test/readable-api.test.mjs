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
