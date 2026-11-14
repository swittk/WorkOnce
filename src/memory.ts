import type { WorkStore, WorkQuery, StoreChange } from './storage.js';
import type { WorkRecord } from './model.js';
import { copy, dueAt, expiresAt, integer, WorkConflict } from './kernel.js';
import { compareUtf8Text, validateStoreDelete, validateStoreWrite } from './storage-validation.js';
/** Reference store only: detached rows and per-item atomic transitions, but no crash durability. */
export function createMemoryStore(options: { now?: () => number } = {}): WorkStore {
  const rows = new Map<string, WorkRecord>();
  const now = options.now ?? Date.now;
  return {
    retention: true,
    async atomic<T>(
      id: string,
      decide: (row: WorkRecord | undefined, now: number) => StoreChange<T>,
    ): Promise<T> {
      const current = rows.get(id);
      // No await is allowed between observing the row and applying the synchronous decision.
      const clock = integer(now(), 'clock');
      const change = decide(current ? copy(current) : undefined, clock);
      const value = copy(change.value);
      if (change.next !== undefined && change.delete === true)
        throw new Error('Store decision cannot replace and delete work together');
      if (change.delete === true) {
        validateStoreDelete(id, current, clock);
        if (!rows.delete(id)) throw new Error('Atomic work deletion did not remove its row');
      } else if (change.next !== undefined) {
        validateStoreWrite(id, current, change.next, change.validUntil);
        const next = copy(change.next);
        if (change.validUntil !== undefined && integer(now(), 'clock') >= change.validUntil)
          throw new WorkConflict('lease_expired');
        rows.set(id, next);
      }
      return value;
    },
    async getMany(ids) {
      return {
        rows: ids.map((id) => {
          const row = rows.get(id);
          return row ? copy(row) : undefined;
        }),
        now: integer(now(), 'clock'),
      };
    },
    async query(query: WorkQuery) {
      const clock = integer(now(), 'clock');
      integer(query.limit, 'limit', 1);
      if ((query.select === 'due' || query.select === 'expired') && query.afterId !== undefined)
        throw new RangeError(`afterId is not supported for ${query.select} queries`);
      let selected = [...rows.values()].filter(
        (row) =>
          row.scope === query.scope &&
          (query.kind === undefined || row.kind === query.kind) &&
          (query.definition === undefined || row.definition === query.definition),
      );
      if (query.select === 'due')
        selected = selected.filter((row) => (dueAt(row) ?? Infinity) <= clock);
      if (query.select === 'expired')
        selected = selected.filter((row) => (expiresAt(row) ?? Infinity) <= clock);
      if (query.select === 'outbox') selected = selected.filter((row) => row.outbox.length > 0);
      if (query.afterId !== undefined)
        selected = selected.filter((row) => compareUtf8Text(row.id, query.afterId!) > 0);
      selected.sort((a, b) => {
        if (query.select === 'due' || query.select === 'expired') {
          const left = query.select === 'due' ? dueAt(a)! : expiresAt(a)!;
          const right = query.select === 'due' ? dueAt(b)! : expiresAt(b)!;
          if (left !== right) return left < right ? -1 : 1;
        }
        return compareUtf8Text(a.id, b.id);
      });
      return { rows: selected.slice(0, query.limit).map(copy), now: clock };
    },
  };
}
