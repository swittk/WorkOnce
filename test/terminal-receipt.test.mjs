import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';

test('terminal results are not duplicated inside the settlement receipt', async () => {
  const store = createMemoryStore();
  const q = createWorkOnce({ store, scope: 't' }).define('large');
  await q.enqueue(null, { key: 'x' });
  const [run] = await q.claim({ workerId: 'A' });
  const payload = { data: 'x'.repeat(100_000) };
  const outcome = run.succeed(payload);
  const first = await run.settle(outcome);
  assert.deepEqual(await run.settle(outcome), first);
  const { rows } = await store.getMany([run.ref.workId]);
  assert.equal(rows[0].receipt.phase, undefined);
  assert.match(rows[0].receipt.submissionHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(rows[0].receipt).includes(payload.data.slice(0, 1000)), false);
  assert.deepEqual(rows[0].phase.result, payload);
});

test('non-terminal receipts retain their old waiting acknowledgement after reclaim', async () => {
  let now = 1000;
  const store = createMemoryStore({ now: () => now });
  const q = createWorkOnce({ store, scope: 't' }).define('wait', {
    limits: { leaseMs: 10 },
    retry: { retry: true, afterMs: 1, maxRetries: 2, manualRetry: true },
  });
  await q.enqueue(null, { key: 'x' });
  const [first] = await q.claim({ workerId: 'A' });
  const outcome = first.retry('busy');
  const waiting = await first.settle(outcome);
  now += 1;
  const [second] = await q.claim({ workerId: 'B' });
  assert.equal(second.attempt.fence, first.attempt.fence + 1);
  assert.deepEqual(await first.settle(outcome), waiting);
  const live = await q.inspect('x');
  assert.equal(live.phase.state, 'running');
  assert.equal(live.phase.attempt.fence, second.attempt.fence);
});
