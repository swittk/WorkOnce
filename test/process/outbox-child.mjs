import { createWorkOnce } from '../../dist/index.js';
import { createSqliteStore } from '../../dist/sqlite.js';

const [path, mode, parentId] = process.argv.slice(2);
const base = createSqliteStore(path);
let signaled = false;
const never = new Promise(() => {});
const store = {
  ...base,
  async atomic(id, decide) {
    let before;
    let after;
    const value = await base.atomic(id, (row, now) => {
      before = row;
      const change = decide(row, now);
      after = change.next;
      return change;
    });
    if (!signaled && mode === 'after-child' && before === undefined && after?.kind === 'child') {
      signaled = true;
      process.send?.({ stage: 'child-committed', childId: id });
      await never;
    }
    if (
      !signaled &&
      mode === 'after-parent-ack' &&
      id === parentId &&
      before?.outbox?.length > 0 &&
      after?.outbox?.length < before.outbox.length
    ) {
      signaled = true;
      process.send?.({ stage: 'parent-acked', parentId: id });
      await never;
    }
    if (
      !signaled &&
      mode === 'after-rotation' &&
      id === parentId &&
      before?.outbox?.length >= 2 &&
      after?.outbox?.length === before.outbox.length &&
      before.outbox[0]?.id !== after.outbox[0]?.id
    ) {
      signaled = true;
      process.send?.({ stage: 'parent-rotated', parentId: id });
      await never;
    }
    return value;
  },
};
const work = createWorkOnce({ store, scope: 'outbox-process' });
process.send?.({ ready: true });
process.once('message', async (message) => {
  if (message !== 'go') return;
  try {
    await work.dispatch({ limit: 1 });
    process.send?.({ unexpected: 'dispatch-returned' });
  } catch (error) {
    process.send?.({ error: String(error), code: error?.code });
  } finally {
    base.close();
    process.disconnect?.();
  }
});
