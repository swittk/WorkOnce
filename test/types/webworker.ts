import {
  createWorkOnce,
  exponentialBackoff,
  runExternal,
  runExternalAvailable,
  type ExternalWorkTransport,
} from '../../src/index.js';
import type { WorkStore } from '../../src/storage.js';

declare const store: WorkStore;
const controller = new AbortController();
const work = createWorkOnce({ store, scope: 'web-worker' });
const retryPolicy = exponentialBackoff({
  initialDelayMs: 100,
  maxDelayMs: 5_000,
  maxRetries: 5,
});
const job = work.define<{ id: string }, string, 'temporary' | 'pending'>('browser.job', {
  key: (input) => input.id,
  executionLimits: { leaseMs: 5_000, maxAttempts: 10 },
  retry: retryPolicy,
  perform: async (run, input) => {
    if (run.signal.aborted) return run.retry('temporary');
    return run.succeed(input.id);
  },
});
void job.ensure({ id: 'typed' });
void job.runAvailable({ workerId: 'worker' });
void job.run({ workerId: 'worker', signal: controller.signal });
const external = job.serveExternal({
  prepare: (run) => run.handoff({ id: run.input.id }),
  onPrepareError: (run) => run.retry('temporary'),
});
const transport: ExternalWorkTransport<{ id: string }, string, 'temporary' | 'pending'> = external;
void runExternalAvailable(
  transport,
  { workerId: 'outside-once', signal: controller.signal },
  async (run, input) => run.succeed(input.id),
);
void runExternal(
  transport,
  { workerId: 'outside', signal: controller.signal },
  async (run, input) => run.succeed(input.id),
);
