import { createWorkOnce } from '../../dist/index.js';
import { createSqliteStore } from '../../dist/sqlite.js';

const [path, mode] = process.argv.slice(2);
if (!path || !mode) throw new Error('usage: storage-child.mjs <path> <mode>');
const base = createSqliteStore(path);
const forever = new Promise(() => {});

if (mode === 'commit-before-ack') {
  const store = {
    ...base,
    async atomic(id, decide) {
      const value = await base.atomic(id, decide);
      process.send?.({ stage: 'committed', id });
      await forever;
      return value;
    },
  };
  const queue = createWorkOnce({ store, scope: 'storage-process' }).define('job');
  process.send?.({ ready: true });
  await queue.ensure({ value: 1 }, { key: 'x' });
  process.send?.({ unexpectedReturn: true });
} else if (mode === 'decision-fault') {
  process.send?.({ ready: true });
  try {
    await base.atomic('["storage-process","job","x"]', () => {
      throw new Error('decision failed');
    });
  } catch (error) {
    process.send?.({ stage: 'decision-failed', message: error?.message });
    await forever;
  }
} else {
  throw new Error(`unknown mode ${mode}`);
}
