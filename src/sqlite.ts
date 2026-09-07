import { DatabaseSync } from 'node:sqlite';
import type { WorkQuery, WorkStore, StoreChange } from './storage.js';
import type { WorkRecord } from './model.js';
import { canonical, copy, dueAt, integer, WorkConflict } from './kernel.js';
import {
  parsePersistedWorkRecord,
  validateStoredMetadata,
  validateStoreWrite,
} from './storage-validation.js';

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /database is (?:locked|busy)/iu.test(error.message);
}
function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
function retryStartupBusy<T>(action: () => T, timeoutMs: number): T {
  const deadline = Date.now() + timeoutMs;
  let delay = 1;
  for (;;) {
    try {
      return action();
    } catch (error) {
      const remaining = deadline - Date.now();
      if (!isSqliteBusy(error) || remaining <= 0) throw error;
      sleepSync(Math.min(delay, remaining));
      delay = Math.min(delay * 2, 25);
    }
  }
}

/** A real durable store. SQLite serializes short writes; unrelated database files do not share a lock. */
export function createSqliteStore(
  path: string,
  options: { now?: () => number; busyTimeoutMs?: number } = {},
): WorkStore & { close(): void } {
  const busyTimeoutMs = Math.min(
    integer(options.busyTimeoutMs ?? 5000, 'busyTimeoutMs'),
    2_147_483_647,
  );
  const db = new DatabaseSync(path, { timeout: busyTimeoutMs });
  try {
    // Set the SQLite busy handler before any startup operation that may need a schema/write lock.
    db.exec(`PRAGMA busy_timeout=${busyTimeoutMs};`);
    // journal_mode promotion can return SQLITE_BUSY without honoring busy_timeout on some SQLite builds,
    // so retry only this startup-only coordination path. Steady-state queue operations never sleep here.
    retryStartupBusy(() => db.exec('PRAGMA journal_mode=WAL;'), busyTimeoutMs);
    db.exec('PRAGMA synchronous=FULL;');
    retryStartupBusy(
      () =>
        db.exec(`CREATE TABLE IF NOT EXISTS workonce (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, definition TEXT NOT NULL,
        due_at INTEGER, pending_next INTEGER NOT NULL, body TEXT NOT NULL
      );`),
      busyTimeoutMs,
    );

    const createCurrentIndexes = () =>
      retryStartupBusy(
        () =>
          db.exec(`
          CREATE INDEX IF NOT EXISTS workonce_due_v2
            ON workonce(scope,kind,definition,due_at,id) WHERE due_at IS NOT NULL;
          CREATE INDEX IF NOT EXISTS workonce_outbox ON workonce(scope,id) WHERE pending_next > 0;
          CREATE INDEX IF NOT EXISTS workonce_list_v2 ON workonce(scope,kind,definition,id);`),
        busyTimeoutMs,
      );

    // Fast path: current schemas avoid a write transaction entirely during ordinary process startup.
    const initialColumns = db.prepare('PRAGMA table_info(workonce)').all() as Record<
      string,
      unknown
    >[];
    const needsDefinitionUpgrade = !initialColumns.some(
      (column) => column['name'] === 'definition',
    );
    if (needsDefinitionUpgrade) {
      // Serialize the check/upgrade across independent processes, then re-check inside the lock.
      retryStartupBusy(() => db.exec('BEGIN IMMEDIATE'), busyTimeoutMs);
      try {
        const lockedColumns = db.prepare('PRAGMA table_info(workonce)').all() as Record<
          string,
          unknown
        >[];
        if (!lockedColumns.some((column) => column['name'] === 'definition')) {
          db.exec('ALTER TABLE workonce ADD COLUMN definition TEXT');
          db.exec(`UPDATE workonce
          SET definition = CASE
            WHEN json_valid(body) THEN
              CASE WHEN json_type(body, '$.definition') = 'text' THEN json_extract(body, '$.definition') END
          END
          WHERE definition IS NULL`);
          const invalidLegacy = db
            .prepare('SELECT id FROM workonce WHERE definition IS NULL LIMIT 1')
            .get() as Record<string, unknown> | undefined;
          if (invalidLegacy)
            throw new Error(`Invalid persisted WorkOnce row '${String(invalidLegacy['id'])}'`);
        }
        createCurrentIndexes();
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* Preserve the schema migration failure. */
        }
        throw error;
      }
    } else {
      // Versioned monotone names avoid DROP/CREATE races. Old indexes are harmless until maintenance.
      createCurrentIndexes();
    }

    const storedColumns = 'id,scope,kind,definition,due_at,pending_next,body';
    const read = db.prepare(`SELECT ${storedColumns} FROM workonce WHERE id=?`);
    const write =
      db.prepare(`INSERT INTO workonce(id,scope,kind,definition,due_at,pending_next,body)
    SELECT ?,?,?,?,?,?,? WHERE ? IS NULL OR COALESCE(?, CAST(unixepoch('subsec')*1000 AS INTEGER)) < ?
    ON CONFLICT(id) DO UPDATE SET
      scope=excluded.scope,kind=excluded.kind,definition=excluded.definition,
      due_at=excluded.due_at,pending_next=excluded.pending_next,body=excluded.body`);
    const queries = new Map<string, ReturnType<typeof db.prepare>>();
    const clock = db.prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS now");
    const now = () => integer(options.now ? options.now() : Number(clock.get()!['now']), 'clock');

    function parseStored(value: Record<string, unknown> | undefined): WorkRecord | undefined {
      if (!value) return undefined;
      const row = parsePersistedWorkRecord(value['body']);
      validateStoredMetadata(row, {
        id: value['id'],
        scope: value['scope'],
        kind: value['kind'],
        definition: value['definition'],
        dueAt: value['due_at'],
        pendingNext: value['pending_next'],
      });
      return row;
    }

    return {
      async atomic<T>(
        id: string,
        decide: (row: WorkRecord | undefined, now: number) => StoreChange<T>,
      ): Promise<T> {
        db.exec('BEGIN IMMEDIATE');
        try {
          const current = parseStored(read.get(id) as Record<string, unknown> | undefined);
          const change = decide(current ? copy(current) : undefined, now());
          // Validate/encode the returned value before commit so serialization errors roll back too.
          const value = copy(change.value);
          if (change.next) {
            validateStoreWrite(id, current, change.next, change.validUntil);
            const row = change.next;
            const stored = write.run(
              row.id,
              row.scope,
              row.kind,
              row.definition,
              dueAt(row) ?? null,
              row.outbox.length,
              canonical(row),
              change.validUntil ?? null,
              options.now ? now() : null,
              change.validUntil ?? null,
            );
            if (!stored.changes) throw new WorkConflict('lease_expired');
          }
          db.exec('COMMIT');
          return value;
        } catch (error) {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* Preserve the original IO/commit failure. */
          }
          throw error;
        }
      },
      async getMany(ids) {
        // One bounded read transaction gives a consistent batch snapshot and clock.
        db.exec('BEGIN');
        try {
          const rows = ids.map((id) =>
            parseStored(read.get(id) as Record<string, unknown> | undefined),
          );
          const time = now();
          db.exec('COMMIT');
          return { rows, now: time };
        } catch (error) {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* Preserve the original IO/commit failure. */
          }
          throw error;
        }
      },
      async query(query: WorkQuery) {
        integer(query.limit, 'limit', 1);
        if (query.select === 'due' && query.afterId !== undefined)
          throw new RangeError('afterId is not supported for due queries');
        const time = now();
        const clauses = ['scope=?'];
        const params: (string | number)[] = [query.scope];
        if (query.kind !== undefined) {
          clauses.push('kind=?');
          params.push(query.kind);
        }
        if (query.definition !== undefined) {
          clauses.push('definition=?');
          params.push(query.definition);
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
        const sql = `SELECT ${storedColumns} FROM workonce WHERE ${clauses.join(' AND ')} ORDER BY ${order} LIMIT ?`;
        let statement = queries.get(sql);
        if (!statement) {
          statement = db.prepare(sql);
          queries.set(sql, statement);
        }
        const found = statement.all(...params) as Record<string, unknown>[];
        return { rows: found.map((value) => parseStored(value)!), now: time };
      },
      close() {
        db.close();
      },
    };
  } catch (error) {
    try {
      db.close();
    } catch {
      /* Preserve the original bootstrap failure. */
    }
    throw error;
  }
}
