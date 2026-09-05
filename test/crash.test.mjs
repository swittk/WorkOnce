import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';

test('lost success acknowledgement and lost child-insert acknowledgement recover without repeating effects', async () => {
  const base = createMemoryStore();
  let loseSuccess = true,
    loseChild = true;
  const store = {
    ...base,
    async atomic(id, decide) {
      let next;
      const value = await base.atomic(id, (row, now) => {
        const change = decide(row, now);
        next = change.next;
        return change;
      });
      if (next?.phase.state === 'succeeded' && loseSuccess) {
        loseSuccess = false;
        throw new Error('success ACK lost');
      }
      if (next?.kind === 'child' && loseChild) {
        loseChild = false;
        throw new Error('child ACK lost');
      }
      return value;
    },
  };
  const work = createWorkOnce({ store, scope: 't' }),
    parent = work.define('parent'),
    child = work.define('child');
  await parent.enqueue(null, { key: 'p' });
  const [run] = await parent.claim({ workerId: 'A' });
  const outcome = run.succeed(null, { next: [child.request({ parent: 'p' }, { key: 'p-child' })] });
  await assert.rejects(run.settle(outcome), /ACK lost/);
  assert.equal((await run.settle(outcome)).state, 'succeeded');
  await assert.rejects(work.dispatch(), /ACK lost/);
  await work.dispatch();
  assert.equal((await child.claim({ workerId: 'B', limit: 10 })).length, 1);
  assert.equal((await parent.inspect('p')).pendingFollowups, 0);
});
test('manual authorization cannot reuse a stale snapshot after another command changes work', async () => {
  const q = createWorkOnce({ store: createMemoryStore(), scope: 't' }).define('work');
  await q.enqueue(null, { key: 'p' });
  const [run] = await q.claim({ workerId: 'A' });
  await run.settle(run.fail('fix', { manualRetry: true }));
  await assert.rejects(
    q.retry({
      key: 'p',
      generation: 1,
      check: async () => {
        await q.retry({ key: 'p', generation: 1 });
        return true;
      },
    }),
    (e) => e.code === 'generation_conflict',
  );
  assert.equal((await q.inspect('p')).generation, 2);
});
