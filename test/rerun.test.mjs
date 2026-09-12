import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';

test('explicit rerun starts a new fenced generation without weakening enqueue dedupe', async () => {
  const work = createWorkOnce({ store: createMemoryStore(), scope: 't' });
  const q = work.define('render');
  await q.enqueue({ id: 'a' }, { key: 'a' });
  const [first] = await q.claim({ workerId: 'A' });
  await first.settle(first.succeed({ revision: 1 }));
  assert.equal((await q.enqueue({ id: 'a' }, { key: 'a' })).phase.state, 'succeeded');
  const rerun = await q.rerun({ key: 'a', generation: 1 });
  assert.equal(rerun.generation, 2);
  assert.equal(rerun.phase.state, 'queued');
  const [second] = await q.claim({ workerId: 'B' });
  assert.ok(second.ref.fence > first.ref.fence);
  await assert.rejects(
    first.settle(first.succeed({ revision: 1 })),
    (error) => error.code === 'stale_attempt',
  );
});

test('rerun waits for prior success follow-ups to dispatch', async () => {
  const work = createWorkOnce({ store: createMemoryStore(), scope: 't' });
  const apply = work.define('apply');
  const q = work.define('render');
  await q.enqueue(null, { key: 'a' });
  const [run] = await q.claim({ workerId: 'A' });
  await run.settle(run.succeed(null, { next: [apply.request(null, { key: 'apply-a' })] }));
  await assert.rejects(
    q.rerun({ key: 'a', generation: 1 }),
    (error) => error.code === 'retry_denied',
  );
  assert.equal((await q.inspect('a')).pendingFollowups, 1);
  assert.equal(await work.dispatch(), 1);
  assert.ok(await apply.inspect('apply-a'));
  const rerun = await q.rerun({ key: 'a', generation: 1 });
  assert.equal(rerun.generation, 2);
  assert.equal(rerun.pendingFollowups, 0);
});

test('rerun is explicit: unfinished and failed generations do not masquerade as completed work', async () => {
  const q = createWorkOnce({ store: createMemoryStore(), scope: 't' }).define('render');
  await q.enqueue(null, { key: 'a' });
  await assert.rejects(
    q.rerun({ key: 'a', generation: 1 }),
    (error) => error.code === 'retry_denied',
  );
  const [run] = await q.claim({ workerId: 'A' });
  await run.settle(run.fail('bad', { manualRetry: true }));
  await assert.rejects(
    q.rerun({ key: 'a', generation: 1 }),
    (error) => error.code === 'retry_denied',
  );
});
