import type { AttemptRef, WorkOutcome, WorkPhase } from './model.js';
import type { LeasedWork } from './work.js';
import { defer, fail, retry, succeed, type WorkTiming } from './outcomes.js';
import { integer } from './kernel.js';
import { waitForPoll } from './worker.js';

/** Application-supplied transport for one remote/external worker kind. HTTP/auth stay outside WorkOnce. */
export interface RemoteWorkTransport<I, O, R extends string> {
  /** Fetch leases already prepared and fenced by the authoritative WorkOnce service. */
  claim(options: { workerId: string; limit: number }): Promise<LeasedWork<I>[]>;
  /** Renew only this exact authoritative attempt; stale/expired attempts must reject. */
  renew(attempt: AttemptRef): Promise<{ leaseUntil: number; observedAt: number }>;
  /** Submit one pure outcome. Unknown acknowledgements must reject rather than rerun the handler locally. */
  settle(attempt: AttemptRef, outcome: WorkOutcome<O, R>): Promise<WorkPhase<O, R>>;
}

/** Runtime knobs are capacity of this remote-worker process, never a fleet-wide semaphore. */
export interface RemoteWorkerOptions {
  /** Debug/claim label sent to the authoritative service. */
  workerId: string;
  /** Maximum simultaneous leases held by this process. */
  concurrency?: number;
  /** Optional renewal cadence; defaults to one third of the first observed lease. */
  heartbeatMs?: number;
  /** Idle polling delay when no work is available. */
  idleMs?: number;
  /** Graceful local stop; does not durably cancel work. */
  signal: AbortSignal;
  /** Optional observer. A rejecting observer becomes fatal only after active claims drain. */
  onError?: (error: unknown) => void | Promise<void>;
}

/** Per-attempt facade for a foreign TypeScript worker. Outcome helpers are pure wire data. */
export class RemoteWorkRun<O, R extends string> {
  signal: AbortSignal = new AbortController().signal;
  constructor(
    readonly attempt: AttemptRef,
    readonly leaseUntil: number,
    readonly observedAt: number,
  ) {}
  succeed(...args: O extends null ? [result?: O] : [result: O]): WorkOutcome<O, R> {
    return (args.length === 0 ? succeed() : succeed(args[0])) as WorkOutcome<O, R>;
  }
  retry(reason: R, timing?: WorkTiming): WorkOutcome<O, R> {
    return retry(reason, timing);
  }
  defer(reason: R, timing?: WorkTiming): WorkOutcome<O, R> {
    return defer(reason, timing);
  }
  fail(reason: R, options: { manualRetry?: boolean; result?: O } = {}): WorkOutcome<O, R> {
    return fail<R, O>(reason, options);
  }
}

export type RemoteWorkHandler<I, O, R extends string> = (
  run: RemoteWorkRun<O, R>,
  input: I,
) => WorkOutcome<O, R> | Promise<WorkOutcome<O, R>>;

export type RemoteProcessResult =
  | { workId: string; status: 'settled'; phase: WorkPhase }
  | { workId: string; status: 'interrupted'; error: unknown };

