import { createWorkOnce } from '../../dist/index.js';
import { createSqliteStore } from '../../dist/sqlite.js';

const [path, mode, outcomeKind, leaseMsArg, maxElapsedMsArg] = process.argv.slice(2);
const leaseMs = Number(leaseMsArg);
const maxElapsedMs = Number(maxElapsedMsArg);
if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0)
  throw new Error('Policy child requires a positive safe-integer lease');
if (!Number.isSafeInteger(maxElapsedMs) || maxElapsedMs <= leaseMs)
  throw new Error('Policy child requires a safe elapsed budget beyond the lease');
const base = createSqliteStore(path);
let currentRef;
setInterval(() => {}, 1000);
const forever = new Promise(() => {});
const dynamicTiming = async (context) => {
  process.send?.({ stage: 'policy-entered', outcomeKind, ref: context.attempt });
  await forever;
  return outcomeKind === 'retry'
    ? { retry: true, afterMs: 0, maxRetries: 2, manualRetry: true }
    : { afterMs: 0 };
};
const limits = { leaseMs, maxAttempts: 4, maxElapsedMs, maxDeferrals: 4 };
const staticDefinition = {
  retry: { retry: true, afterMs: 0, maxRetries: 2, manualRetry: true },
  wait: { afterMs: 0 },
  limits,
};
const store =
  mode === 'after-commit'
    ? {
        ...base,
        async atomic(id, decide) {
          let committedWaiting = false;
          const value = await base.atomic(id, (row, now) => {
            const change = decide(row, now);
            committedWaiting = change.next?.phase?.state === 'waiting';
            return change;
          });
          if (committedWaiting) {
            process.send?.({ stage: 'settlement-committed', outcomeKind, ref: currentRef });
            await forever;
          }
          return value;
        },
      }
    : base;
const definition =
  mode === 'during-policy'
    ? outcomeKind === 'retry'
      ? { retry: dynamicTiming, limits }
      : { wait: dynamicTiming, limits }
    : staticDefinition;
const queue = createWorkOnce({ store, scope: 'policy-process' }).define('job', definition);
const [run] = await queue.claim({ workerId: `child-${mode}-${outcomeKind}`, limit: 1 });
if (!run) throw new Error('Expected process proof claim');
currentRef = run.ref;
process.send?.({ ready: true, ref: run.ref });
const outcome = outcomeKind === 'retry' ? run.retry('busy') : run.wait('pending');
await run.settle(outcome);
process.send?.({ unexpectedReturn: true });
