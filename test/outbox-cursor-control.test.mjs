import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';

async function settleParent(queue, workerId, next) {
  const [run] = await queue.claim({ workerId, limit: 1 });
  assert.ok(run);
  await run.settle(run.succeed(null, { next }));
}

test('bounded outbox cursor advances to the next parent before wrapping', async () => {
  const store = createMemoryStore({ now: () => 1000 });
  const scope = 'outbox-cursor-control';
  const work = createWorkOnce({ store, scope });
  const firstCandidate = work.define('parent-a');
  const secondCandidate = work.define('parent-b');
  const child = work.define('child');
  const firstSnapshot = await firstCandidate.ensure(null, { key: 'p' });
  const secondSnapshot = await secondCandidate.ensure(null, { key: 'p' });
  const byId = new Map([
    [firstSnapshot.id, firstCandidate],
    [secondSnapshot.id, secondCandidate],
  ]);
  const orderedRows = (await store.query({ scope, select: 'all', limit: 10 })).rows.filter((row) =>
    byId.has(row.id),
  );
  assert.equal(orderedRows.length, 2);
  const first = byId.get(orderedRows[0].id);
  const second = byId.get(orderedRows[1].id);
  await settleParent(first, 'first', [
    child.request(null, { key: 'a1' }),
    child.request(null, { key: 'a2' }),
  ]);
  await settleParent(second, 'second', [child.request(null, { key: 'b1' })]);

  assert.equal(await work.dispatch({ limit: 1 }), 1);
  assert.equal(await work.dispatch({ limit: 1 }), 1);
  assert.ok(await child.inspect('b1'), 'cursor must advance to the next parent on the second pass');
  assert.equal(
    await child.inspect('a2'),
    undefined,
    'partially drained first parent must wait until cursor wrap',
  );
  assert.equal(await work.dispatch({ limit: 1 }), 1);
  assert.ok(await child.inspect('a2'), 'cursor wrap must drain the deferred follow-up');
});
