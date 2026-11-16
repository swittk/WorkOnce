/** Lease and scheduling times are integer Unix milliseconds, never seconds. */
export interface WorkLimits {
  /** Duration of each renewable worker lease. */
  leaseMs: number;
  /** All claims count, including recovery after a worker dies. */
  maxAttempts: number;
  /** Per-generation wall-clock budget, starting with its first claim. */
  maxElapsedMs: number;
  /** Waiting for a prerequisite does not consume retry count, but is still bounded. */
  maxDeferrals: number;
}
/**
 * Authority rule for one persisted work item.
 * Commit-deadline: only commits made before leaseUntil may succeed.
 * Takeover-fenced: the deadline only makes reclaim eligible; the old owner may
 * still commit until an atomic reclaim/cancel/other transition revokes its fence.
 */
export type WorkLeaseMode = 'commit-deadline' | 'takeover-fenced';
/** How long a terminal item remains deduplicated before explicit maintenance deletes it. */
export type WorkRetention =
  | 'forever'
  | {
      /** Milliseconds after terminal completion; zero allows immediate eligible pruning. */
      afterTerminalMs: number;
    };
/** Durable work description. Input must survive a JSON round trip. No functions are stored. */
export interface WorkRequest<I = unknown> {
  /** Persisted lease authority rule; omitted means strict commit-deadline semantics. */
  leaseMode?: WorkLeaseMode;
  /** Persisted retention policy; omission is permanent retention. */
  retention?: WorkRetention;
  /** Unambiguous identity derived from scope, kind and caller key. */
  id: string;
  /** Application-controlled tenant or installation boundary. */
  scope: string;
  /** Named handler registered by application code. */
  kind: string;
  /** Caller idempotency key. Reusing it with different input is an error. */
  key: string;
  /** Named definition revision; deploy explicit changes rather than silently changing jobs. */
  definition: string;
  /** Small payload or object reference, not a file body. */
  input: I;
  /** Resolved bounds retained with the item. */
  limits: WorkLimits;
  /** Earliest first claim. */
  availableAt: number;
}
/** Carry this whole reference through an external executor. It is not an authentication credential. */
export interface AttemptRef {
  /** Creation identity carried unchanged by finite-retention workers, preventing ID-reuse ABA. */
  incarnation?: string;
  /** Exact durable work identity. */
  workId: string;
  /** Explicit staff retries advance the generation. */
  generation: number;
  /** Every claim advances this number; it is never reset on retry. */
  fence: number;
}
/** Debugging and renewal information for the current owner. */
export interface WorkAttempt extends AttemptRef {
  /** Operational label only; ownership is identified by generation and fence. */
  workerId: string;
  /** Claim number within this generation, including crashed attempts. */
  number: number;
  /** Storage-clock takeover eligibility; also a hard commit deadline in strict mode. */
  leaseUntil: number;
}
/** A typed snapshot contains only fields meaningful for its current phase. */
export type WorkPhase<O = unknown, R extends string = string> =
  | { state: 'queued'; availableAt: number }
  | { state: 'running'; attempt: WorkAttempt; startedAt: number }
  | { state: 'waiting'; cause: 'retry' | 'defer'; reason: R; availableAt: number }
  | { state: 'succeeded'; result: O; completedAt: number }
  | {
      state: 'failed';
      reason: R | 'attempts_exhausted' | 'deadline_exceeded';
      manualRetry: boolean;
      failedAt: number;
      /** Typed terminal diagnostic/result, when the handler supplied one. */
      result?: O;
      stoppedBy:
        | 'reported_failure'
        | 'retry_not_allowed'
        | 'retry_budget_exhausted'
        | 'attempt_budget_exhausted'
        | 'deadline_exceeded'
        | 'deferral_budget_exhausted';
    }
  | { state: 'cancelled'; reason: string; cancelledAt: number };
