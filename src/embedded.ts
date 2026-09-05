import type { WorkRecord } from './model.js';
import type { StoreChange, WorkQuery, WorkStore } from './storage.js';
import { copy, integer, WorkConflict } from './kernel.js';
/**
 * Adapter-author port for work embedded in an existing application row. exclusive must
 * cover load through commit across the declared deployment. A local mutex supports ONE
 * backend process, not multiple replicas. An expiring distributed lock alone is insufficient.
 */
export interface EmbeddedWorkPort<Row> {
  /** Every logical id maps to one stable application row. */
  load(id: string): Promise<Row | undefined>;
  /** Return rows in input order; missing entries remain undefined. */
  loadMany(ids: readonly string[]): Promise<(Row | undefined)[]>;
  /** Indexed, bounded candidate lookup using dueAt and scope/kind. */
  select(query: WorkQuery): Promise<Row[]>;
  /** Extract the work record without constructing a second authority. */
  read(row: Row): WorkRecord | undefined;
  /** Save work state and any synchronous application projection together. */
  commit(row: Row, next: WorkRecord): Promise<void>;
  /** Must hold the real serialization boundary until the returned promise settles. */
  exclusive<T>(id: string, execute: () => Promise<T>): Promise<T>;
  /** One trusted store/backend clock. A test may inject a deterministic clock. */
  now?: () => number;
}
/** Build the queue port while leaving the actual serialization guarantee explicit and testable. */
export function createEmbeddedStore<Row>(port: EmbeddedWorkPort<Row>): WorkStore {
  const now = () => integer((port.now ?? Date.now)(), 'clock');
  return {
    atomic<T>(
      id: string,
      decide: (row: WorkRecord | undefined, now: number) => StoreChange<T>,
    ): Promise<T> {
      return port.exclusive(id, async () => {
        const row = await port.load(id);
        if (!row) throw new WorkConflict('not_found');
        const current = port.read(row);
        if (current && current.id !== id) throw new WorkConflict('key_conflict');
        const change = decide(current ? copy(current) : undefined, now());
        const value = copy(change.value);
        if (change.next) {
          if (change.next.id !== id) throw new WorkConflict('key_conflict');
          await port.commit(row, copy(change.next));
        }
        return value;
      });
    },
    async getMany(ids) {
      const loaded = await port.loadMany(ids);
      return {
        rows: loaded.map((row, index) => {
          const state = row ? port.read(row) : undefined;
          return state?.id === ids[index] ? copy(state) : undefined;
        }),
        now: now(),
      };
    },
    async query(query) {
      integer(query.limit, 'limit', 1);
      const rows: WorkRecord[] = [];
      for (const row of await port.select(query)) {
        const state = port.read(row);
        if (state) rows.push(copy(state));
      }
      return { rows, now: now() };
    },
  };
}
