import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';

test('definition key and item handle remove repeated key/generation plumbing', async () => {
  const q = createWorkOnce({ store: createMemoryStore(), scope: 't' }).define('job', {
    key: (input) => input.id,
  });
  const item = q.item({ id: 'a', value: 1 });
  await item.enqueue();
  const [run] = await q.claim({ workerId: 'A' });
  await run.settle(run.fail('fix', { manualRetry: true }));
  assert.equal((await item.restart()).generation, 2);
  const [second] = await q.claim({ workerId: 'B' });
  await second.settle(second.succeed());
  assert.equal((await item.restart()).generation, 3);
});

test('cancelCurrent returns the revoked running attempt and keeps expected-generation guard optional', async () => {
  const q = createWorkOnce({ store: createMemoryStore(), scope: 't' }).define('job', {
    key: (input) => input.id,
  });
  const item = q.item({ id: 'a' });
  await item.enqueue();
  const [run] = await q.claim({ workerId: 'A' });
  const cancelled = await item.cancel({ reason: 'staff' });
  assert.deepEqual(cancelled.activeAttempt, run.ref);
  assert.equal(cancelled.snapshot.phase.state, 'cancelled');
});

test('wakeCurrent uses the current revision internally for trusted domain events', async () => {
  const q = createWorkOnce({ store: createMemoryStore(), scope: 't' }).define('job', {
    key: (input) => input.id,
  });
  const item = q.item({ id: 'a' });
  await item.enqueue({ availableAt: 9999999999999 });
  assert.equal((await item.wake()).phase.state, 'queued');
  assert.equal((await q.claim({ workerId: 'A' })).length, 1);
});

test('one request evaluates a dynamic work key exactly once', () => {
  let calls = 0;
  const q = createWorkOnce({ store: createMemoryStore(), scope: 't' }).define('job', {
    key: () => `key-${++calls}`,
  });
  const request = q.request(null);
  assert.equal(calls, 1);
  assert.equal(request.key, 'key-1');
  assert.equal(request.id, JSON.stringify(['t', 'job', 'key-1']));
});