/** Compact transition history; heartbeats deliberately do not append events. */
export interface WorkEvent {
  /** Storage-clock time of the transition. */
  at: number;
  /** Generation at this transition. */
  generation: number;
  /** Latest claim fence. */
  fence: number;
  /** Operation and resulting phase. */
  action: string;
  /** Resulting execution phase. */
  state: WorkPhase['state'];
  /** Safe application reason code, not a raw exception or payload. */
  reason?: string;
  /** Claim/reclaim owner label so neighboring worker attempts are distinguishable. */
  workerId?: string;
}
/** Immutable acknowledgement for a repeated delivery from the latest settled attempt. */
export interface SettlementReceipt {
  /** Attempt that produced this acknowledgement. */
  attempt: AttemptRef;
  /** SHA-256 of the canonical submitted outcome, before dynamic policy resolution. */
  submissionHash: string;
  /** Non-terminal acknowledgement phase; terminal results already live in row.phase. */
  phase?: WorkPhase;
}
/** The adapter persists the complete row in one atomic operation. */
export interface WorkRecord extends WorkRequest {
  /** Fresh creation identity for finite retention, preserved across manual generations. */
  incarnation?: string;
  /** Advances on every persisted mutation, including renewals. */
  revision: number;
  /** Starts at one and advances only on explicit manual retry. */
  generation: number;
  /** Monotone across all generations. */
  fence: number;
  /** Claims in the current generation. */
  attempts: number;
  /** Accepted automatic retry decisions in this generation. */
  retries: number;
  /** Accepted deferrals in this generation. */
  deferrals: number;
  /** First claim time for the current generation; absent until claimed. */
  firstStartedAt?: number;
  /** Durable creation time. */
  createdAt: number;
  /** Last persisted mutation. */
  updatedAt: number;
  /** Current execution phase. */
  phase: WorkPhase;
  /** Latest settled attempt's exact acknowledgement; old generations are fenced, not replayed. */
  receipt?: SettlementReceipt;
  /** Follow-up requests saved atomically with success; dispatch uses their stable identities. */
  outbox: WorkRequest[];
  /** Recent transition history. The kernel retains the latest 128 transitions. */
  history: WorkEvent[];
}
/** Pure handler result. Calling an outcome helper does not write to storage. */
export type WorkOutcome<O = unknown, R extends string = string> =
  | { type: 'succeed'; result: O; next: WorkRequest[] }
  | { type: 'retry'; reason: R; afterMs?: number; at?: number }
  | { type: 'defer'; reason: R; afterMs?: number; at?: number }
  | { type: 'fail'; reason: R; manualRetry: boolean; result?: O; next: WorkRequest[] };
/** Resolved automatic retry policy for one actual failure, not a serialized callback. */
export type RetryDecision =
  | { retry: false; manualRetry: boolean }
  | { retry: true; afterMs: number; maxRetries: number; manualRetry: boolean };
/** Dynamic policy input. A callback may fetch application policy, but must not perform effects. */
export interface RetryContext<I, R extends string> {
  /** Typed original input, useful for priority or customer-specific policy. */
  input: I;
  /** Failure reported by the handler. */
  reason: R;
  /** Current generation and claim details. */
  attempt: WorkAttempt;
  /** Automatic retry decisions already accepted. */
  retries: number;
  /** Accepted prerequisite waits in the generation. */
  deferrals: number;
  /** Elapsed storage time since the first claim. */
  elapsedMs: number;
}
/** Read result with storage time for conservative lease timers in foreign workers. */
export interface WorkSnapshot<I = unknown, O = unknown, R extends string = string> {
  /** Work-specific lease authority rule; omission means strict commit-deadline. */
  leaseMode?: WorkLeaseMode;
  /** Supply this with guarded commands so a deleted/recreated key is never mistaken for this item. */
  incarnation?: string;
  /** Persisted finite retention; omission means the item is retained permanently. */
  retention?: WorkRetention;
  /** Idempotent business identity. */
  id: string;
  /** Caller key. */
  key: string;
  /** Persisted typed input. */
  input: I;
  /** Include this in manual retry commands to reject stale UI actions. */
  generation: number;
  /** Revision is useful for conditional UI actions. */
  revision: number;
  /** Claims started in the current generation, including reclaimed attempts. */
  attempts: number;
  /** Automatic failure retries already accepted in the current generation. */
  retries: number;
  /** Non-failure waits already accepted in the current generation. */
  deferrals: number;
  /** Discriminated execution state, separate from application review/approval state. */
  phase: WorkPhase<O, R>;
  /** How many durable follow-up requests remain to dispatch. */
  pendingFollowups: number;
  /** Time sampled by storage for this read. */
  observedAt: number;
}
