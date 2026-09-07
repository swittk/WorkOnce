import type {
  AttemptRef,
  SettlementReceipt,
  WorkAttempt,
  WorkEvent,
  WorkLimits,
  WorkPhase,
  WorkRecord,
  WorkRequest,
} from './model.js';
import { dueAt, integer, workId } from './kernel.js';

const utf8 = new TextEncoder();

/** Match SQLite BINARY collation by comparing UTF-8 bytes instead of JavaScript UTF-16 code units. */
export function compareUtf8Text(left: string, right: string): number {
  const a = utf8.encode(left);
  const b = utf8.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const delta = a[index]! - b[index]!;
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

/** Built-in stores share the same write-shape contract as the public CAS adapter. */
export function validateStoreWrite(
  id: string,
  current: WorkRecord | undefined,
  next: WorkRecord,
  validUntil: number | undefined,
): void {
  if (next.id !== id) throw new Error('Store decision changed work identity');
  const expectedRevision = (current?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(next.revision) || next.revision !== expectedRevision) {
    throw new Error('Store decision must advance exactly one revision');
  }
  if (validUntil !== undefined) integer(validUntil, 'validUntil');
}

function invalidPersistedRow(): never {
  throw new Error('Invalid persisted WorkOnce row');
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidPersistedRow();
  return value as Record<string, unknown>;
}
function stringValue(value: unknown): string {
  if (typeof value !== 'string') invalidPersistedRow();
  return value;
}
function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') invalidPersistedRow();
  return value;
}
function int(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    invalidPersistedRow();
  return value;
}
function optionalInt(value: unknown, minimum = 0): number | undefined {
  return value === undefined ? undefined : int(value, minimum);
}
function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : stringValue(value);
}

function validateLimits(value: unknown): asserts value is WorkLimits {
  const limits = object(value);
  int(limits.leaseMs, 1);
  int(limits.maxAttempts, 1);
  int(limits.maxElapsedMs, 1);
  int(limits.maxDeferrals);
}
function validateRequest(value: unknown): asserts value is WorkRequest {
  const row = object(value);
  const id = stringValue(row.id);
  const scope = stringValue(row.scope);
  const kind = stringValue(row.kind);
  const key = stringValue(row.key);
  stringValue(row.definition);
  validateLimits(row.limits);
  int(row.availableAt);
  if (!Object.prototype.hasOwnProperty.call(row, 'input')) invalidPersistedRow();
  if (id !== workId(scope, kind, key)) invalidPersistedRow();
}
function validateAttemptRef(value: unknown): asserts value is AttemptRef {
  const attempt = object(value);
  stringValue(attempt.workId);
  int(attempt.generation, 1);
  int(attempt.fence);
}
function validateAttempt(value: unknown): asserts value is WorkAttempt {
  validateAttemptRef(value);
  const attempt = value as unknown as Record<string, unknown>;
  stringValue(attempt.workerId);
  int(attempt.number, 1);
  int(attempt.leaseUntil);
}
const stoppedByValues = new Set([
  'reported_failure',
  'retry_not_allowed',
  'retry_budget_exhausted',
  'attempt_budget_exhausted',
  'deadline_exceeded',
  'deferral_budget_exhausted',
]);
function validatePhase(value: unknown): asserts value is WorkPhase {
  const phase = object(value);
  const state = stringValue(phase.state);
  switch (state) {
    case 'queued':
      int(phase.availableAt);
      return;
    case 'running':
      validateAttempt(phase.attempt);
      int(phase.startedAt);
      return;
    case 'waiting':
      if (phase.cause !== 'retry' && phase.cause !== 'defer') invalidPersistedRow();
      stringValue(phase.reason);
      int(phase.availableAt);
      return;
    case 'succeeded':
      if (!Object.prototype.hasOwnProperty.call(phase, 'result')) invalidPersistedRow();
      int(phase.completedAt);
      return;
    case 'failed':
      stringValue(phase.reason);
      booleanValue(phase.manualRetry);
      int(phase.failedAt);
      if (!stoppedByValues.has(stringValue(phase.stoppedBy))) invalidPersistedRow();
      return;
    case 'cancelled':
      stringValue(phase.reason);
      int(phase.cancelledAt);
      return;
    default:
      invalidPersistedRow();
  }
}
function validateReceipt(
  value: unknown,
  workId: string,
  generation: number,
): asserts value is SettlementReceipt {
  const receipt = object(value);
  validateAttemptRef(receipt.attempt);
  const attempt = receipt.attempt as AttemptRef;
  if (attempt.workId !== workId || attempt.generation !== generation) invalidPersistedRow();
  if (!/^[a-f0-9]{64}$/u.test(stringValue(receipt.submissionHash))) invalidPersistedRow();
  if (receipt.phase !== undefined) validatePhase(receipt.phase);
}
function validateEvent(value: unknown): asserts value is WorkEvent {
  const event = object(value);
  int(event.at);
  int(event.generation, 1);
  int(event.fence);
  stringValue(event.action);
  const state = stringValue(event.state);
  if (!['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'].includes(state))
    invalidPersistedRow();
  optionalString(event.reason);
  optionalString(event.workerId);
}

