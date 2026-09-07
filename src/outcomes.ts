import { copy } from './kernel.js';
import type { WorkOutcome, WorkRequest } from './model.js';

/** Relative and absolute scheduling are mutually exclusive. */
export type WorkTiming = { afterMs: number; at?: never } | { at: number; afterMs?: never };

/** Durable follow-up work requested after this terminal result commits. */
export interface FollowUpOptions {
  /** Preferred readable name for durable work that should be created after this result commits. */
  thenDo?: WorkRequest[];
  /** Standard queue/internal synonym retained for compatibility; prefer `thenDo`. */
  next?: WorkRequest[];
}

/** Resolve the readable and legacy follow-up names without permitting two competing lists. */
function followUps(options: FollowUpOptions): WorkRequest[] {
  if (options.thenDo !== undefined && options.next !== undefined) {
    throw new RangeError('Use thenDo or next, not both');
  }
  return options.thenDo ?? options.next ?? [];
}

/** Success commits its result plus any durable follow-up work. */
export function succeed(): Extract<WorkOutcome<null>, { type: 'succeed' }>;
/** Success commits its typed result plus any durable follow-up work. */
export function succeed<O>(
  result: O,
  options?: FollowUpOptions,
): Extract<WorkOutcome<O>, { type: 'succeed' }>;
/** Construct a pure success outcome; calling this function never writes storage. */
export function succeed(
  result?: unknown,
  options: FollowUpOptions = {},
): Extract<WorkOutcome, { type: 'succeed' }> {
  return {
    type: 'succeed',
    result: arguments.length === 0 ? null : copy(result),
    next: followUps(options),
  };
}

/** Retry this failed work later, using definition policy unless timing is overridden here. */
export function retry<R extends string>(
  reason: R,
  timing?: WorkTiming,
): Extract<WorkOutcome<never, R>, { type: 'retry' }> {
  return { type: 'retry', reason, ...timing };
}

/** Wait without counting a failure retry; the current attempt ends and the work resumes later. */
export function wait<R extends string>(
  reason: R,
  timing?: WorkTiming,
): Extract<WorkOutcome<never, R>, { type: 'defer' }> {
  return { type: 'defer', reason, ...timing };
}

/** Standard queue synonym for `wait`; prefer `wait` in application code. */
export function defer<R extends string>(
  reason: R,
  timing?: WorkTiming,
): Extract<WorkOutcome<never, R>, { type: 'defer' }> {
  return wait(reason, timing);
}

/** A terminal failure is never automatically claimable; manual retry remains a separate command. */
export function fail<R extends string, O = never>(
  reason: R,
  options: { manualRetry?: boolean; result?: O } & FollowUpOptions = {},
): Extract<WorkOutcome<O, R>, { type: 'fail' }> {
  return {
    type: 'fail',
    reason,
    manualRetry: options.manualRetry ?? false,
    ...(options.result === undefined ? {} : { result: copy(options.result) }),
    next: followUps(options),
  };
}
