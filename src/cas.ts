import type { StoreChange, WorkQuery, WorkStore } from './storage.js';
import type { WorkRecord } from './model.js';
import { copy, integer } from './kernel.js';
import { validateStoreWrite } from './storage-validation.js';
/** A native compare-and-swap write. Revision and deadline are checked by storage, not JavaScript. */
export interface CompareExchange {
  /** Stable item identity. */
  id: string;
  /** Undefined means insert only if absent. Otherwise match this exact revision. */
  expectedRevision: number | undefined;
  /** Complete next row prepared by the pure kernel. */
  next: WorkRecord;
  /** Reject atomically when the storage clock is at or after this deadline. */
  validUntil?: number;
}
/**
 * Implement once per backing store, then share it across all work kinds. There are no domain
 * classes or queue-specific row mappings here. Failed/unknown writes must throw; return false
 * only when storage proved that this exact comparison did not commit.
 */
export interface CompareExchangePort {
  /**
   * Detached reads in caller order, with the trusted storage clock (including empty reads).
   * Per-id values must be valid; cross-id transactional snapshot isolation is not required.
   */
  getMany(ids: readonly string[]): Promise<{ rows: (WorkRecord | undefined)[]; now: number }>;
  /** Indexed discovery. Scope/kind/definition and the limit must be applied in storage. */
  query(query: WorkQuery): Promise<{ rows: WorkRecord[]; now: number }>;
  /** Durable atomic insert or revision-and-time-checked replacement. No unconditional fallback. */
  compareExchange(change: CompareExchange): Promise<boolean>;
}
/**
 * Retry ordinary version contention without reimplementing a work state machine in the adapter.
 * A network failure propagates as an unknown outcome: do not rerun external effects in this loop.
 */
export function createCompareExchangeStore(
  port: CompareExchangePort,
  options: { maxConflicts?: number } = {},
): WorkStore {
  const maxConflicts = integer(options.maxConflicts ?? 100, 'maxConflicts', 1);
  return {
    async atomic<T>(
      id: string,
      decide: (row: WorkRecord | undefined, now: number) => StoreChange<T>,
    ): Promise<T> {
      for (let conflicts = 0; conflicts < maxConflicts; conflicts++) {
        const observed = await port.getMany([id]);
        const current = observed.rows[0];
        const expectedRevision = current?.revision;
        const change = decide(current === undefined ? undefined : copy(current), observed.now);
        const value = copy(change.value);
        if (change.next === undefined) return value;
        const next = copy(change.next);
        validateStoreWrite(id, current, next, change.validUntil);
        const applied = await port.compareExchange({
          id,
          expectedRevision,
          next,
          ...(change.validUntil === undefined ? {} : { validUntil: change.validUntil }),
        });
        if (applied) return value;
      }
      throw new Error('Work store remained contended; retry the command, not the external effect');
    },
    getMany: (ids) => port.getMany(ids),
    query: (query) => port.query(query),
  };
}