/** Validate persistence-owned control fields before the lifecycle kernel consumes restored data. */
export function validateWorkRecord(value: unknown): asserts value is WorkRecord {
  validateRequest(value);
  const row = value as unknown as Record<string, unknown>;
  int(row.revision, 1);
  const generation = int(row.generation, 1);
  const fence = int(row.fence);
  const attempts = int(row.attempts);
  int(row.retries);
  const deferrals = int(row.deferrals);
  const limits = row.limits as WorkLimits;
  if (attempts > limits.maxAttempts || deferrals > limits.maxDeferrals) invalidPersistedRow();
  optionalInt(row.firstStartedAt);
  int(row.createdAt);
  int(row.updatedAt);
  validatePhase(row.phase);
  const phase = row.phase as WorkPhase;
  if (phase.state === 'running') {
    if (
      phase.attempt.workId !== row.id ||
      phase.attempt.generation !== generation ||
      phase.attempt.fence !== fence ||
      phase.attempt.number !== attempts
    )
      invalidPersistedRow();
  }
  if (row.receipt !== undefined) validateReceipt(row.receipt, stringValue(row.id), generation);
  if (!Array.isArray(row.outbox)) invalidPersistedRow();
  if (row.outbox.length > 0 && phase.state !== 'succeeded' && phase.state !== 'failed')
    invalidPersistedRow();
  for (const request of row.outbox) validateRequest(request);
  if (!Array.isArray(row.history) || row.history.length > 128) invalidPersistedRow();
  for (const event of row.history) validateEvent(event);
}

/** Parse one SQLite JSON body without leaking malformed persisted contents into errors. */
export function parsePersistedWorkRecord(body: unknown): WorkRecord {
  try {
    const value = JSON.parse(String(body)) as unknown;
    validateWorkRecord(value);
    return value;
  } catch {
    invalidPersistedRow();
  }
}

/** Verify SQLite metadata columns still describe the same canonical row used by lifecycle code. */
export function validateStoredMetadata(
  row: WorkRecord,
  metadata: {
    id: unknown;
    scope: unknown;
    kind: unknown;
    definition: unknown;
    dueAt: unknown;
    pendingNext: unknown;
  },
): void {
  if (
    metadata.id !== row.id ||
    metadata.scope !== row.scope ||
    metadata.kind !== row.kind ||
    metadata.definition !== row.definition
  )
    invalidPersistedRow();
  const expectedDue = dueAt(row) ?? null;
  const actualDue = metadata.dueAt === null ? null : int(metadata.dueAt);
  if (actualDue !== expectedDue || int(metadata.pendingNext) !== row.outbox.length)
    invalidPersistedRow();
}
