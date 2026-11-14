import { createWorkOnce } from '../../dist/index.js';
import { createSqliteStore } from '../../dist/sqlite.js';

const [path] = process.argv.slice(2);
if (!path) throw new Error('usage: retention-child.mjs <path>');

const store = createSqliteStore(path, { now: () => 100 });
const queue = createWorkOnce({ store, scope: 'retention-crash' }).define('job', {
  retention: { afterTerminalMs: 0 },
});
const snapshot = await queue.ensure({ payload: 1 }, { key: 'same' });
const [run] = await queue.claim({ workerId: 'crashing-worker' });
await run.settle(run.succeed());
process.send?.({
  stage: 'terminal-committed',
  snapshot: await queue.inspect(snapshot.key),
  ref: run.ref,
});

setInterval(() => {
  // The process intentionally remains alive until the parent sends SIGKILL.
}, 60_000);
