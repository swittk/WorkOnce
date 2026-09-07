import type { RetryDecision } from './model.js';
import { integer } from './kernel.js';

/** Configuration for deterministic exponential retry delays. */
export interface ExponentialBackoffOptions {
  /** Delay before the first retry. */
  initialDelayMs: number;
  /** Maximum delay between attempts; explicit capping keeps retry schedules bounded. */
  maxDelayMs: number;
  /** Delay multiplier applied after each accepted retry. Defaults to 2. */
  multiplier?: number;
  /** Maximum automatic retry decisions before work becomes failed. */
  maxRetries: number;
  /** Whether staff or trusted application code may manually retry after automatic retry stops. */
  manualRetry?: boolean;
}

/** Minimal retry-policy context accepted by the reusable backoff helper. */
export interface ExponentialBackoffContext {
  /** Number of automatic retries already accepted for this generation. */
  retries: number;
}

/**
 * Build a deterministic exponential retry policy. Compose it inside a larger callback when only
 * some reasons or inputs should retry; WorkOnce persists the accepted delay for each attempt.
 */
export function exponentialBackoff(
  options: ExponentialBackoffOptions,
): (context: ExponentialBackoffContext) => RetryDecision {
  const initialDelayMs = integer(options.initialDelayMs, 'initialDelayMs', 0);
  const maxDelayMs = integer(options.maxDelayMs, 'maxDelayMs', initialDelayMs);
  const maxRetries = integer(options.maxRetries, 'maxRetries', 0);
  const multiplier = options.multiplier ?? 2;
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    throw new RangeError('multiplier must be a finite number >= 1');
  }
  const manualRetry = options.manualRetry ?? true;
  return ({ retries }) => {
    integer(retries, 'retries', 0);
    const scaled = initialDelayMs * multiplier ** retries;
    const afterMs = Math.min(maxDelayMs, Number.isFinite(scaled) ? Math.ceil(scaled) : maxDelayMs);
    return { retry: true, afterMs, maxRetries, manualRetry };
  };
}
