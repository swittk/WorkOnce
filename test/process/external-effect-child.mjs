import { appendFileSync } from 'node:fs';
import { createWorkOnce, runExternalAvailable } from '../../dist/index.js';
import { createSqliteStore } from '../../dist/sqlite.js';

const [dbPath, effectPath, mode] = process.argv.slice(2);
const store = createSqliteStore(dbPath);
const work = createWorkOnce({ store, scope: 'external-effect-process' });
const queue = work.define('job', {
  key: (input) => input.id,
  limits: { leaseMs: 250, maxAttempts: 4, maxElapsedMs: 60_000 },
});
const service = queue.serveExternal({
  prepare: (run) => run.handoff(run.input),
  onPrepareError: (run) => run.fail('prepare_failed'),
});
setInterval(() => {}, 1000);
const forever = new Promise(() => {});
let transport = service;
if (mode === 'after-settle') {
  transport = {
    ...service,
    async settle(attempt, outcome) {
      const phase = await service.settle(attempt, outcome);
      process.send?.({ stage: 'settlement-committed', attempt, outcome });
      await forever;
      return phase;
    },
  };
}
process.send?.({ ready: true });
await runExternalAvailable(
  transport,
  { workerId: `child-${mode}`, signal: new AbortController().signal },
  async (run) => {
    appendFileSync(effectPath, `${run.attempt.fence}\n`);
    process.send?.({ stage: 'effect-recorded', attempt: run.attempt });
    if (mode === 'before-settle') await forever;
    return run.succeed();
  },
);
process.send?.({ unexpectedReturn: true });
