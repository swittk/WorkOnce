import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';

test('typed failure keeps its diagnostic and atomically records durable follow-up intent', async () => {
  const work = createWorkOnce({ store: createMemoryStore(), scope: 't' });
  const apply = work.define('apply');
  const task = work.define('task');
  await task.enqueue({ id: 'x' }, { key: 'x' });
  const [run] = await task.claim({ workerId: 'A' });
  const phase = await run.settle(
    run.fail('invalid', {
      manualRetry: true,
      result: { detail: 'safe diagnostic' },
      next: [apply.request({ parent: 'x' }, { key: 'apply-x' })],
    }),
  );
  assert.equal(phase.state, 'failed');
  assert.equal(phase.reason, 'invalid');
  assert.deepEqual(phase.result, { detail: 'safe diagnostic' });
  assert.equal((await task.inspect('x')).pendingFollowups, 1);
  await work.dispatch();
  assert.ok(await apply.inspect('apply-x'));
});

test('manual retry waits for prior failure follow-ups to dispatch', async () => {
  const work = createWorkOnce({ store: createMemoryStore(), scope: 't' });
  const apply = work.define('apply');
  const task = work.define('task');
  await task.enqueue(null, { key: 'x' });
  const [run] = await task.claim({ workerId: 'A' });
  await run.settle(
    run.fail('fix', { manualRetry: true, next: [apply.request(null, { key: 'old' })] }),
  );
  await assert.rejects(
    task.retry({ key: 'x', generation: 1 }),
    (error) => error.code === 'retry_denied',
  );
  assert.equal((await task.inspect('x')).pendingFollowups, 1);
  assert.equal(await work.dispatch(), 1);
  assert.ok(await apply.inspect('old'));
  const retried = await task.retry({ key: 'x', generation: 1 });
  assert.equal(retried.generation, 2);
  assert.equal(retried.pendingFollowups, 0);
});
