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
  rerunRecord,
  sameRequest,
  settleRecord,
  renewRecord,
  workId,
  WorkConflict,
} from './kernel.js';
import {
  succeed,
  retry,
  wait,
  defer,
  fail,
  type FollowUpOptions,
  type WorkTiming,
} from './outcomes.js';
/** Compact cryptographic receipt identity; the canonical outcome itself can be very large. */
async function createSubmissionHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}
import {
  processClaims,
  runWorker,
  waitForPoll,
  type WorkerOptions,
  type WorkHandler,
  type ProcessResult,
} from './worker.js';
/** Defaults may be overridden per item; dynamic callbacks are evaluated in trusted application code. */
export interface WorkDefinition<I, R extends string, O = unknown> {
  /** Change deliberately when deployed policy/handler meaning changes. */
  version?: string;
  /** Stable business identity derived from typed input when callers should not repeat key plumbing. */
  key?: (input: I) => string;
  /** Preferred readable name for per-work execution safety bounds. This is not rate throttling. */
  executionLimits?: Partial<WorkLimits> | ((input: I) => Partial<WorkLimits>);
  /** Standard internal synonym retained for compatibility; prefer `executionLimits`. */
  limits?: Partial<WorkLimits> | ((input: I) => Partial<WorkLimits>);
  /** A static policy or dynamic callback per failure/input. No callback goes into a row. */
  retry?: RetryDecision | ((context: RetryContext<I, R>) => RetryDecision | Promise<RetryDecision>);
  /** Preferred readable policy for non-failure waiting before this work resumes. */
  wait?: WorkTiming | ((context: RetryContext<I, R>) => WorkTiming | Promise<WorkTiming>);
  /** Standard queue synonym retained for compatibility; prefer `wait`. */
  defer?: WorkTiming | ((context: RetryContext<I, R>) => WorkTiming | Promise<WorkTiming>);
  /** Preferred readable planner for durable work that should run after this terminal result commits. */
  thenDo?: (context: {
    input: I;
    result: O;
    attempt: WorkAttempt;
    /** Terminal result that created this durable continuation. */
    outcome: 'succeed' | 'fail';
    /** Present only when a typed failure result planned the continuation. */
    reason?: R;
  }) => WorkRequest[] | Promise<WorkRequest[]>;
  /** Standard queue synonym retained for compatibility; prefer `thenDo`. */
  next?: (context: {
    input: I;
    result: O;
    attempt: WorkAttempt;
    outcome: 'succeed' | 'fail';
    reason?: R;
  }) => WorkRequest[] | Promise<WorkRequest[]>;
}
/** The durable identity and optional per-item limits supplied by a producer. */
export interface EnqueueOptions {
  /** A stable key for the business operation, not a random value on each retry. */
  key?: string;
  /** Initial not-before time. Duplicate enqueue never silently reschedules it. */
  availableAt?: number;
  /** Preferred readable per-item execution bounds; this does not throttle worker throughput. */
  executionLimits?: Partial<WorkLimits>;
  /** Standard internal synonym retained for compatibility; prefer `executionLimits`. */
  limits?: Partial<WorkLimits>;
}
/** One prepared payload to hand to a foreign/external worker while this attempt stays leased. */
export interface WorkHandoff<T> {
  /** Distinguishes a handoff from a terminal/waiting WorkOutcome. */
  type: 'handoff';
  /** Small worker payload; large source bytes stay in application storage. */
  input: T;
}
/** Wire-friendly lease returned only after the final owner-bound renewal commits. */
export interface LeasedWork<T> {
  /** Prepared application payload for the external worker. */
  input: T;
  /** Exact owner reference required by renew/settle. */
  attempt: AttemptRef;
  /** Storage-authoritative lease deadline in Unix milliseconds. */
  leaseUntil: number;
  /** Storage time observed with the final renewal. */
  observedAt: number;
}
/** Maps a preparation error to an ordinary queue outcome; application decides the reason. */
export type WorkHandoffErrorHandler<I, O, R extends string> = (
  run: WorkRun<I, O, R>,
  error: unknown,
) => WorkOutcome<O, R> | Promise<WorkOutcome<O, R>>;

