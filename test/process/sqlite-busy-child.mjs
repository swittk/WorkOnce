import { DatabaseSync } from 'node:sqlite';

const [path, holdText = '250'] = process.argv.slice(2);
const holdMs = Number(holdText);
if (!path || !Number.isFinite(holdMs))
  throw new Error('usage: sqlite-busy-child.mjs <path> <holdMs>');
const db = new DatabaseSync(path, { timeout: 0 });
db.exec('PRAGMA journal_mode=WAL;');
db.exec('BEGIN EXCLUSIVE');
process.send?.({ locked: true });
setTimeout(() => {
  try {
    db.exec('COMMIT');
  } finally {
    db.close();
    process.disconnect?.();
  }
}, holdMs);
