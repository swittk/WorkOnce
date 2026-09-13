import { createRequire } from 'node:module';
import type { WorkQuery, WorkStore, StoreChange } from './storage.js';
import type { WorkRecord } from './model.js';

/** Scalar values WorkOnce may bind through a compatible synchronous SQLite statement. */
type SqliteValue = null | number | bigint | string | NodeJS.ArrayBufferView;

/** Minimal prepared-statement surface shared by node:sqlite and better-sqlite3. */
interface SqliteStatement {
  get(...parameters: SqliteValue[]): unknown;
  all(...parameters: SqliteValue[]): unknown[];
  run(...parameters: SqliteValue[]): { changes: number | bigint };
}

/** Minimal synchronous SQLite connection accepted by the official WorkOnce SQLite store. */
export interface SqliteDatabase {
  /** Execute schema, transaction, or pragma SQL synchronously on this connection. */
  exec(sql: string): unknown;
  /** Driver-specific prepared statement; WorkOnce validates the required get/all/run surface. */
  prepare(sql: string): unknown;
  /** Close the connection when ownership belongs to WorkOnce or its caller. */
  close(): unknown;
}

/** SQLite store controls; a supplied database is borrowed unless closeDatabase is true. */
export interface SqliteStoreOptions {
  /** Override storage time for deterministic tests or an application-owned clock. */
  now?: () => number;
  /** Maximum SQLite lock wait during connection setup and ordinary database operations. */
  busyTimeoutMs?: number;
  /** Transfer close ownership of a caller-supplied database to the returned WorkStore. */
  closeDatabase?: boolean;
}
import { canonical, copy, dueAt, integer, WorkConflict } from './kernel.js';
import {
  parsePersistedWorkRecord,
  validateStoredMetadata,
  validateStoreWrite,
} from './storage-validation.js';

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errcode = (error as Error & { errcode?: unknown }).errcode;
  // SQLite primary result codes: SQLITE_BUSY=5, SQLITE_LOCKED=6. Prefer the native code when present;
  // retain the message fallback for runtimes that expose only an Error message.
  if (errcode === 5 || errcode === 6) return true;
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

function isSqliteRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sqliteRow(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isSqliteRow(value)) throw new TypeError('SQLite driver must return row objects');
  return value;
}

function isSqliteStatement(value: unknown): value is SqliteStatement {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'get') === 'function' &&
    typeof Reflect.get(value, 'all') === 'function' &&
    typeof Reflect.get(value, 'run') === 'function'
  );
}

function prepareSqlite(database: SqliteDatabase, sql: string): SqliteStatement {
  const statement = database.prepare(sql);
  if (!isSqliteStatement(statement))
    throw new TypeError('SQLite driver prepare() must return get/all/run statement methods');
  return statement;
}

function isSqliteDatabase(value: unknown): value is SqliteDatabase {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'exec') === 'function' &&
    typeof Reflect.get(value, 'prepare') === 'function' &&
    typeof Reflect.get(value, 'close') === 'function'
  );
}

const nodeRequire = createRequire(process.execPath);
function openNodeSqlite(path: string, busyTimeoutMs: number): SqliteDatabase {
  const sqlite: unknown = nodeRequire('node:sqlite');
  if (typeof sqlite !== 'object' || sqlite === null)
    throw new Error('node:sqlite did not expose its module object');
  const DatabaseSync = Reflect.get(sqlite, 'DatabaseSync');
  if (typeof DatabaseSync !== 'function')
    throw new Error('node:sqlite did not expose DatabaseSync');
  const database: unknown = Reflect.construct(DatabaseSync, [path, { timeout: busyTimeoutMs }]);
  if (!isSqliteDatabase(database))
    throw new TypeError('node:sqlite DatabaseSync is missing the required SQLite driver surface');
  return database;
}

/**
 * A real durable store. Pass a path for the built-in node:sqlite connection, or pass an existing
 * synchronous SQLite database handle (for example better-sqlite3) to reuse application storage.
 * Caller-supplied databases are borrowed by default and remain open after store.close().
 */
export function createSqliteStore(
  source: string | SqliteDatabase,
  options: SqliteStoreOptions = {},
): WorkStore & { close(): void } {
  const busyTimeoutMs = Math.min(
    integer(options.busyTimeoutMs ?? 5000, 'busyTimeoutMs'),
    2_147_483_647,
  );
  const ownsDatabase = typeof source === 'string' || options.closeDatabase === true;
  const db = typeof source === 'string' ? openNodeSqlite(source, busyTimeoutMs) : source;
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

    retryStartupBusy(
      () =>
        db.exec(`
          CREATE INDEX IF NOT EXISTS workonce_due
            ON workonce(scope,kind,definition,due_at,id) WHERE due_at IS NOT NULL;
          CREATE INDEX IF NOT EXISTS workonce_outbox ON workonce(scope,id) WHERE pending_next > 0;
          CREATE INDEX IF NOT EXISTS workonce_list ON workonce(scope,kind,definition,id);`),
      busyTimeoutMs,
    );

    const storedColumns = 'id,scope,kind,definition,due_at,pending_next,body';
    const read = prepareSqlite(db, `SELECT ${storedColumns} FROM workonce WHERE id=?`);
    const write = prepareSqlite(
      db,
      `INSERT INTO workonce(id,scope,kind,definition,due_at,pending_next,body)
    SELECT ?,?,?,?,?,?,? WHERE ? IS NULL OR COALESCE(?, CAST(unixepoch('subsec')*1000 AS INTEGER)) < ?
    ON CONFLICT(id) DO UPDATE SET
      scope=excluded.scope,kind=excluded.kind,definition=excluded.definition,
      due_at=excluded.due_at,pending_next=excluded.pending_next,body=excluded.body`,
    );
    const queries = new Map<string, SqliteStatement>();
    const clock = prepareSqlite(db, "SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS now");
    const now = () =>
      integer(options.now ? options.now() : Number(sqliteRow(clock.get())!['now']), 'clock');

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
          const current = parseStored(sqliteRow(read.get(id)));
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
          const rows = ids.map((id) => parseStored(sqliteRow(read.get(id))));
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
          statement = prepareSqlite(db, sql);
          queries.set(sql, statement);
        }
        const found = statement.all(...params);
        return { rows: found.map((value) => parseStored(sqliteRow(value))!), now: time };
      },
      close() {
        if (ownsDatabase) db.close();
      },
    };
  } catch (error) {
    if (ownsDatabase) {
      try {
        db.close();
      } catch {
        /* Preserve the original bootstrap failure. */
      }
    }
    throw error;
  }
}
