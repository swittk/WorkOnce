import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
test(
  'follow-up pump recovers pending delivery and bounded passes respect child capacity',
  { timeout: 10_000 },
  async () => {
    const work = createWorkOnce({ store: createMemoryStore(), scope: 't' }),
      parent = work.define('parent'),
      child = work.define('child');
    await parent.enqueue(null, { key: 'p' });
    const [run] = await parent.claim({ workerId: 'A' });
    await run.settle(
      run.succeed(null, {
        next: [child.request(null, { key: '1' }), child.request(null, { key: '2' })],
      }),
    );
    assert.equal(await work.dispatch({ limit: 1 }), 1);
    assert.equal((await parent.inspect('p')).pendingFollowups, 1);
    const controller = new AbortController();
    const pumping = work.runDispatcher({ signal: controller.signal, intervalMs: 5 });
    const deadline = performance.now() + 5000;
    while ((await parent.inspect('p')).pendingFollowups > 0 && performance.now() < deadline)
      await sleep(10);
    controller.abort();
    await pumping;
    assert.equal((await parent.inspect('p')).pendingFollowups, 0);
    assert.ok(await child.inspect('2'));
  },
);
