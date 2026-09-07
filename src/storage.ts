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
export interface StoreChange<T> {
  /** Omit when nothing should be persisted. Deletion is deliberately not supported. */
  next?: WorkRecord;
  /** A storage-side exclusive deadline for this write; never accept an expired owner's commit. */
  validUntil?: number;
  /** Value returned after the write is durably committed. */
  value: T;
}
/** Query capabilities required by the small queue. Implement with bounded indexed queries. */
export interface WorkQuery {
  /** Exact tenant/installation boundary. */
  scope: string;
  /** Omit only for a scope-wide outbox dispatcher. */
  kind?: string;
  /** Match the registered definition before applying LIMIT; older deployments cannot starve it. */
  definition?: string;
  /** Due work includes expired running attempts; outbox selects undelivered follow-ups. */
  select: 'due' | 'outbox' | 'all';
  /** Bounded result count. */
  limit: number;
  /** Exclusive id cursor for `all`/`outbox`; `due` rejects it because its ordering is (dueAt,id). */
  afterId?: string;
}
/**
 * BYO storage contract, not a CRUD interface. atomic must serialize each id across EVERY
 * process using the store and commit next durably before resolving. It supplies storage
 * time inside that boundary. Decisions must be deterministic for (row, now), without clocks,
 * randomness, IO or mutation of captured state. The synchronous decision must not await or perform effects;
 * adapters may retry it. A read/check/unconditional-save implementation is NOT conformant.
 * getMany/query return detached rows. Query ids and afterId use one UTF-8 byte-sequence order
 * (matching SQLite BINARY), never UTF-16 or locale collation. Never delete/reuse an id while stale
 * workers may exist.
 */
export interface WorkStore {
  /** Serialize one deterministic transition; commit durably only when its decision supplies `next`. */
  atomic<T>(
    id: string,
    decide: (row: WorkRecord | undefined, now: number) => StoreChange<T>,
  ): Promise<T>;
  /** Read exact ids in caller order together with one storage-time observation. */
  getMany(ids: readonly string[]): Promise<{ rows: (WorkRecord | undefined)[]; now: number }>;
  /** Query a bounded indexed work view; candidate discovery never grants ownership by itself. */
  query(query: WorkQuery): Promise<{ rows: WorkRecord[]; now: number }>;
}
