import type { WorkQueue, WorkRun } from './work.js';
import type { WorkOutcome, WorkPhase } from './model.js';
import { integer } from './kernel.js';

const localClaimStartedAt = new WeakMap<object, number>();

/** Record the monotonic lower bound immediately before one authoritative local claim attempt. */
export function markLocalClaimStartedAt(run: object, startedAt: number): void {
  localClaimStartedAt.set(run, startedAt);
}
/** Runtime knobs are local worker capacity, not an implied fleet-wide semaphore. */
export interface WorkerOptions {
  /** A useful debugging label; fences, not this label, identify ownership. */
  workerId: string;
  /** Maximum simultaneously claimed jobs in this process. Defaults to one. */
  concurrency?: number;
  /** Optional shorter heartbeat interval; must be below the actual lease duration. */
  heartbeatMs?: number;
  /** Idle poll delay. Notifications may optimize this later without owning correctness. */
  idleMs?: number;
  /** Graceful stop signal. It is not a durable cancel command. */
  signal?: AbortSignal;
  /** Explicit error observer for the long-running poller. Without it the poller rejects. */
  onError?: (error: unknown) => void | Promise<void>;
}
/** A handler returns data describing an outcome. The runner does the fenced commit. */
export type WorkHandler<I, O, R extends string> = (
  run: WorkRun<I, O, R>,
  input: I,
) => WorkOutcome<O, R> | Promise<WorkOutcome<O, R>>;
/** One bounded run-available pass reports failures independently without losing healthy neighbors. */
export type RunAvailableResult<O = unknown, R extends string = string> =
  | { workId: string; status: 'settled'; phase: WorkPhase<O, R> }
  | { workId: string; status: 'interrupted'; error: unknown };
/** Conventional worker synonym retained for compatibility; prefer `RunAvailableResult`. */
export type ProcessResult<O = unknown, R extends string = string> = RunAvailableResult<O, R>;
/** Validate static worker knobs before any claim; per-claim checks only compare against that lease. */
function validateWorkerOptions(options: WorkerOptions): number {
  if (options.heartbeatMs !== undefined) integer(options.heartbeatMs, 'heartbeatMs', 1);
  return integer(options.concurrency ?? 1, 'concurrency', 1);
}
/** Wait between empty polls while allowing graceful worker shutdown to end the delay early. */
export function waitForPoll(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve();
    };
    const timer = setTimeout(stop, Math.min(ms, 2_147_483_647));
    signal?.addEventListener('abort', stop, { once: true });
  });
}
async function processClaim<I, O, R extends string>(
  run: WorkRun<I, O, R>,
  options: WorkerOptions,
  handler: WorkHandler<I, O, R>,
): Promise<RunAvailableResult<O, R>> {
  const controller = new AbortController();
  run.signal = controller.signal;
  const stop = () => controller.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  let stopped = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const leaseMs = run.attempt.leaseUntil - run.observedAt;
  const heartbeatMs =
    options.heartbeatMs === undefined && leaseMs === 1
      ? undefined
      : Math.min(options.heartbeatMs ?? Math.max(1, Math.floor(leaseMs / 3)), 2_147_483_647);
  function armExpiry(deadline: number) {
    clearTimeout(expiryTimer);
    const remaining = deadline - performance.now();
    if (remaining <= 0) controller.abort(new Error('Confirmed lease deadline passed'));
    else expiryTimer = setTimeout(() => armExpiry(deadline), Math.min(remaining, 2_147_483_647));
  }
  async function heartbeat() {
    if (stopped || controller.signal.aborted) return;
    const sentAt = performance.now();
    try {
      const renewed = await run.heartbeat();
      if (!stopped && !controller.signal.aborted) {
        // Charge the whole round trip to the lease: never infer extra ownership from a slow reply.
        armExpiry(sentAt + renewed.attempt.leaseUntil - renewed.observedAt);
        if (heartbeatMs !== undefined)
          heartbeatTimer = setTimeout(() => {
            void heartbeat();
          }, heartbeatMs);
      }
    } catch (error) {
      controller.abort(error);
    }
  }
  try {
    if (heartbeatMs !== undefined && heartbeatMs >= leaseMs)
      throw new RangeError('heartbeatMs must be shorter than the lease');
    armExpiry((localClaimStartedAt.get(run) ?? performance.now()) + leaseMs);
    if (heartbeatMs !== undefined)
      heartbeatTimer = setTimeout(() => {
        void heartbeat();
      }, heartbeatMs);
    if (controller.signal.aborted) throw new Error('Worker ownership lost');
    const outcome = await handler(run, run.input);
    if (controller.signal.aborted) throw new Error('Worker ownership lost');
    // Never rerun a handler because delivering its completed outcome failed.
    const phase = await run.settle(outcome);
    return { workId: run.ref.workId, status: 'settled', phase };
  } catch (error) {
    return { workId: run.ref.workId, status: 'interrupted', error };
  } finally {
    stopped = true;
    clearTimeout(heartbeatTimer);
    clearTimeout(expiryTimer);
    options.signal?.removeEventListener('abort', stop);
  }
}
/** Claim only free capacity and start all returned jobs immediately, not sequentially behind leases. */
export async function processClaims<I, O, R extends string>(
  queue: WorkQueue<I, O, R>,
  options: WorkerOptions,
  handler: WorkHandler<I, O, R>,
): Promise<RunAvailableResult<O, R>[]> {
  const limit = validateWorkerOptions(options);
  if (options.signal?.aborted) return [];
  const claims = await queue.claim({
    workerId: options.workerId,
    limit,
  });
  return Promise.all(claims.map((run) => processClaim(run, options, handler)));
}
/** A managed runner with bounded local capacity. Multiple processes may use the same queue. */
export async function runWorker<I, O, R extends string>(
  queue: WorkQueue<I, O, R>,
  options: WorkerOptions & { signal: AbortSignal },
  handler: WorkHandler<I, O, R>,
): Promise<void> {
  const capacity = validateWorkerOptions(options);
  const idleMs = integer(options.idleMs ?? 250, 'idleMs', 1);
  const active = new Set<Promise<void>>();
  let fatal: unknown;
  while (!options.signal.aborted && fatal === undefined) {
    const available = capacity - active.size;
    if (!available) {
      await Promise.race(active);
      continue;
    }
    let claims: WorkRun<I, O, R>[];
    try {
      claims = await queue.claim({ workerId: options.workerId, limit: available });
    } catch (error) {
      if (!options.onError) {
        fatal = error;
        break;
      }
      try {
        await options.onError(error);
      } catch (observerError) {
        fatal = observerError;
        break;
      }
      await waitForPoll(idleMs, options.signal);
      continue;
    }
    for (const claim of claims) {
      const pending = processClaim(claim, options, handler)
        .then(async (result) => {
          if (result.status === 'interrupted' && !options.signal.aborted) {
            if (options.onError) await options.onError(result.error);
            else fatal = result.error;
          }
        })
        .catch((error) => {
          fatal = error;
        })
        .finally(() => {
          active.delete(pending);
        });
      active.add(pending);
    }
    if (!claims.length) await waitForPoll(idleMs, options.signal);
  }
  await Promise.all(active);
  if (fatal !== undefined) throw fatal;
}
