import type { AttemptRef, WorkOutcome, WorkPhase, WorkSnapshot } from './model.js';
import type { EnqueueOptions, LeasedWork } from './work.js';
import { defer, fail, retry, succeed, wait, type WorkTiming } from './outcomes.js';
import { integer } from './kernel.js';
import { waitForPoll } from './worker.js';

/** Application-supplied transport for one external worker kind. HTTP/auth stay outside WorkOnce. */
export interface ExternalWorkTransport<I, O, R extends string> {
  /** Fetch at most limit leases already prepared and fenced by the authoritative WorkOnce service. */
  claim(options: {
    workerId: string;
    limit: number;
    /** Lets network transports cancel an in-flight poll during graceful shutdown. */
    signal?: AbortSignal;
  }): Promise<LeasedWork<I>[]>;
  /** Heartbeat this exact attempt to extend its lease; stale or expired ownership must reject. */
  heartbeat(attempt: AttemptRef): Promise<{ leaseUntil: number; observedAt: number }>;
  /** Submit one pure outcome. Unknown acknowledgements must reject rather than rerun the handler locally. */
  settle(attempt: AttemptRef, outcome: WorkOutcome<O, R>): Promise<WorkPhase<O, R>>;
}

/** Authoritative service exposed to an executor outside this WorkOnce runtime. */
export interface ExternalWorkService<I, WorkerInput, O, R extends string>
  extends ExternalWorkTransport<WorkerInput, O, R> {
  /** Idempotent producer entrypoint using the work definition's key callback when configured. */
  ensure(input: I, options?: EnqueueOptions): Promise<WorkSnapshot<I, O, R>>;
}

/** Runtime knobs are capacity of this external executor, never a fleet-wide semaphore. */
export interface ExternalWorkerOptions {
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

/** Per-attempt facade for an executor outside the authoritative WorkOnce runtime. Outcome helpers are pure wire data. */
export class ExternalWorkRun<O, R extends string> {
  /** Cooperative cancellation signal aborted when ownership is lost or the worker shuts down. */
  signal: AbortSignal = new AbortController().signal;
  /** Create the per-attempt external facade from one authoritative leased work item. */
  constructor(
    readonly attempt: AttemptRef,
    readonly leaseUntil: number,
    readonly observedAt: number,
  ) {}
  /** Report successful completion; the external-work service still performs the authoritative settlement. */
  succeed(...args: O extends null ? [result?: O] : [result: O]): WorkOutcome<O, R> {
    return (args.length === 0 ? succeed() : succeed(args[0])) as WorkOutcome<O, R>;
  }
  /** Report a temporary failure that should be retried later. */
  retry(reason: R, timing?: WorkTiming): WorkOutcome<O, R> {
    return retry(reason, timing);
  }
  /** Wait without counting a failure retry; this external attempt ends and the work resumes later. */
  wait(reason: R, timing?: WorkTiming): WorkOutcome<O, R> {
    return wait(reason, timing);
  }
  /** Standard queue synonym retained for compatibility; prefer `wait`. */
  defer(reason: R, timing?: WorkTiming): WorkOutcome<O, R> {
    return defer(reason, timing);
  }
  /** Report a terminal failure, optionally permitting a later manual retry. */
  fail(reason: R, options: { manualRetry?: boolean; result?: O } = {}): WorkOutcome<O, R> {
    return fail<R, O>(reason, options);
  }
}

/** Handler contract for one externally leased item. */
export type ExternalWorkHandler<I, O, R extends string> = (
  run: ExternalWorkRun<O, R>,
  input: I,
) => WorkOutcome<O, R> | Promise<WorkOutcome<O, R>>;

/** Per-lease result returned by the one-shot external worker processor. */
export type ExternalProcessResult<O = unknown, R extends string = string> =
  | { workId: string; status: 'settled'; phase: WorkPhase<O, R> }
  | { workId: string; status: 'interrupted'; error: unknown };

/** Validate process-wide knobs before claiming anything; per-lease checks only compare against that lease. */
function validateExternalWorkerOptions(options: ExternalWorkerOptions): number {
  if (options.heartbeatMs !== undefined) integer(options.heartbeatMs, 'heartbeatMs', 1);
  return integer(options.concurrency ?? 1, 'concurrency', 1);
}

async function processLease<I, O, R extends string>(
  transport: ExternalWorkTransport<I, O, R>,
  lease: LeasedWork<I>,
  options: ExternalWorkerOptions,
  handler: ExternalWorkHandler<I, O, R>,
): Promise<ExternalProcessResult<O, R>> {
  const controller = new AbortController();
  const run = new ExternalWorkRun<O, R>(lease.attempt, lease.leaseUntil, lease.observedAt);
  run.signal = controller.signal;
  const stop = () => controller.abort();
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
      error: new RangeError('External lease must be positive'),
    };
  }
  const heartbeatMs = Math.min(
    options.heartbeatMs ?? Math.max(1, Math.floor(firstLeaseMs / 3)),
    2_147_483_647,
  );
  function armExpiry(deadline: number) {
    clearTimeout(expiryTimer);
    const remaining = deadline - performance.now();
    if (remaining <= 0) controller.abort(new Error('Confirmed external lease deadline passed'));
    else expiryTimer = setTimeout(() => armExpiry(deadline), Math.min(remaining, 2_147_483_647));
  }
  async function heartbeat() {
    if (stopped || controller.signal.aborted) return;
    const sentAt = performance.now();
    try {
      const renewed = await transport.heartbeat(lease.attempt);
      if (!stopped && !controller.signal.aborted) {
        armExpiry(sentAt + renewed.leaseUntil - renewed.observedAt);
        heartbeatTimer = setTimeout(() => void heartbeat(), heartbeatMs);
      }
    } catch (error) {
      controller.abort(error);
    }
  }
  try {
    if (heartbeatMs >= firstLeaseMs)
      throw new RangeError('heartbeatMs must be shorter than the lease');
    armExpiry(performance.now() + firstLeaseMs);
    heartbeatTimer = setTimeout(() => void heartbeat(), heartbeatMs);
    if (controller.signal.aborted) throw new Error('External ownership lost');
    const outcome = await handler(run, lease.input);
    if (controller.signal.aborted) throw new Error('External ownership lost');
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

/** Claim only this executor's free slots and process returned external leases in parallel. */
export async function processExternal<I, O, R extends string>(
  transport: ExternalWorkTransport<I, O, R>,
  options: ExternalWorkerOptions,
  handler: ExternalWorkHandler<I, O, R>,
): Promise<ExternalProcessResult<O, R>[]> {
  const limit = validateExternalWorkerOptions(options);
  if (options.signal.aborted) return [];
  let leases: LeasedWork<I>[];
  try {
    leases = await transport.claim({
      workerId: options.workerId,
      limit,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) return [];
    throw error;
  }
  // ExternalWorkTransport.claim is authoritative and must honor limit; never locally slice leased work.
  return Promise.all(leases.map((lease) => processLease(transport, lease, options, handler)));
}

/** Managed external executor loop with bounded local concurrency and conservative lease-loss handling. */
export async function runExternal<I, O, R extends string>(
  transport: ExternalWorkTransport<I, O, R>,
  options: ExternalWorkerOptions,
  handler: ExternalWorkHandler<I, O, R>,
): Promise<void> {
  const capacity = validateExternalWorkerOptions(options);
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
      leases = await transport.claim({
        workerId: options.workerId,
        limit: available,
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal.aborted) break;
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
