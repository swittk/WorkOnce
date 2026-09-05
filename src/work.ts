import type { WorkStore } from './storage.js';
import type {
  AttemptRef,
  RetryContext,
  RetryDecision,
  WorkLimits,
  WorkOutcome,
  WorkPhase,
  WorkRecord,
  WorkRequest,
  WorkSnapshot,
  WorkAttempt,
  WorkEvent,
} from './model.js';
import {
  assertCurrent,
  cancelRecord,
  canonical,
  changed,
  claimRecord,
  copy,
  createRecord,
  effectiveNow,
  integer,
  replayReceipt,
  retryRecord,
  sameRequest,
  settleRecord,
  renewRecord,
  workId,
  WorkConflict,
} from './kernel.js';
import { succeed, retry, defer, fail, type WorkTiming } from './outcomes.js';
import {
  processClaims,
  runWorker,
  waitForPoll,
  type WorkerOptions,
  type WorkHandler,
  type ProcessResult,
} from './worker.js';
/** Defaults may be overridden per item; dynamic callbacks are evaluated in trusted application code. */
export interface WorkDefinition<I, R extends string> {
  /** Change deliberately when deployed policy/handler meaning changes. */
  version?: string;
  /** Persistent bounds. These include worker crashes, not only reported failures. */
  limits?: Partial<WorkLimits>;
  /** A static policy or dynamic callback per failure/input. No callback goes into a row. */
  retry?: RetryDecision | ((context: RetryContext<I, R>) => RetryDecision | Promise<RetryDecision>);
}
/** The durable identity and optional per-item limits supplied by a producer. */
export interface EnqueueOptions {
  /** A stable key for the business operation, not a random value on each retry. */
  key: string;
  /** Initial not-before time. Duplicate enqueue never silently reschedules it. */
  availableAt?: number;
  /** Per-item bounds can differ from the kind's defaults. */
  limits?: Partial<WorkLimits>;
}
/** An attempt's ergonomic facade. Outcome helpers are pure, renew/settle explicitly write. */
export class WorkRun<I, O, R extends string> {
  /** Fresh local cancellation signal supplied by the managed runner. */
  signal: AbortSignal = new AbortController().signal;
  constructor(
    readonly queue: WorkQueue<I, O, R>,
    readonly input: I,
    readonly attempt: WorkAttempt,
    readonly observedAt: number,
  ) {}
  /** Foreign workers carry this data, never the JavaScript object. */
  get ref(): AttemptRef {
    const { workId, generation, fence } = this.attempt;
    return { workId, generation, fence };
  }
  succeed(
    ...args: O extends null
      ? [result?: O, options?: { next?: WorkRequest[] }]
      : [result: O, options?: { next?: WorkRequest[] }]
  ): WorkOutcome<O, R> {
    return succeed((args[0] ?? null) as O, args[1]) as WorkOutcome<O, R>;
  }
  retry(reason: R, timing?: WorkTiming): WorkOutcome<O, R> {
    return retry(reason, timing);
  }
  defer(reason: R, timing: WorkTiming): WorkOutcome<O, R> {
    return defer(reason, timing);
  }
  fail(reason: R, options: { manualRetry?: boolean } = {}): WorkOutcome<O, R> {
    return fail(reason, options);
  }
  /** JSON transport contains only input, lease and store time, never store/configuration internals. */
  toJSON(): { input: I; attempt: WorkAttempt; observedAt: number } {
    return copy({ input: this.input, attempt: this.attempt, observedAt: this.observedAt });
  }
  renew(): Promise<{ attempt: WorkAttempt; observedAt: number }> {
    return this.queue.renew(this.ref);
  }
  settle(outcome: WorkOutcome<O, R>): Promise<WorkPhase<O, R>> {
    return this.queue.settle(this.ref, outcome);
  }
}
const defaults: WorkLimits = {
  leaseMs: 60_000,
  maxAttempts: 25,
  maxElapsedMs: 86_400_000,
  maxDeferrals: 1000,
};
/** One typed work kind. Instances are cheap; durable authority lives in the store, not this object. */
export class WorkQueue<I, O = null, R extends string = string> {
  constructor(
    readonly store: WorkStore,
    readonly scope: string,
    readonly kind: string,
    readonly definition: WorkDefinition<I, R>,
  ) {}
  /** Create an inert follow-up description. It does not enqueue until success is durably accepted. */
  request(input: I, options: EnqueueOptions): WorkRequest<I> {
    return copy({
      id: workId(this.scope, this.kind, options.key),
      scope: this.scope,
      kind: this.kind,
      key: options.key,
      definition: this.definition.version ?? '1',
      input,
      limits: { ...defaults, ...this.definition.limits, ...options.limits },
      availableAt: options.availableAt ?? 0,
    });
  }
  /** Atomic create-or-return. Same key plus different payload/limits is not a retry. */
  async enqueue(input: I, options: EnqueueOptions): Promise<WorkSnapshot<I, O, R>> {
    const request = this.request(input, options);
    return this.store.atomic(request.id, (row, now) => {
      if (row) {
        if (!sameRequest(row, request)) throw new WorkConflict('key_conflict');
        return { value: this.snapshot(row, now) };
      }
      const next = createRecord(request, now);
      return { next, value: this.snapshot(next, now) };
    });
  }
  /** Index lookup plus per-candidate atomic claim. Concurrent callers may receive fewer than limit. */
  async claim(options: { workerId: string; limit?: number }): Promise<WorkRun<I, O, R>[]> {
    const limit = integer(options.limit ?? 1, 'limit', 1);
    const candidates = await this.store.query({
      scope: this.scope,
      kind: this.kind,
      select: 'due',
      limit: Math.min(limit * 4, 1000),
    });
    const runs: WorkRun<I, O, R>[] = [];
    for (const candidate of candidates.rows) {
      if (runs.length === limit) break;
      const claimed = await this.store.atomic(candidate.id, (row, now) => {
        if (!row) return { value: null };
        this.assertDefinition(row);
        const next = claimRecord(row, options.workerId, now);
        return next
          ? { next, value: next.phase.state === 'running' ? { row: next, now } : null }
          : { value: null };
      });
      if (claimed && claimed.row.phase.state === 'running')
        runs.push(
          new WorkRun(this, claimed.row.input as I, claimed.row.phase.attempt, claimed.now),
        );
    }
    return runs;
  }
  /** Atomic owner-bound heartbeat. An old process cannot renew a newer process's lease. */
  async renew(ref: AttemptRef): Promise<{ attempt: WorkAttempt; observedAt: number }> {
    return this.store.atomic(ref.workId, (row, now) => {
      this.requireRow(row);
      const next = renewRecord(row, ref, now);
      if (next.phase.state !== 'running') throw new WorkConflict('stale_attempt');
      return { next, value: { attempt: next.phase.attempt, observedAt: now } };
    });
  }
  /**
   * Resolve dynamic retry policy outside storage, then recheck ownership inside the commit.
   * There is intentionally no settle(async domainCallback) overload: that would imply false fencing.
   */
  async settle(ref: AttemptRef, outcome: WorkOutcome<O, R>): Promise<WorkPhase<O, R>> {
    const submitted = copy(outcome);
    const submission = canonical(submitted);
    const current = await this.store.getMany([ref.workId]);
    const row = current.rows[0];
    this.requireRow(row);
    const replay = replayReceipt(row, ref, submission);
    if (replay) return copy(replay) as WorkPhase<O, R>;
    assertCurrent(row, ref, current.now);
    let decision: RetryDecision | undefined;
    if (submitted.type === 'retry') {
      if (row.phase.state !== 'running') throw new WorkConflict('stale_attempt');
      const policy = this.definition.retry ?? { retry: false, manualRetry: true };
      decision =
        typeof policy === 'function'
          ? await policy({
              input: row.input as I,
              reason: submitted.reason,
              attempt: row.phase.attempt,
              retries: row.retries,
              elapsedMs: effectiveNow(row, current.now) - (row.firstStartedAt ?? current.now),
            })
          : policy;
    }
    // Snapshot resolved policy so a caller cannot mutate it while a remote adapter is awaiting IO.
    const resolved = decision === undefined ? undefined : copy(decision);
    return this.store.atomic(ref.workId, (fresh, now) => {
      this.requireRow(fresh);
      const duplicate = replayReceipt(fresh, ref, submission);
      if (duplicate) return { value: duplicate as WorkPhase<O, R> };
      const next = settleRecord(fresh, ref, submitted, submission, resolved, now);
      return { next, value: next.phase as WorkPhase<O, R> };
    });
  }
  /** Inspect a key. This is not authorization; expose only app-authorized keys over your transport. */
  async inspect(key: string): Promise<WorkSnapshot<I, O, R> | undefined> {
    return (await this.inspectMany([key]))[0];
  }
  /** One batched read, preserving the caller's order and missing entries. */
  async inspectMany(keys: readonly string[]): Promise<(WorkSnapshot<I, O, R> | undefined)[]> {
    const result = await this.store.getMany(keys.map((key) => workId(this.scope, this.kind, key)));
    return result.rows.map((row) => (row ? this.snapshot(row, result.now) : undefined));
  }
  /** Latest 128 durable transitions, including reason and worker labels; heartbeats are not events. */
  async history(key: string): Promise<WorkEvent[]> {
    const result = await this.store.getMany([workId(this.scope, this.kind, key)]);
    const row = result.rows[0];
    this.requireRow(row);
    return copy(row.history);
  }
  /** Manual retry gate is evaluated now, then revision/generation checked again at commit. */
  async retry(options: {
    key: string;
    generation: number;
    check?: (snapshot: WorkSnapshot<I, O, R>) => boolean | Promise<boolean>;
  }): Promise<WorkSnapshot<I, O, R>> {
    const id = workId(this.scope, this.kind, options.key);
    let expectedRevision: number | undefined;
    if (options.check) {
      const snapshot = await this.inspect(options.key);
      if (!snapshot) throw new WorkConflict('not_found');
      if (!(await options.check(snapshot))) throw new WorkConflict('retry_denied');
      expectedRevision = snapshot.revision;
    }
    return this.store.atomic(id, (row, now) => {
      this.requireRow(row);
      if (expectedRevision !== undefined && row.revision !== expectedRevision)
        throw new WorkConflict('generation_conflict');
      const next = retryRecord(row, options.generation, now);
      return { next, value: this.snapshot(next, now) };
    });
  }
  /** Cancellation is terminal work state, not evidence that an already-sent HTTP request stopped. */
  async cancel(options: {
    key: string;
    generation: number;
    reason?: string;
  }): Promise<WorkSnapshot<I, O, R>> {
    return this.store.atomic(workId(this.scope, this.kind, options.key), (row, now) => {
      this.requireRow(row);
      const next = cancelRecord(row, options.generation, options.reason ?? 'cancelled', now);
      return { ...(next === row ? {} : { next }), value: this.snapshot(next, now) };
    });
  }
  /** Make a waiting item eligible early after an app-owned safety condition was revalidated. */
  async wake(options: {
    key: string;
    generation: number;
    revision: number;
  }): Promise<WorkSnapshot<I, O, R>> {
    return this.store.atomic(workId(this.scope, this.kind, options.key), (row, clock) => {
      this.requireRow(row);
      const now = effectiveNow(row, clock);
      if (row.generation !== options.generation || row.revision !== options.revision)
        throw new WorkConflict('generation_conflict');
      if (row.phase.state !== 'waiting' && row.phase.state !== 'queued')
        throw new WorkConflict('not_waiting');
      const next = changed(row, { ...row.phase, availableAt: now }, now, 'wake');
      return { next, value: this.snapshot(next, now) };
    });
  }
  /** A bounded group of jobs. Handlers run independently; one rejection does not discard the batch. */
  process(options: WorkerOptions, handler: WorkHandler<I, O, R>): Promise<ProcessResult[]> {
    return processClaims(this, options, handler);
  }
  /** Managed poller; caller owns the lifetime through an AbortSignal. */
  run(
    options: WorkerOptions & { signal: AbortSignal },
    handler: WorkHandler<I, O, R>,
  ): Promise<void> {
    return runWorker(this, options, handler);
  }
  private requireRow(row: WorkRecord | undefined): asserts row is WorkRecord {
    if (!row) throw new WorkConflict('not_found');
    this.assertDefinition(row);
  }
  private assertDefinition(row: WorkRecord): void {
    if (row.scope !== this.scope || row.kind !== this.kind) throw new WorkConflict('not_found');
    if (row.definition !== (this.definition.version ?? '1'))
      throw new WorkConflict('definition_changed');
  }
  private snapshot(row: WorkRecord, now: number): WorkSnapshot<I, O, R> {
    return copy({
      id: row.id,
      key: row.key,
      input: row.input as I,
      generation: row.generation,
      revision: row.revision,
      attempts: row.attempts,
      retries: row.retries,
      deferrals: row.deferrals,
      phase: row.phase as WorkPhase<O, R>,
      pendingFollowups: row.outbox.length,
      observedAt: now,
    });
  }
}
/** Scope one kernel facade to an installation/tenant; the store remains application-supplied. */
export function createWorkOnce(options: { store: WorkStore; scope: string }) {
  const { store, scope } = options;
  const work = {
    define<I, O = null, R extends string = string>(
      kind: string,
      definition: WorkDefinition<I, R> = {},
    ): WorkQueue<I, O, R> {
      return new WorkQueue(store, scope, kind, definition);
    },
    /** Recoverable outbox dispatch. Parent success and intent are atomic; child insertion is deduped. */
    async dispatch(options: { limit?: number } = {}): Promise<number> {
      const limit = integer(options.limit ?? 100, 'limit', 1);
      const result = await store.query({ scope, select: 'outbox', limit });
      let sent = 0;
      for (const parent of result.rows) {
        for (const request of parent.outbox) {
          if (sent === limit) return sent;
          if (request.scope !== scope) throw new WorkConflict('key_conflict');
          await store.atomic(request.id, (row, now) => {
            if (row) {
              if (!sameRequest(row, request)) throw new WorkConflict('key_conflict');
              return { value: null };
            }
            return { next: createRecord(request, now), value: null };
          });
          await store.atomic(parent.id, (row, clock) => {
            if (!row || row.generation !== parent.generation || row.fence !== parent.fence)
              throw new WorkConflict('stale_attempt');
            const next = changed(
              { ...row, outbox: row.outbox.filter((item) => item.id !== request.id) },
              row.phase,
              effectiveNow(row, clock),
              'dispatch',
            );
            return { next, value: null };
          });
          sent += 1;
        }
      }
      return sent;
    },
    /** Supervise the durable follow-up pump alongside application workers. No in-memory hook is required. */
    async runDispatcher(options: {
      signal: AbortSignal;
      intervalMs?: number;
      limit?: number;
      onError?: (error: unknown) => void | Promise<void>;
    }): Promise<void> {
      const interval = integer(options.intervalMs ?? 1000, 'intervalMs', 1);
      while (!options.signal.aborted) {
        try {
          await work.dispatch(options.limit === undefined ? {} : { limit: options.limit });
        } catch (error) {
          if (!options.onError) throw error;
          await options.onError(error);
        }
        await waitForPoll(interval, options.signal);
      }
    },
  };
  return work;
}
