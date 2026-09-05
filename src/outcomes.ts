import type { WorkOutcome, WorkRequest } from './model.js';
/** Relative and absolute scheduling are mutually exclusive. */
export type WorkTiming = { afterMs: number; at?: never } | { at: number; afterMs?: never };
/** Success commits result plus durable follow-up descriptions, never a best-effort callback. */
export function succeed(): WorkOutcome<null>;
export function succeed<O>(result: O, options?: { next?: WorkRequest[] }): WorkOutcome<O>;
export function succeed(
  result: unknown = null,
  options: { next?: WorkRequest[] } = {},
): WorkOutcome {
  return { type: 'succeed', result, next: options.next ?? [] };
}
/** Retry timing defaults to the work-kind policy, which also owns the retry budget. */
export function retry<R extends string>(reason: R, timing?: WorkTiming): WorkOutcome<never, R> {
  return { type: 'retry', reason, ...timing };
}
/** A prerequisite wait releases the lease and does not count as an automatic failure retry. */
export function defer<R extends string>(reason: R, timing: WorkTiming): WorkOutcome<never, R> {
  return { type: 'defer', reason, ...timing };
}
/** A terminal failure is never automatically claimable. Manual retry is a separate checked command. */
export function fail<R extends string>(
  reason: R,
  options: { manualRetry?: boolean } = {},
): WorkOutcome<never, R> {
  return { type: 'fail', reason, manualRetry: options.manualRetry ?? false };
}
