import type { StoreChange, WorkQuery, WorkStore } from './storage.js';
import type { WorkRecord } from './model.js';
import { copy, integer, WorkConflict } from './kernel.js';
import { validateStoreDelete, validateStoreWrite } from './storage-validation.js';
/** A native compare-and-swap write. Revision and deadline are checked by storage, not JavaScript. */
export interface CompareExchange {
  /** Stable item identity. */
  id: string;
  /** Undefined means insert only if absent. Otherwise match this exact revision. */
  expectedRevision: number | undefined;
  /**
   * Retention-capable ports compare exact creation identity, including undefined; it is never a
   * wildcard. Legacy permanent-only ports may ignore this additive field.
   */
  expectedIncarnation?: string;
  /** Complete next row prepared by the pure kernel. */
  next: WorkRecord;
  /** Reject atomically when the storage clock is at or after this deadline. */
  validUntil?: number;
}
/** Native physical deletion fenced against id-reuse ABA and premature storage time. */
export interface CompareDelete {
  /** Stable item identity to remove. */
  id: string;
  /** Exact revision observed before the deterministic delete decision. */
  expectedRevision: number;
  /** Exact creation identity; undefined means the stored row must also have no incarnation. */
  expectedIncarnation: string | undefined;
  /** Native storage time must be at or after this indexed retention deadline. */
  expiredAt: number;
}
/**
 * Implement once per backing store, then share it across all work kinds. There are no domain
 * classes or queue-specific row mappings here. Failed/unknown writes must throw; return false
 * only when storage proved that this exact comparison did not commit.
 */
export interface CompareExchangePort {
  /** Advertise only when compare and delete both enforce exact incarnation equality. */
  readonly retention?: true;
  /**
   * Detached reads in caller order, with exactly one result slot per requested id (including
   * duplicate ids) and the trusted storage clock. Per-id values must be valid; cross-id
   * transactional snapshot isolation is not required.
   */
  getMany(ids: readonly string[]): Promise<{ rows: (WorkRecord | undefined)[]; now: number }>;
  /** Indexed discovery. Scope/kind/definition and the limit must be applied in storage. */
  query(query: WorkQuery): Promise<{ rows: WorkRecord[]; now: number }>;
  /** Durable atomic insert or revision-and-time-checked replacement. No unconditional fallback. */
  compareExchange(change: CompareExchange): Promise<boolean>;
  /** Physically remove one exact expired incarnation; required when retention is advertised. */
  deleteExchange?(change: CompareDelete): Promise<boolean>;
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
  if (port.retention === true && port.deleteExchange === undefined)
    throw new TypeError('A retention-capable CAS port must implement deleteExchange');
  const supportsRetention = port.retention === true && port.deleteExchange !== undefined;
  return {
    ...(supportsRetention ? { retention: true as const } : {}),
    async atomic<T>(
      id: string,
      decide: (row: WorkRecord | undefined, now: number) => StoreChange<T>,
    ): Promise<T> {
      for (let conflicts = 0; conflicts < maxConflicts; conflicts++) {
        const observed = await port.getMany([id]);
        const current = observed.rows[0];
        const expectedRevision = current?.revision;
        const expectedIncarnation = current?.incarnation;
        const change = decide(current === undefined ? undefined : copy(current), observed.now);
        const value = copy(change.value);
        if (change.next !== undefined && change.delete === true)
          throw new Error('Store decision cannot replace and delete work together');
        if (change.delete === true) {
          if (!supportsRetention || port.deleteExchange === undefined)
            throw new WorkConflict('retention_unsupported');
          const expiredAt = validateStoreDelete(id, current, observed.now);
          const applied = await port.deleteExchange({
            id,
            expectedRevision: current!.revision,
            expectedIncarnation,
            expiredAt,
          });
          if (applied) return value;
          continue;
        }
        if (change.next === undefined) return value;
        const next = copy(change.next);
        if (
          !supportsRetention &&
          ((current?.retention !== undefined && current.retention !== 'forever') ||
            (next.retention !== undefined && next.retention !== 'forever'))
        )
          throw new WorkConflict('retention_unsupported');
        validateStoreWrite(id, current, next, change.validUntil);
        const applied = await port.compareExchange({
          id,
          expectedRevision,
          ...(expectedIncarnation === undefined ? {} : { expectedIncarnation }),
          next,
          ...(change.validUntil === undefined ? {} : { validUntil: change.validUntil }),
        });
        if (applied) return value;
        if (change.validUntil !== undefined) {
          const checked = await port.getMany([id]);
          const checkedRevision = checked.rows[0]?.revision;
          const checkedIncarnation = checked.rows[0]?.incarnation;
          if (
            checkedRevision === expectedRevision &&
            checkedIncarnation === expectedIncarnation &&
            checked.now >= change.validUntil
          )
            throw new WorkConflict('lease_expired');
        }
      }
      throw new Error('Work store remained contended; retry the command, not the external effect');
    },
    getMany: (ids) => port.getMany(ids),
    query: (query) => port.query(query),
  };
}
