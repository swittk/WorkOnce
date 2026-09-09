import { createWorkOnce } from '../../dist/index.js';
import { createSqliteStore } from '../../dist/sqlite.js';

const [path, mode] = process.argv.slice(2);
const base = createSqliteStore(path);
const forever = new Promise(() => {
  // The crash fixture must remain alive until its parent delivers SIGKILL.
  // A pending Promise alone does not keep Node's event loop referenced.
  setInterval(() => {}, 60_000);
});
const store =
  mode === 'heartbeat-ack' || mode === 'settle-ack'
    ? {
        ...base,
        async atomic(id, decide) {
          let before;
          let next;
          const value = await base.atomic(id, (row, now) => {
            before = row;
            const change = decide(row, now);
            next = change.next;
            return change;
          });
          const renewed =
            mode === 'heartbeat-ack' &&
            before?.phase?.state === 'running' &&
            next?.phase?.state === 'running' &&
            next.phase.attempt.fence === before.phase.attempt.fence &&
            next.phase.attempt.leaseUntil > before.phase.attempt.leaseUntil;
          const settled =
            mode === 'settle-ack' &&
            before?.phase?.state === 'running' &&
            next?.phase?.state === 'succeeded';
          if (renewed || settled) {
            process.send?.({
              stage: renewed ? 'heartbeat-committed' : 'settlement-committed',
              ref: before.phase.attempt,
            });
            await forever;
          }
          return value;
        },
      }
    : base;
const leaseMs = mode === 'multi-active' ? 2000 : 200;
const queue = createWorkOnce({ store, scope: 'local-runner-process' }).define('job', {
  limits: { leaseMs, maxAttempts: 4, maxElapsedMs: 60_000, maxDeferrals: 2 },
});
process.send?.({ ready: true });

if (mode === 'multi-active') {
  await queue.run(
    {
      workerId: 'crash-worker',
      concurrency: 3,
      heartbeatMs: 50,
      idleMs: 1,
      signal: new AbortController().signal,
    },
    async (run, input) => {
      process.send?.({ stage: 'started', key: input.key, ref: run.ref });
      await forever;
      return run.succeed();
    },
  );
} else if (mode === 'heartbeat-ack') {
  await queue.runAvailable({ workerId: 'heartbeat-worker', heartbeatMs: 10 }, async (run) => {
    await forever;
    return run.succeed();
  });
} else if (mode === 'settle-ack') {
  await queue.runAvailable({ workerId: 'settle-worker', heartbeatMs: 100 }, async (run) =>
    run.succeed(),
  );
} else {
  throw new Error(`Unknown local runner process mode: ${mode}`);
}
