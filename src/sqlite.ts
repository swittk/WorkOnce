import { DatabaseSync } from 'node:sqlite';
import type { WorkQuery, WorkStore, StoreChange } from './storage.js';
import type { WorkRecord } from './model.js';
import { canonical, copy, dueAt, integer } from './kernel.js';
/** A real durable store. SQLite serializes short writes; unrelated database files do not share a lock. */
export function createSqliteStore(
  path: string,
  options: { now?: () => number; busyTimeoutMs?: number } = {},
): WorkStore & { close(): void } {
  const db = new DatabaseSync(path, { timeout: options.busyTimeoutMs ?? 5000 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS workonce (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL,
      due_at INTEGER, pending_next INTEGER NOT NULL, body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workonce_due ON workonce(scope,kind,due_at,id) WHERE due_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS workonce_outbox ON workonce(scope,id) WHERE pending_next > 0;
    CREATE INDEX IF NOT EXISTS workonce_list ON workonce(scope,kind,id);`);
  const read = db.prepare('SELECT body FROM workonce WHERE id=?');
  const write =
    db.prepare(`INSERT INTO workonce(id,scope,kind,due_at,pending_next,body) VALUES(?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,kind=excluded.kind,due_at=excluded.due_at,pending_next=excluded.pending_next,body=excluded.body`);
  const clock = db.prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS now");
  const now = () => integer(options.now ? options.now() : Number(clock.get()!['now']), 'clock');
  function parseRow(value: ReturnType<typeof read.get>): WorkRecord | undefined {
    return value ? (JSON.parse(String(value['body'])) as WorkRecord) : undefined;
  }
  return {
    async atomic<T>(
      id: string,
      decide: (row: WorkRecord | undefined, now: number) => StoreChange<T>,
    ): Promise<T> {
      db.exec('BEGIN IMMEDIATE');
      try {
        const change = decide(parseRow(read.get(id)), now());
        // Validate/encode the returned value before commit so serialization errors roll back too.
        const value = copy(change.value);
        if (change.next) {
          const row = change.next;
          if (row.id !== id) throw new Error('Store decision changed work identity');
          write.run(
            row.id,
            row.scope,
            row.kind,
            dueAt(row) ?? null,
            row.outbox.length,
            canonical(row),
          );
        }
        db.exec('COMMIT');
        return value;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async getMany(ids) {
      // One bounded read transaction gives a consistent batch snapshot and clock.
      db.exec('BEGIN');
      try {
        const rows = ids.map((id) => parseRow(read.get(id)));
        const time = now();
        db.exec('COMMIT');
        return { rows, now: time };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async query(query: WorkQuery) {
      integer(query.limit, 'limit', 1);
      const time = now();
      const clauses = ['scope=?'];
      const params: (string | number)[] = [query.scope];
      if (query.kind !== undefined) {
        clauses.push('kind=?');
        params.push(query.kind);
      }
      if (query.select === 'due') {
        clauses.push('due_at IS NOT NULL AND due_at<=?');
        params.push(time);
      }
      if (query.select === 'outbox') clauses.push('pending_next>0');
      if (query.afterId !== undefined) {
        clauses.push('id>?');
        params.push(query.afterId);
      }
      params.push(query.limit);
      const order = query.select === 'due' ? 'due_at,id' : 'id';
      const found = db
        .prepare(
          `SELECT body FROM workonce WHERE ${clauses.join(' AND ')} ORDER BY ${order} LIMIT ?`,
        )
        .all(...params);
      return {
        rows: found.map((value) => JSON.parse(String(value['body'])) as WorkRecord),
        now: time,
      };
    },
    close() {
      db.close();
    },
  };
}
