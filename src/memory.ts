import type { WorkStore, WorkQuery, StoreChange } from './storage.js';
import type { WorkRecord } from './model.js';
import { copy, dueAt, integer, WorkConflict } from './kernel.js';
import { compareUtf8Text, validateStoreWrite } from './storage-validation.js';
/** Reference store only: detached rows and per-item atomic transitions, but no crash durability. */
export function createMemoryStore(options: { now?: () => number } = {}): WorkStore {
  const rows = new Map<string, WorkRecord>();
  const now = options.now ?? Date.now;
  return {
    async atomic<T>(
      id: string,
      decide: (row: WorkRecord | undefined, now: number) => StoreChange<T>,
    ): Promise<T> {
      const current = rows.get(id);
      // No await is allowed between observing the row and applying the synchronous decision.
      const change = decide(current ? copy(current) : undefined, integer(now(), 'clock'));
      const value = copy(change.value);
      if (change.next) {
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
      if (query.select === 'due' && query.afterId !== undefined)
        throw new RangeError('afterId is not supported for due queries');
      let selected = [...rows.values()].filter(
        (row) =>
          row.scope === query.scope &&
          (query.kind === undefined || row.kind === query.kind) &&
          (query.definition === undefined || row.definition === query.definition),
      );
      if (query.select === 'due')
        selected = selected.filter((row) => (dueAt(row) ?? Infinity) <= clock);
      if (query.select === 'outbox') selected = selected.filter((row) => row.outbox.length > 0);
      if (query.afterId !== undefined)
        selected = selected.filter((row) => compareUtf8Text(row.id, query.afterId!) > 0);
      selected.sort((a, b) =>
        query.select === 'due'
          ? dueAt(a)! - dueAt(b)! || compareUtf8Text(a.id, b.id)
          : compareUtf8Text(a.id, b.id),
      );
      return { rows: selected.slice(0, query.limit).map(copy), now: clock };
    },
  };
}