/** Typed handle for one business item; it keeps key derivation out of every call site. */
export class WorkItem<I, O, R extends string> {
  /** Bind one typed business input and its stable key to concise item-level commands. */
  constructor(
    readonly queue: WorkQueue<I, O, R>,
    readonly input: I,
    readonly key: string,
  ) {}
  /** Build one inert request for durable follow-up planning without enqueueing it yet. */
  request(options: Omit<EnqueueOptions, 'key'> = {}): WorkRequest<I> {
    return this.queue.request(this.input, { ...options, key: this.key });
  }
  /** Ensure this business item exists exactly once and return its current durable snapshot. */
  enqueue(options: Omit<EnqueueOptions, 'key'> = {}): Promise<WorkSnapshot<I, O, R>> {
    return this.queue.enqueue(this.input, { ...options, key: this.key });
  }
  /** Inspect this business item's current durable execution state. */
  inspect(): Promise<WorkSnapshot<I, O, R> | undefined> {
    return this.queue.inspect(this.key);
  }
  /** Retry this item when its current generation failed and permits manual retry. */
  async retry(
    options: {
      expectedGeneration?: number;
      check?: (snapshot: WorkSnapshot<I, O, R>) => boolean | Promise<boolean>;
    } = {},
  ): Promise<WorkSnapshot<I, O, R>> {
    const current = await this.inspect();
    if (!current) throw new WorkConflict('not_found');
    if (
      options.expectedGeneration !== undefined &&
      current.generation !== options.expectedGeneration
    )
      throw new WorkConflict('generation_conflict');
    return this.queue.retry({
      key: this.key,
      generation: current.generation,
      ...(options.check ? { check: options.check } : {}),
    });
  }
  /** Rerun this item when its current generation already succeeded. */
  async rerun(
    options: {
      expectedGeneration?: number;
      check?: (snapshot: WorkSnapshot<I, O, R>) => boolean | Promise<boolean>;
    } = {},
  ): Promise<WorkSnapshot<I, O, R>> {
    const current = await this.inspect();
    if (!current) throw new WorkConflict('not_found');
    if (
      options.expectedGeneration !== undefined &&
      current.generation !== options.expectedGeneration
    )
      throw new WorkConflict('generation_conflict');
    return this.queue.rerun({
      key: this.key,
      generation: current.generation,
      ...(options.check ? { check: options.check } : {}),
    });
  }
  /** Generic terminal-state helper retained for compatibility; prefer explicit `retry` or `rerun`. */
  restart(
    options: {
      expectedGeneration?: number;
      check?: (snapshot: WorkSnapshot<I, O, R>) => boolean | Promise<boolean>;
    } = {},
  ): Promise<WorkSnapshot<I, O, R>> {
    return this.queue.restart({ key: this.key, ...options });
  }
  /** Cancel this item's current unfinished generation. */
  cancel(
    options: { expectedGeneration?: number; reason?: string } = {},
  ): Promise<{ snapshot: WorkSnapshot<I, O, R>; activeAttempt?: AttemptRef }> {
    return this.queue.cancelCurrent({ key: this.key, ...options });
  }
  /** Make this waiting item eligible immediately after the caller revalidated its prerequisite. */
  wake(options: { expectedGeneration?: number } = {}): Promise<WorkSnapshot<I, O, R>> {
    return this.queue.wakeCurrent({ key: this.key, ...options });
  }
}

