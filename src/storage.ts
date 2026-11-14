import type { WorkRecord } from './model.js';
export type {
  WorkRecord,
  WorkRequest,
  WorkLimits,
  WorkAttempt,
  AttemptRef,
  WorkPhase,
} from './model.js';
/** One side-effect-free decision made inside the store's atomic boundary. */
export type StoreChange<T> =
  | {
      /** Omit when the decision should leave durable state unchanged. */
      next?: WorkRecord;
      /** A replacement and physical deletion can never be requested together. */
      delete?: never;
      /**
       * A storage-side exclusive deadline for this write; never accept an expired owner's commit.
       * Reject when the storage clock is at or after this value (`now >= validUntil`).
       */
      validUntil?: number;
      /** Value returned after the write is durably committed. */
      value: T;
    }
  | {
      /** Physical expiry removes the row instead of writing a hidden state or tombstone. */
      delete: true;
      /** Deletion cannot also provide a replacement row. */
      next?: never;
      /** Expiry deletion is storage-clock fenced by the row's indexed retention deadline. */
      validUntil?: never;
      /** Value returned after the deletion is durably committed. */
      value: T;
    };
/** Query capabilities required by the small queue. Implement with bounded indexed queries. */
export interface WorkQuery {
  /** Exact tenant/installation boundary. */
  scope: string;
  /** Omit only for a scope-wide outbox dispatcher. */
  kind?: string;
  /** Match the registered definition before applying LIMIT; older deployments cannot starve it. */
  definition?: string;
  /** Due includes claimable work; expired selects terminal rows whose retention deadline passed. */
  select: 'due' | 'outbox' | 'expired' | 'all';
  /** Bounded result count. */
  limit: number;
  /** Exclusive id cursor for `all`/`outbox`; time-ordered due/expired views reject it. */
  afterId?: string;
}
/**
 * BYO storage contract, not a CRUD interface. atomic must serialize each id across EVERY
 * process using the store and commit next durably before resolving. It supplies storage
 * time inside that boundary. Decisions must be deterministic for (row, now), without clocks,
 * randomness, IO or mutation of captured state. The synchronous decision must not await or perform effects;
 * adapters may retry it. A read/check/unconditional-save implementation is NOT conformant.
 * getMany/query return detached rows. Query ids and afterId use one UTF-8 byte-sequence order
 * (matching SQLite BINARY), never UTF-16 or locale collation. Only stores advertising retention
 * may physically delete finite rows, whose incarnation fences stale workers across id reuse.
 */
export interface WorkStore {
  /** True only when atomic physical deletion and indexed expiry discovery are implemented. */
  readonly retention?: true;
  /** Serialize one deterministic transition; durably replace or delete only when explicitly requested. */
  atomic<T>(
    id: string,
    decide: (row: WorkRecord | undefined, now: number) => StoreChange<T>,
  ): Promise<T>;
  /**
   * Read exact ids in caller order together with one storage-time observation. The result has
   * exactly one slot per requested id, including repeated ids. Rows must each be a valid detached
   * value, but the contract does not require one cross-id transactional snapshot while concurrent
   * writers run; an adapter may document a stronger guarantee.
   */
  getMany(ids: readonly string[]): Promise<{ rows: (WorkRecord | undefined)[]; now: number }>;
  /** Query a bounded indexed work view; candidate discovery never grants ownership by itself. */
  query(query: WorkQuery): Promise<{ rows: WorkRecord[]; now: number }>;
}
