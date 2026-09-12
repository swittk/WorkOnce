import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
test('async continuation planner sees typed input/result and is not rerun on identical ACK retry', async () => {
  const work = createWorkOnce({ store: createMemoryStore(), scope: 't' });
  const followup = work.define('notify');
  let calls = 0;
  const q = work.define('convert', {
    next: async ({ input, result, attempt }) => {
      calls++;
      return [
        followup.request(
          { to: input.to, asset: result.id },
          { key: JSON.stringify([attempt.workId, attempt.generation]) },
        ),
      ];
    },
  });
  await q.enqueue({ to: 'staff' }, { key: 'asset' });
  const [run] = await q.claim({ workerId: 'A' });
  const outcome = run.succeed({ id: 'result' });
  await run.settle(outcome);
  await run.settle(outcome);
  assert.equal(calls, 1);
  await work.dispatch();
  const [child] = await followup.claim({ workerId: 'B' });
  assert.deepEqual(child.input, { to: 'staff', asset: 'result' });
});
test(
  'cancel during an async continuation planner leaves no success or follow-up',
  { timeout: 5000 },
  async () => {
    const work = createWorkOnce({ store: createMemoryStore(), scope: 't' });
    const child = work.define('next');
    let release, enter;
    const entered = new Promise((r) => (enter = r)),
      gate = new Promise((r) => (release = r));
    const q = work.define('main', {
      next: async () => {
        enter();
        await gate;
        return [child.request(null, { key: 'child' })];
      },
    });
    await q.enqueue(null, { key: 'job' });
    const [run] = await q.claim({ workerId: 'A' });
    const pending = run.settle(run.succeed());
    await entered;
    await q.cancel({ key: 'job', generation: 1 });
    release();
    await assert.rejects(pending, (e) => e.code === 'stale_attempt');
    assert.equal(await work.dispatch(), 0);
    assert.equal(await child.inspect('child'), undefined);
  },
);

test('continuation planner also runs for a typed terminal failure result', async () => {
  const work = createWorkOnce({ store: createMemoryStore(), scope: 't' });
  const child = work.define('child');
  const parent = work.define('parent', {
    next: ({ input, result, attempt, outcome, reason }) => [
      child.request(
        { input, result, generation: attempt.generation, outcome, reason },
        { key: 'failed-child' },
      ),
    ],
  });
  await parent.enqueue({ id: 'p' }, { key: 'p' });
  const [run] = await parent.claim({ workerId: 'A' });
  await run.settle(run.fail('bad', { result: { diagnostic: 3 }, manualRetry: true }));
  await work.dispatch();
  const saved = await child.inspect('failed-child');
  assert.deepEqual(saved.input, {
    input: { id: 'p' },
    result: { diagnostic: 3 },
    generation: 1,
    outcome: 'fail',
    reason: 'bad',
  });
});
