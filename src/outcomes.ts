import { copy } from './kernel.js';
import type { WorkOutcome, WorkRequest } from './model.js';
/** Relative and absolute scheduling are mutually exclusive. */
export type WorkTiming = { afterMs: number; at?: never } | { at: number; afterMs?: never };
/** Success commits result plus durable follow-up descriptions, never a best-effort callback. */
export function succeed(): Extract<WorkOutcome<null>, { type: 'succeed' }>;
export function succeed<O>(
  result: O,
  options?: { next?: WorkRequest[] },
): Extract<WorkOutcome<O>, { type: 'succeed' }>;
export function succeed(
  result?: unknown,
  options: { next?: WorkRequest[] } = {},
): Extract<WorkOutcome, { type: 'succeed' }> {
  return {
    type: 'succeed',
    result: arguments.length === 0 ? null : copy(result),
    next: options.next ?? [],
  };
}
/** Retry timing defaults to the work-kind policy, which also owns the retry budget. */
export function retry<R extends string>(
  reason: R,
  timing?: WorkTiming,
): Extract<WorkOutcome<never, R>, { type: 'retry' }> {
  return { type: 'retry', reason, ...timing };
}
/** A prerequisite wait releases the lease and does not count as an automatic failure retry. */
export function defer<R extends string>(
  reason: R,
  timing?: WorkTiming,
): Extract<WorkOutcome<never, R>, { type: 'defer' }> {
  return { type: 'defer', reason, ...timing };
}
/** A terminal failure is never automatically claimable. Manual retry is a separate checked command. */
export function fail<R extends string, O = never>(
  reason: R,
  options: { manualRetry?: boolean; result?: O; next?: WorkRequest[] } = {},
): Extract<WorkOutcome<O, R>, { type: 'fail' }> {
  return {
    type: 'fail',
    reason,
    manualRetry: options.manualRetry ?? false,
    ...(options.result === undefined ? {} : { result: copy(options.result) }),
    next: options.next ?? [],
  };
}
