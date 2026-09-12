import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';

test('external handoff settles waits and only returns finally-renewed ready payloads', async () => {
  const work = createWorkOnce({ store: createMemoryStore(), scope: 't' });
  const q = work.define('external');
  await q.enqueue({ id: 1, ready: false }, { key: '1' });
  await q.enqueue({ id: 2, ready: true }, { key: '2' });
  const leased = await q.handoff(
    { workerId: 'foreign', limit: 2 },
    (run) =>
      run.input.ready ? run.handoff({ id: run.input.id }) : run.defer('not_ready', { afterMs: 10 }),
    (run) => run.retry('prepare_failed', { afterMs: 10 }),
  );
  assert.deepEqual(
    leased.map((item) => item.input),
    [{ id: 2 }],
  );
  assert.equal(leased[0].attempt.fence, 1);
  assert.ok(leased[0].leaseUntil > leased[0].observedAt);
  assert.equal((await q.inspect('1')).phase.state, 'waiting');
});

test('one preparation error is converted without discarding a healthy neighboring handoff', async () => {
  const q = createWorkOnce({ store: createMemoryStore(), scope: 't' }).define('external', {
    retry: { retry: true, afterMs: 10, maxRetries: 2, manualRetry: true },
  });
  await q.enqueue({ id: 1 }, { key: '1' });
  await q.enqueue({ id: 2 }, { key: '2' });
  const leased = await q.handoff(
    { workerId: 'foreign', limit: 2 },
    (run) => {
      if (run.input.id === 1) throw new Error('domain read failed');
      return run.handoff({ id: run.input.id });
    },
    (run) => run.retry('prepare_failed'),
  );
  assert.deepEqual(
    leased.map((item) => item.input),
    [{ id: 2 }],
  );
  assert.equal((await q.inspect('1')).phase.state, 'waiting');
});
