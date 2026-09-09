import { createWorkOnce } from '../../dist/index.js';
import { createSqliteStore } from '../../dist/sqlite.js';

const [path, mode, detail] = process.argv.slice(2);
const base = createSqliteStore(path);
const forever = new Promise(() => {});
setInterval(() => {}, 1000);
let intercept = false;
let currentRef;

const store = {
  ...base,
  async atomic(id, decide) {
    let staged;
    const value = await base.atomic(id, (row, now) => {
      const change = decide(row, now);
      if (intercept && change.next) staged = change.next;
      return change;
    });
    if (intercept && staged) {
      const shouldBlock =
        (mode === 'ensure-after-commit' && staged.revision === 1) ||
        (mode === 'renew-after-commit' && staged.phase.state === 'running') ||
        (mode === 'terminal-after-commit' &&
          (staged.phase.state === 'succeeded' || staged.phase.state === 'failed')) ||
        (mode === 'reset-after-commit' &&
          staged.generation === 2 &&
          staged.phase.state === 'queued') ||
        (mode === 'claim-scan-after-first-commit' && staged.phase.state === 'running');
      if (shouldBlock) {
        intercept = false;
        process.send?.({
          stage: mode,
          detail,
          ref: currentRef ?? staged.phase.attempt,
          revision: staged.revision,
          generation: staged.generation,
          phase: staged.phase.state,
        });
        await forever;
      }
    }
    return value;
  },
};

const queue = createWorkOnce({ store, scope: 'lifecycle-process' }).define('job', {
  limits: { leaseMs: 30000, maxAttempts: 4, maxElapsedMs: 60000, maxDeferrals: 4 },
});

if (mode === 'ensure-after-commit') {
  intercept = true;
  await queue.ensure({ value: 1 }, { key: 'job' });
} else if (mode === 'renew-after-commit') {
  const [run] = await queue.claim({ workerId: 'child-renew' });
  if (!run) throw new Error('Expected renewal proof claim');
  currentRef = run.ref;
  process.send?.({ ready: true, ref: run.ref });
  intercept = true;
  await run.renew();
} else if (mode === 'terminal-after-commit') {
  const [run] = await queue.claim({ workerId: `child-${detail}` });
  if (!run) throw new Error('Expected terminal proof claim');
  currentRef = run.ref;
  process.send?.({ ready: true, ref: run.ref });
  intercept = true;
  const outcome =
    detail === 'succeed' ? run.succeed({ value: 2 }) : run.fail('bad', { manualRetry: true });
  await run.settle(outcome);
} else if (mode === 'reset-after-commit') {
  const before = await queue.inspect('job');
  process.send?.({ ready: true, generation: before.generation, phase: before.phase.state });
  intercept = true;
  if (detail === 'retry') await queue.retry({ key: 'job', generation: 1 });
  else await queue.rerun({ key: 'job', generation: 1 });
} else if (mode === 'claim-scan-after-first-commit') {
  intercept = true;
  await queue.claim({ workerId: 'child-scan', limit: 3 });
} else {
  throw new Error(`Unknown lifecycle process mode ${mode}`);
}

process.send?.({ unexpectedReturn: true });
setInterval(() => {}, 1000);
