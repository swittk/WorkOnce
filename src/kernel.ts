import type {
  AttemptRef,
  RetryDecision,
  WorkOutcome,
  WorkPhase,
  WorkRecord,
  WorkRequest,
} from './model.js';
export type { AttemptRef, WorkAttempt, WorkOutcome, WorkRecord, WorkRequest } from './model.js';
/** Expected conflicts have stable codes, not message parsing. */
export class WorkConflict extends Error {
  /** Create one typed WorkOnce conflict that callers may branch on without message parsing. */
  constructor(
    readonly code:
      | 'not_found'
      | 'stale_attempt'
      | 'lease_expired'
      | 'settlement_conflict'
      | 'key_conflict'
      | 'retry_denied'
      | 'generation_conflict'
      | 'definition_changed'
      | 'not_waiting',
  ) {
    super(code);
    this.name = 'WorkConflict';
  }
}
/** Guard arithmetic invariants; this is not runtime rechecking of developer string types. */
export function integer(value: number, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
  return value;
}
/** Add durations without silently overflowing the timestamp/fence range. */
function add(a: number, b: number): number {
  return integer(a + b, 'sum');
}
/** Stable JSON encoding rejects values that would silently change at the persistence boundary. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const row = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(row)
        .filter((key) => row[key] !== undefined)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(row[key]))
        .join(',') +
      '}'
    );
  }
  throw new TypeError(
    'Work payloads must be JSON data; use explicit strings for dates and large integers',
  );
}
/** Detached JSON values prevent handlers or adapters from mutating saved state by alias. */
export function copy<T>(value: T): T {
  return JSON.parse(canonical(value)) as T;
}
/** Caller keys are encoded, not delimiter-concatenated. */
export function workId(scope: string, kind: string, key: string): string {
  return JSON.stringify([scope, kind, key]).replace(
    /[^\x20-\x7e]/g,
    (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}
/** A request identity never silently changes its meaning when submitted twice. */
export function sameRequest(row: WorkRequest, request: WorkRequest): boolean {
  return (
    row.id === request.id &&
    row.definition === request.definition &&
    canonical(row.input) === canonical(request.input) &&
    canonical(row.limits) === canonical(request.limits)
  );
}
/** Construct the first row inside storage's atomic insertion boundary. */
export function createRecord(request: WorkRequest, now: number): WorkRecord {
  integer(now, 'now');
  integer(request.availableAt, 'availableAt');
  integer(request.limits.leaseMs, 'leaseMs', 1);
  integer(request.limits.maxAttempts, 'maxAttempts', 1);
  integer(request.limits.maxElapsedMs, 'maxElapsedMs', 1);
  integer(request.limits.maxDeferrals, 'maxDeferrals');
  // Reject impossible timestamp arithmetic before an unclaimable item reaches storage.
  const earliestStart = Math.max(now, request.availableAt);
  add(earliestStart, request.limits.leaseMs);
  add(earliestStart, request.limits.maxElapsedMs);
  return {
    ...copy(request),
    revision: 1,
    generation: 1,
    fence: 0,
    attempts: 0,
    retries: 0,
    deferrals: 0,
    createdAt: now,
    updatedAt: now,
    phase: { state: 'queued', availableAt: request.availableAt },
    outbox: [],
    history: [{ at: now, generation: 1, fence: 0, action: 'enqueue', state: 'queued' }],
  };
}
/** Index value shared by native adapters. Expired leases are discoverable without a separate janitor. */
export function dueAt(row: WorkRecord): number | undefined {
  switch (row.phase.state) {
    case 'queued':
    case 'waiting':
      return row.phase.availableAt;
    case 'running':
      return row.phase.attempt.leaseUntil;
    default:
      return undefined;
  }
}
/** A single clock is used per atomic operation. Clock rollback never rewinds one item. */
export function effectiveNow(row: WorkRecord, now: number): number {
  return Math.max(integer(now, 'now'), row.updatedAt);
}
/** Record the phase change and bound debug history without accumulating heartbeat noise. */
export function changed(
  row: WorkRecord,
  phase: WorkPhase,
  now: number,
  action: string,
): WorkRecord {
  const next = { ...row, revision: add(row.revision, 1), updatedAt: now, phase };
  if (action !== 'renew' && action !== 'dispatch')
    next.history = [
      ...row.history.slice(-127),
      {
        at: now,
        generation: row.generation,
        fence: row.fence,
        action,
        state: phase.state,
        ...('reason' in phase ? { reason: phase.reason } : {}),
        ...(phase.state === 'running' ? { workerId: phase.attempt.workerId } : {}),
      },
    ];
  return next;
}
/** Only the latest unexpired attempt may renew, settle, or report authoritative work state. */
export function assertCurrent(row: WorkRecord, ref: AttemptRef, now: number): void {
  if (
    row.id !== ref.workId ||
    row.generation !== ref.generation ||
    row.fence !== ref.fence ||
    row.phase.state !== 'running'
  )
    throw new WorkConflict('stale_attempt');
  if (row.phase.attempt.leaseUntil <= effectiveNow(row, now))
    throw new WorkConflict('lease_expired');
}
/** Claim or expire an exhausted item. A poisoned/exhausted candidate must not stop the rest of a batch. */
export function claimRecord(
  row: WorkRecord,
  workerId: string,
  clock: number,
): WorkRecord | undefined {
  const now = effectiveNow(row, clock);
  const due = dueAt(row);
  if (due === undefined || due > now) return undefined;
  if (row.attempts >= row.limits.maxAttempts)
    return changed(
      row,
      {
        state: 'failed',
        reason: row.phase.state === 'waiting' ? row.phase.reason : 'attempts_exhausted',
        manualRetry: true,
        failedAt: now,
        stoppedBy: 'attempt_budget_exhausted',
      },
      now,
      'exhaust',
    );
  if (row.firstStartedAt !== undefined && now >= add(row.firstStartedAt, row.limits.maxElapsedMs))
    return changed(
      row,
      {
        state: 'failed',
        reason: row.phase.state === 'waiting' ? row.phase.reason : 'deadline_exceeded',
        manualRetry: true,
        failedAt: now,
        stoppedBy: 'deadline_exceeded',
      },
      now,
      'exhaust',
    );
  const fence = add(row.fence, 1);
  const attempts = add(row.attempts, 1);
  return changed(
    { ...row, fence, attempts, firstStartedAt: row.firstStartedAt ?? now },
    {
      state: 'running',
      startedAt: now,
      attempt: {
        workId: row.id,
        generation: row.generation,
        fence,
        workerId,
        number: attempts,
        leaseUntil: Math.min(
          add(now, row.limits.leaseMs),
          add(row.firstStartedAt ?? now, row.limits.maxElapsedMs),
        ),
      },
    },
    now,
    row.phase.state === 'running' ? 'reclaim' : 'claim',
  );
}
/** Renewal cannot resurrect a lease which expired before the atomic operation. */
export function renewRecord(row: WorkRecord, ref: AttemptRef, clock: number): WorkRecord {
  const now = effectiveNow(row, clock);
  assertCurrent(row, ref, now);
  if (row.phase.state !== 'running') throw new WorkConflict('stale_attempt');
  return changed(
    row,
    {
      ...row.phase,
      attempt: {
        ...row.phase.attempt,
        leaseUntil: Math.min(
          add(now, row.limits.leaseMs),
          add(row.firstStartedAt ?? now, row.limits.maxElapsedMs),
        ),
      },
    },
    now,
    'renew',
  );
}
/** Recognize an identical delivery without rerunning dynamic policy or domain work. */
export function replayReceipt(
  row: WorkRecord,
  ref: AttemptRef,
  submissionHash: string,
): WorkPhase | undefined {
  if (row.id !== ref.workId || row.generation !== ref.generation)
    throw new WorkConflict('stale_attempt');
  if (row.receipt?.attempt.fence !== ref.fence) return undefined;
  if (row.receipt.submissionHash !== submissionHash) throw new WorkConflict('settlement_conflict');
  if (row.receipt.phase) return row.receipt.phase;
  if (row.phase.state === 'succeeded' || row.phase.state === 'failed') return row.phase;
  throw new WorkConflict('stale_attempt');
}
/** Pure settlement. Call it only inside an atomic store operation; it never invokes application callbacks. */
export function settleRecord(
  row: WorkRecord,
  ref: AttemptRef,
  outcome: WorkOutcome,
  submissionHash: string,
  decision: RetryDecision | undefined,
  clock: number,
): WorkRecord {
  const now = effectiveNow(row, clock);
  assertCurrent(row, ref, now);
  let phase: WorkPhase;
  let retries = row.retries;
  let deferrals = row.deferrals;
  switch (outcome.type) {
    case 'succeed': {
      const ids = new Set<string>();
      for (const request of outcome.next) {
        if (
          request.scope !== row.scope ||
          request.id === row.id ||
          request.id !== workId(request.scope, request.kind, request.key) ||
          ids.has(request.id)
        )
          throw new WorkConflict('key_conflict');
        createRecord(request, now);
        ids.add(request.id);
      }
      phase = { state: 'succeeded', result: copy(outcome.result), completedAt: now };
      break;
    }
    case 'fail': {
      const ids = new Set<string>();
      for (const request of outcome.next) {
        if (
          request.scope !== row.scope ||
          request.id === row.id ||
          request.id !== workId(request.scope, request.kind, request.key) ||
          ids.has(request.id)
        )
          throw new WorkConflict('key_conflict');
        createRecord(request, now);
        ids.add(request.id);
      }
      phase = {
        state: 'failed',
        reason: outcome.reason,
        manualRetry: outcome.manualRetry,
        failedAt: now,
        ...(outcome.result === undefined ? {} : { result: copy(outcome.result) }),
        stoppedBy: 'reported_failure',
      };
      break;
    }
    case 'retry':
    case 'defer': {
      const isRetry = outcome.type === 'retry';
      if (isRetry && !decision) throw new Error('Missing resolved retry decision');
      const manualRetry = decision?.manualRetry ?? true;
      const deadline = add(row.firstStartedAt ?? now, row.limits.maxElapsedMs);
      const delay = outcome.afterMs ?? (decision?.retry ? decision.afterMs : 1000);
      integer(delay, 'afterMs');
      if (outcome.at !== undefined && outcome.afterMs !== undefined)
        throw new RangeError('Use at or afterMs, not both');
      const availableAt = Math.max(
        now,
        outcome.at === undefined ? add(now, delay) : integer(outcome.at, 'at'),
      );
      const denied =
        isRetry && (!decision?.retry || row.retries >= integer(decision.maxRetries, 'maxRetries'));
      const exhausted = row.attempts >= row.limits.maxAttempts || availableAt >= deadline;
      const tooManyDeferrals = !isRetry && row.deferrals >= row.limits.maxDeferrals;
      if (denied || exhausted || tooManyDeferrals) {
        const stoppedBy =
          isRetry && !decision?.retry
            ? 'retry_not_allowed'
            : denied
              ? 'retry_budget_exhausted'
              : row.attempts >= row.limits.maxAttempts
                ? 'attempt_budget_exhausted'
                : availableAt >= deadline
                  ? 'deadline_exceeded'
                  : 'deferral_budget_exhausted';
        phase = { state: 'failed', reason: outcome.reason, manualRetry, failedAt: now, stoppedBy };
      } else {
        if (isRetry) retries = add(retries, 1);
        else deferrals = add(deferrals, 1);
        phase = { state: 'waiting', cause: outcome.type, reason: outcome.reason, availableAt };
      }
      break;
    }
  }
  const next = changed({ ...row, retries, deferrals }, phase, now, outcome.type);
  next.receipt = {
    attempt: { workId: row.id, generation: ref.generation, fence: ref.fence },
    submissionHash,
    ...(phase.state === 'waiting' ? { phase: copy(phase) } : {}),
  };
  if (outcome.type === 'succeed' || outcome.type === 'fail') next.outbox = copy(outcome.next);
  return next;
}
/** Explicit retry uses a generation precondition and cannot discard prior durable follow-ups. */
export function retryRecord(row: WorkRecord, generation: number, clock: number): WorkRecord {
  if (row.generation !== generation) throw new WorkConflict('generation_conflict');
  if (row.phase.state !== 'failed' || !row.phase.manualRetry || row.outbox.length > 0)
    throw new WorkConflict('retry_denied');
  const now = effectiveNow(row, clock);
  const next = changed(
    {
      ...row,
      generation: add(row.generation, 1),
      attempts: 0,
      retries: 0,
      deferrals: 0,
    },
    { state: 'queued', availableAt: now },
    now,
    'manual_retry',
  );
  delete next.firstStartedAt;
  delete next.receipt;
  return next;
}
/** Explicit rerun waits for prior durable follow-ups; enqueue itself never revives completed work. */
export function rerunRecord(row: WorkRecord, generation: number, clock: number): WorkRecord {
  if (row.generation !== generation) throw new WorkConflict('generation_conflict');
  if (row.phase.state !== 'succeeded' || row.outbox.length > 0)
    throw new WorkConflict('retry_denied');
  const now = effectiveNow(row, clock);
  const next = changed(
    {
      ...row,
      generation: add(row.generation, 1),
      attempts: 0,
      retries: 0,
      deferrals: 0,
    },
    { state: 'queued', availableAt: now },
    now,
    'rerun',
  );
  delete next.firstStartedAt;
  delete next.receipt;
  return next;
}
/** Cancellation revokes authority; it is not proof that an external side effect stopped. */
export function cancelRecord(
  row: WorkRecord,
  generation: number,
  reason: string,
  clock: number,
): WorkRecord {
  if (row.generation !== generation) throw new WorkConflict('generation_conflict');
  if (
    row.phase.state === 'succeeded' ||
    row.phase.state === 'failed' ||
    row.phase.state === 'cancelled'
  )
    return row;
  const now = effectiveNow(row, clock);
  return changed(row, { state: 'cancelled', reason, cancelledAt: now }, now, 'cancel');
}
