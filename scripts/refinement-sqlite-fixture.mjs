import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteStore } from '../dist/sqlite.js';

/** Create a temporary SQLite proof fixture that cleans its directory on both open and close failure. */
export function createRefinementSqliteFixture(prefix, filename, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  let store;
  try {
    store = createSqliteStore(join(directory, filename), options);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    store,
    close() {
      try {
        store.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}
