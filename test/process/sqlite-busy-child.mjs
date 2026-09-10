import { DatabaseSync } from 'node:sqlite';

const [path, holdText = '250'] = process.argv.slice(2);
const holdMs = Number(holdText);
if (!path || !Number.isFinite(holdMs))
  throw new Error('usage: sqlite-busy-child.mjs <path> <holdMs>');
const db = new DatabaseSync(path, { timeout: 0 });
db.exec('PRAGMA journal_mode=WAL;');
db.exec('BEGIN EXCLUSIVE');
process.send?.({ locked: true });
process.once('message', (message) => {
  if (message?.startHold !== true) throw new Error('expected startHold handshake');
  setTimeout(() => {
    const finishUnlock = (error) => {
      try {
        if (error) throw error;
      } finally {
        db.close();
        process.disconnect?.();
      }
    };
    try {
      db.exec('COMMIT');
      if (process.send) process.send({ unlocking: true, unlockingAt: Date.now() }, finishUnlock);
      else finishUnlock();
    } catch (error) {
      finishUnlock(error);
    }
  }, holdMs);
});
