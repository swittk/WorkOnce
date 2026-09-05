import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
test('deadline exhaustion retains the actual waiting reason and explains why retry stopped', async () => {
  let now = 1000;
  const q = createWorkOnce({ store: createMemoryStore({ now: () => now }), scope: 't' }).define(
    'work',
    { limits: { maxElapsedMs: 30, leaseMs: 10 } },
  );
  await q.enqueue(null, { key: 'job' });
  const [run] = await q.claim({ workerId: 'worker-A' });
  await run.settle(run.defer('pending_cleanup', { afterMs: 20 }));
  now += 31;
  assert.equal((await q.claim({ workerId: 'worker-B' })).length, 0);
  const { phase } = await q.inspect('job');
  assert.equal(phase.reason, 'pending_cleanup');
  assert.equal(phase.stoppedBy, 'deadline_exceeded');
  const history = await q.history('job');
  assert.equal(history[1].workerId, 'worker-A');
  assert.equal(history.at(-1).reason, 'pending_cleanup');
});
test('claim JSON exposes only the remote-worker contract, not adapter or retry callbacks', async () => {
  const q = createWorkOnce({ store: createMemoryStore(), scope: 't' }).define('work');
  await q.enqueue({ assetId: 'id' }, { key: 'job' });
  const [run] = await q.claim({ workerId: 'A' });
  const wire = JSON.parse(JSON.stringify(run));
  assert.deepEqual(Object.keys(wire).sort(), ['attempt', 'input', 'observedAt']);
  assert.deepEqual(wire.attempt, run.attempt);
  assert.equal(wire.queue, undefined);
});
