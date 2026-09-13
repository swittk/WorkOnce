import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWorkOnce } from '../dist/index.js';
import { createSqliteStore } from '../dist/sqlite.js';

test('SQLite store borrows an existing compatible database and coexists with application tables', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-sqlite-borrowed-'));
  const path = join(directory, 'application.sqlite');
  const database = new DatabaseSync(path);
  try {
    database.exec('CREATE TABLE application_receipt(id TEXT PRIMARY KEY);');
    const store = createSqliteStore(database, { now: () => 100 });
    const queue = createWorkOnce({ store, scope: 'borrowed' }).define('job');
    await queue.ensure({ value: 1 }, { key: 'x' });

    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM workonce').get().count, 1);
    assert.ok(
      database.prepare("SELECT name FROM sqlite_master WHERE name='application_receipt'").get(),
    );

    store.close();
    assert.equal(database.prepare('SELECT 1 AS value').get().value, 1);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite store can take close ownership of a supplied database explicitly', () => {
  const database = new DatabaseSync(':memory:');
  const store = createSqliteStore(database, { closeDatabase: true });
  store.close();
  assert.throws(() => database.prepare('SELECT 1'), /database is not open|closed/iu);
});