/** An attempt's ergonomic facade. Outcome helpers are pure, renew/settle explicitly write. */
export class WorkRun<I, O, R extends string> {
  /** Fresh local cancellation signal supplied by the managed runner. */
  signal: AbortSignal = new AbortController().signal;
  /** Create one currently leased attempt facade; applications normally receive this from a runner. */
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
  /** End this attempt successfully and optionally attach durable follow-up work. */
  succeed(
    ...args: O extends null
      ? [result?: O, options?: FollowUpOptions]
      : [result: O, options?: FollowUpOptions]
  ): WorkOutcome<O, R> {
    return (args.length === 0 ? succeed() : succeed(args[0], args[1])) as WorkOutcome<O, R>;
  }
  /** End this attempt as a temporary failure that should be tried again later. */
  retry(reason: R, timing?: WorkTiming): WorkOutcome<O, R> {
    return retry(reason, timing);
  }
  /** Wait without counting a retry failure; this attempt ends and the work resumes later. */
  wait(reason: R, timing?: WorkTiming): WorkOutcome<O, R> {
    return wait(reason, timing);
  }
  /** Standard queue synonym retained for compatibility; prefer `wait`. */
  defer(reason: R, timing?: WorkTiming): WorkOutcome<O, R> {
    return defer(reason, timing);
  }
  /** End this attempt as a terminal failure, optionally allowing later manual retry. */
  fail(
    reason: R,
    options: { manualRetry?: boolean; result?: O } & FollowUpOptions = {},
  ): WorkOutcome<O, R> {
    return fail<R, O>(reason, options);
  }
  /** JSON transport contains only input, lease and store time, never store/configuration internals. */
  toJSON(): { input: I; attempt: WorkAttempt; observedAt: number } {
    return copy({ input: this.input, attempt: this.attempt, observedAt: this.observedAt });
  }
  /** Prepare data for a foreign worker without settling this attempt. */
  handoff<T>(input: T): WorkHandoff<T> {
    return { type: 'handoff', input: copy(input) };
  }
  /** Send a heartbeat that extends this attempt's lease when it is still authoritative. */
  heartbeat(): Promise<{ attempt: WorkAttempt; observedAt: number }> {
    return this.queue.heartbeat(this.ref);
  }
  /** Standard lease-renewal synonym retained for compatibility; prefer `heartbeat`. */
  renew(): Promise<{ attempt: WorkAttempt; observedAt: number }> {
    return this.heartbeat();
  }
  /** Commit one pure outcome if this attempt still owns the work. */
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
  /** Create one typed work-kind facade over the shared authoritative store. */
  constructor(
    readonly store: WorkStore,
    readonly scope: string,
    readonly kind: string,
    readonly definition: WorkDefinition<I, R, O>,
  ) {}
  /** Resolve one stable business key from an explicit option or this typed definition. */
  key(input: I, explicit?: string): string {
    const key = explicit ?? this.definition.key?.(input);
    if (!key) throw new WorkConflict('key_conflict');
    return key;
  }
  /** Bind typed input once, then use concise item-level commands. */
  item(input: I, explicitKey?: string): WorkItem<I, O, R> {
    return new WorkItem(this, input, this.key(input, explicitKey));
  }
  /** Resolve definition-level execution bounds while rejecting competing alias values. */
  private resolveExecutionLimits(input: I): Partial<WorkLimits> | undefined {
    if (this.definition.executionLimits !== undefined && this.definition.limits !== undefined)
      throw new RangeError('Use executionLimits or limits, not both');
    const configured = this.definition.executionLimits ?? this.definition.limits;
    return typeof configured === 'function' ? configured(input) : configured;
  }
  /** Resolve per-enqueue execution bounds while rejecting competing alias values. */
  private resolveEnqueueExecutionLimits(options: EnqueueOptions): Partial<WorkLimits> | undefined {
    if (options.executionLimits !== undefined && options.limits !== undefined)
      throw new RangeError('Use executionLimits or limits, not both');
    return options.executionLimits ?? options.limits;
  }
  /** Resolve the preferred wait policy and legacy synonym without allowing both. */
  private waitPolicy(): WorkDefinition<I, R, O>['wait'] {
    if (this.definition.wait !== undefined && this.definition.defer !== undefined)
      throw new RangeError('Use wait or defer, not both');
    return this.definition.wait ?? this.definition.defer;
  }
  /** Resolve the preferred follow-up planner and legacy synonym without allowing both. */
  private thenDoPolicy(): WorkDefinition<I, R, O>['thenDo'] {
    if (this.definition.thenDo !== undefined && this.definition.next !== undefined)
      throw new RangeError('Use thenDo or next, not both');
    return this.definition.thenDo ?? this.definition.next;
  }
  /** Create an inert follow-up description. It does not enqueue until success is durably accepted. */
  request(input: I, options: EnqueueOptions = {}): WorkRequest<I> {
    const key = this.key(input, options.key);
    return copy({
      id: workId(this.scope, this.kind, key),
      scope: this.scope,
      kind: this.kind,
      key,
      definition: this.definition.version ?? '1',
      input,
      limits: {
        ...defaults,
        ...this.resolveExecutionLimits(input),
        ...this.resolveEnqueueExecutionLimits(options),
      },
      availableAt: options.availableAt ?? 0,
    });
  }
  /** Atomic create-or-return. Same key plus different payload/limits is not a retry. */
  async enqueue(input: I, options: EnqueueOptions = {}): Promise<WorkSnapshot<I, O, R>> {
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
      definition: this.definition.version ?? '1',
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
  /**
   * Claim and prepare work for a foreign worker. The application callback owns only domain
   * readiness/payload; WorkOnce owns per-item claim, wait/fail settlement, final renewal and
   * stale-attempt handling.
   */
  async handoff<T>(
    options: { workerId: string; limit?: number },
    prepare: (
      run: WorkRun<I, O, R>,
    ) => WorkHandoff<T> | WorkOutcome<O, R> | Promise<WorkHandoff<T> | WorkOutcome<O, R>>,
    onError: WorkHandoffErrorHandler<I, O, R>,
  ): Promise<LeasedWork<T>[]> {
    const leases: LeasedWork<T>[] = [];
    for (const run of await this.claim(options)) {
      try {
        const prepared = await prepare(run);
        if (prepared.type !== 'handoff') {
          await run.settle(prepared);
          continue;
        }
        const renewed = await run.heartbeat();
        leases.push({
          input: prepared.input,
          attempt: run.ref,
          leaseUntil: renewed.attempt.leaseUntil,
          observedAt: renewed.observedAt,
        });
      } catch (error) {
        if (error instanceof WorkConflict) continue;
        try {
          await run.settle(await onError(run, error));
        } catch (settleError) {
          if (!(settleError instanceof WorkConflict)) throw settleError;
        }
      }
    }
    return leases;
  }
  /** Preferred readable heartbeat operation; extends only the current authoritative lease. */
  heartbeat(ref: AttemptRef): Promise<{ attempt: WorkAttempt; observedAt: number }> {
    return this.renew(ref);
  }
  /** Low-level lease-renewal operation retained for distributed-systems terminology compatibility. */
  async renew(ref: AttemptRef): Promise<{ attempt: WorkAttempt; observedAt: number }> {
    return this.store.atomic(ref.workId, (row, now) => {
      this.requireRow(row);
      const next = renewRecord(row, ref, now);
      if (next.phase.state !== 'running') throw new WorkConflict('stale_attempt');
      if (row.phase.state !== 'running') throw new WorkConflict('stale_attempt');
      return {
        next,
        validUntil: row.phase.attempt.leaseUntil,
        value: { attempt: next.phase.attempt, observedAt: now },
      };
    });
  }
  /**
   * Resolve dynamic retry policy outside storage, then recheck ownership inside the commit.
   * There is intentionally no settle(async domainCallback) overload: that would imply false fencing.
   */
  async settle(ref: AttemptRef, outcome: WorkOutcome<O, R>): Promise<WorkPhase<O, R>> {
    let submitted = copy(outcome);
    const submissionHash = await createSubmissionHash(submitted);
    const current = await this.store.getMany([ref.workId]);
    const row = current.rows[0];
    this.requireRow(row);
    const replay = replayReceipt(row, ref, submissionHash);
    if (replay) return copy(replay) as WorkPhase<O, R>;
    assertCurrent(row, ref, current.now);
    let decision: RetryDecision | undefined;
    if (submitted.type === 'retry' || submitted.type === 'defer') {
      if (row.phase.state !== 'running') throw new WorkConflict('stale_attempt');
      const context: RetryContext<I, R> = {
        input: row.input as I,
        reason: submitted.reason,
        attempt: row.phase.attempt,
        retries: row.retries,
        deferrals: row.deferrals,
        elapsedMs: effectiveNow(row, current.now) - (row.firstStartedAt ?? current.now),
      };
      if (submitted.type === 'retry') {
        const policy = this.definition.retry ?? { retry: false, manualRetry: true };
        decision = typeof policy === 'function' ? await policy(context) : policy;
      } else if (submitted.at === undefined && submitted.afterMs === undefined) {
        const policy = this.waitPolicy() ?? { afterMs: 1000 };
        const timing = typeof policy === 'function' ? await policy(context) : policy;
        submitted = { ...submitted, ...timing };
      }
    }
    const thenDo = this.thenDoPolicy();
    if (thenDo && submitted.type === 'succeed') {
      if (row.phase.state !== 'running') throw new WorkConflict('stale_attempt');
      const planned = await thenDo({
        input: row.input as I,
        result: submitted.result,
        attempt: row.phase.attempt,
        outcome: 'succeed',
      });
      submitted = { ...submitted, next: [...submitted.next, ...copy(planned)] };
    } else if (thenDo && submitted.type === 'fail' && submitted.result !== undefined) {
      if (row.phase.state !== 'running') throw new WorkConflict('stale_attempt');
      const result = submitted.result;
      const planned = await thenDo({
        input: row.input as I,
        result,
        attempt: row.phase.attempt,
        outcome: 'fail',
        reason: submitted.reason,
      });
      submitted = { ...submitted, next: [...submitted.next, ...copy(planned)] };
    }
    // Snapshot resolved policy so a caller cannot mutate it while a remote adapter is awaiting IO.
    const resolved = decision === undefined ? undefined : copy(decision);
    return this.store.atomic(ref.workId, (fresh, now) => {
      this.requireRow(fresh);
      const duplicate = replayReceipt(fresh, ref, submissionHash);
      if (duplicate) return { value: duplicate as WorkPhase<O, R> };
      const next = settleRecord(fresh, ref, submitted, submissionHash, resolved, now);
      if (fresh.phase.state !== 'running') throw new WorkConflict('stale_attempt');
      return {
        next,
        validUntil: fresh.phase.attempt.leaseUntil,
        value: next.phase as WorkPhase<O, R>,
      };
    });
  }
  /** Inspect a key. This is not authorization; expose only app-authorized keys over your transport. */
  async inspect(key: string): Promise<WorkSnapshot<I, O, R> | undefined> {
    return (await this.inspectMany([key]))[0];
  }
  /** Read an authenticated worker's opaque id; scope/kind/version are still checked by the queue. */
  async inspectId(id: string): Promise<WorkSnapshot<I, O, R> | undefined> {
    const result = await this.store.getMany([id]);
    const row = result.rows[0];
    if (row === undefined) return undefined;
    this.assertDefinition(row);
    return this.snapshot(row, result.now);
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
  /** Explicitly restart the current terminal generation: failed -> retry, succeeded -> rerun. */
  async restart(options: {
    key: string;
    expectedGeneration?: number;
    check?: (snapshot: WorkSnapshot<I, O, R>) => boolean | Promise<boolean>;
  }): Promise<WorkSnapshot<I, O, R>> {
    let expectedRevision: number | undefined;
    if (options.check) {
      const snapshot = await this.inspect(options.key);
      if (!snapshot) throw new WorkConflict('not_found');
      if (!(await options.check(snapshot))) throw new WorkConflict('retry_denied');
      expectedRevision = snapshot.revision;
    }
    return this.store.atomic(workId(this.scope, this.kind, options.key), (row, now) => {
      this.requireRow(row);
      if (expectedRevision !== undefined && row.revision !== expectedRevision)
        throw new WorkConflict('generation_conflict');
      if (options.expectedGeneration !== undefined && row.generation !== options.expectedGeneration)
        throw new WorkConflict('generation_conflict');
      const next =
        row.phase.state === 'failed'
          ? retryRecord(row, row.generation, now)
          : row.phase.state === 'succeeded'
            ? rerunRecord(row, row.generation, now)
            : undefined;
      if (!next) return { value: this.snapshot(row, now) };
      return { next, value: this.snapshot(next, now) };
    });
  }
  /** Cancel whatever unfinished generation is current and return the attempt that was running. */
  async cancelCurrent(options: {
    key: string;
    expectedGeneration?: number;
    reason?: string;
  }): Promise<{ snapshot: WorkSnapshot<I, O, R>; activeAttempt?: AttemptRef }> {
    return this.store.atomic(workId(this.scope, this.kind, options.key), (row, now) => {
      this.requireRow(row);
      if (options.expectedGeneration !== undefined && row.generation !== options.expectedGeneration)
        throw new WorkConflict('generation_conflict');
      const activeAttempt =
        row.phase.state === 'running'
          ? {
              workId: row.phase.attempt.workId,
              generation: row.phase.attempt.generation,
              fence: row.phase.attempt.fence,
            }
          : undefined;
      const next = cancelRecord(row, row.generation, options.reason ?? 'cancelled', now);
      return {
        ...(next === row ? {} : { next }),
        value: {
          snapshot: this.snapshot(next, now),
          ...(activeAttempt ? { activeAttempt } : {}),
        },
      };
    });
  }
  /** Wake the current queued/waiting generation after the caller revalidated its domain condition. */
  async wakeCurrent(options: {
    key: string;
    expectedGeneration?: number;
  }): Promise<WorkSnapshot<I, O, R>> {
    return this.store.atomic(workId(this.scope, this.kind, options.key), (row, clock) => {
      this.requireRow(row);
      if (options.expectedGeneration !== undefined && row.generation !== options.expectedGeneration)
        throw new WorkConflict('generation_conflict');
      const now = effectiveNow(row, clock);
      if (row.phase.state !== 'waiting' && row.phase.state !== 'queued')
        throw new WorkConflict('not_waiting');
      const next = changed(row, { ...row.phase, availableAt: now }, now, 'wake');
      return { next, value: this.snapshot(next, now) };
    });
  }
  /** Manual retry gate is evaluated now; pending prior follow-ups must drain before reset. */
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
  /** Explicitly rerun completed work only after its prior durable follow-ups have drained. */
  async rerun(options: {
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
      const next = rerunRecord(row, options.generation, now);
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
  // A delivery fairness cursor is only a scan optimization, never ownership or durable truth.
  let outboxAfterId: string | undefined;
  const work = {
    define<I, O = null, R extends string = string>(
      kind: string,
      definition: WorkDefinition<I, R, O> = {},
    ): WorkQueue<I, O, R> {
      return new WorkQueue(store, scope, kind, definition);
    },
    /** Recoverable outbox dispatch. Parent success and intent are atomic; child insertion is deduped. */
    async dispatch(options: { limit?: number } = {}): Promise<number> {
      const limit = integer(options.limit ?? 100, 'limit', 1);
      let result = await store.query({
        scope,
        select: 'outbox',
        limit,
        ...(outboxAfterId === undefined ? {} : { afterId: outboxAfterId }),
      });
      if (!result.rows.length && outboxAfterId !== undefined) {
        outboxAfterId = undefined;
        result = await store.query({ scope, select: 'outbox', limit });
      }
      if (!result.rows.length) return 0;
      let sent = 0;
      let attempted = 0;
      const failures: unknown[] = [];
      for (const parent of result.rows) {
        outboxAfterId = parent.id;
        for (const request of parent.outbox) {
          if (attempted >= limit) break;
          attempted++;
          try {
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
              if (!row.outbox.some((item) => item.id === request.id)) return { value: null };
              const next = changed(
                { ...row, outbox: row.outbox.filter((item) => item.id !== request.id) },
                row.phase,
                effectiveNow(row, clock),
                'dispatch',
              );
              return { next, value: null };
            });
            sent++;
          } catch (error) {
            failures.push(error);
            // Retain the failed intent but move it behind siblings, even with a one-child pass limit.
            try {
              await store.atomic(parent.id, (row, clock) => {
                if (!row || row.generation !== parent.generation || row.fence !== parent.fence)
                  return { value: null };
                const failed = row.outbox.find((item) => item.id === request.id);
                if (!failed || row.outbox.length < 2) return { value: null };
                const next = changed(
                  {
                    ...row,
                    outbox: [...row.outbox.filter((item) => item.id !== request.id), failed],
                  },
                  row.phase,
                  effectiveNow(row, clock),
                  'dispatch',
                );
                return { next, value: null };
              });
            } catch {
              /* Rotation improves fairness only; the original durable intent and error remain. */
            }
          }
        }
        if (attempted >= limit) break;
      }
      // A poison child stays visible, but cannot stop healthy siblings or the next scan page.
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, 'Some follow-up deliveries failed');
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