async function processLease<I, O, R extends string>(
  transport: RemoteWorkTransport<I, O, R>,
  lease: LeasedWork<I>,
  options: RemoteWorkerOptions,
  handler: RemoteWorkHandler<I, O, R>,
): Promise<RemoteProcessResult> {
  const controller = new AbortController();
  const run = new RemoteWorkRun<O, R>(lease.attempt, lease.leaseUntil, lease.observedAt);
  run.signal = controller.signal;
  const stop = () => controller.abort(options.signal.reason ?? new Error('Remote worker stopped'));
  options.signal.addEventListener('abort', stop, { once: true });
  if (options.signal.aborted) stop();
  let stopped = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const firstLeaseMs = lease.leaseUntil - lease.observedAt;
  if (!Number.isSafeInteger(firstLeaseMs) || firstLeaseMs <= 0) {
    options.signal.removeEventListener('abort', stop);
    return {
      workId: lease.attempt.workId,
      status: 'interrupted',
      error: new RangeError('Remote lease must be positive'),
    };
  }
  const heartbeatMs = Math.min(
    options.heartbeatMs ?? Math.max(1, Math.floor(firstLeaseMs / 3)),
    2_147_483_647,
  );
  function armExpiry(deadline: number) {
    clearTimeout(expiryTimer);
    const remaining = deadline - performance.now();
    if (remaining <= 0) controller.abort(new Error('Confirmed remote lease deadline passed'));
    else expiryTimer = setTimeout(() => armExpiry(deadline), Math.min(remaining, 2_147_483_647));
  }
  async function heartbeat() {
    if (stopped || controller.signal.aborted) return;
    const sentAt = performance.now();
    try {
      const renewed = await transport.renew(lease.attempt);
      if (!stopped && !controller.signal.aborted) {
        armExpiry(sentAt + renewed.leaseUntil - renewed.observedAt);
        heartbeatTimer = setTimeout(() => void heartbeat(), heartbeatMs);
      }
    } catch (error) {
      controller.abort(error);
    }
  }
  try {
    integer(heartbeatMs, 'heartbeatMs', 1);
    if (heartbeatMs >= firstLeaseMs)
      throw new RangeError('heartbeatMs must be shorter than the lease');
    armExpiry(performance.now() + firstLeaseMs);
    heartbeatTimer = setTimeout(() => void heartbeat(), heartbeatMs);
    controller.signal.throwIfAborted();
    const outcome = await handler(run, lease.input);
    controller.signal.throwIfAborted();
    const phase = await transport.settle(lease.attempt, outcome);
    return { workId: lease.attempt.workId, status: 'settled', phase };
  } catch (error) {
    return { workId: lease.attempt.workId, status: 'interrupted', error };
  } finally {
    stopped = true;
    clearTimeout(heartbeatTimer);
    clearTimeout(expiryTimer);
    options.signal.removeEventListener('abort', stop);
  }
}

/** Claim only this process's free slots and process the returned remote leases in parallel. */
export async function processRemoteWork<I, O, R extends string>(
  transport: RemoteWorkTransport<I, O, R>,
  options: RemoteWorkerOptions,
  handler: RemoteWorkHandler<I, O, R>,
): Promise<RemoteProcessResult[]> {
  if (options.signal.aborted) return [];
  const leases = await transport.claim({
    workerId: options.workerId,
    limit: integer(options.concurrency ?? 1, 'concurrency', 1),
  });
  return Promise.all(leases.map((lease) => processLease(transport, lease, options, handler)));
}

/** Managed remote worker loop with bounded local concurrency and conservative lease-loss handling. */
export async function runRemoteWorker<I, O, R extends string>(
  transport: RemoteWorkTransport<I, O, R>,
  options: RemoteWorkerOptions,
  handler: RemoteWorkHandler<I, O, R>,
): Promise<void> {
  const capacity = integer(options.concurrency ?? 1, 'concurrency', 1);
  const idleMs = integer(options.idleMs ?? 250, 'idleMs', 1);
  const active = new Set<Promise<void>>();
  let fatal: unknown;
  while (!options.signal.aborted && fatal === undefined) {
    const available = capacity - active.size;
    if (!available) {
      await Promise.race(active);
      continue;
    }
    let leases: LeasedWork<I>[];
    try {
      leases = await transport.claim({ workerId: options.workerId, limit: available });
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
    for (const lease of leases) {
      const pending = processLease(transport, lease, options, handler)
        .then(async (result) => {
          if (result.status === 'interrupted' && !options.signal.aborted) {
            if (options.onError) await options.onError(result.error);
            else fatal = result.error;
          }
        })
        .catch((error) => {
          fatal = error;
        })
        .finally(() => active.delete(pending));
      active.add(pending);
    }
    if (!leases.length) await waitForPoll(idleMs, options.signal);
  }
  await Promise.all(active);
  if (fatal !== undefined) throw fatal;
}
