import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWorkOnce } from '../../dist/index.js';
import { createSqliteStore } from '../../dist/sqlite.js';
import { DatabaseSync } from 'node:sqlite';
const childUrl = new URL('./worker-child.mjs', import.meta.url);
function start(path, mode, id) {
  return fork(childUrl, [path, mode, id], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
}
async function message(child) {
  const timer = AbortSignal.timeout(15000);
  return (await once(child, 'message', { signal: timer }))[0];
}
test('8 independent OS processes can initialize one new SQLite database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-init-process-')),
    path = join(dir, 'queue.sqlite');
  let children = [];
  try {
    children = Array.from({ length: 8 }, (_, i) => start(path, 'open', String(i)));
    await Promise.all(children.map(message));
    const replies = children.map(message);
    for (const child of children) child.send('go');
    const result = await Promise.all(replies);
    const errors = result.flatMap((reply) => (reply.error ? [reply.error] : []));
    assert.deepEqual(errors, []);
    assert.equal(result.filter((reply) => reply.opened).length, 8);
  } finally {
    for (const child of children) if (!child.killed) child.kill();
    await sleep(30);
    rmSync(dir, { recursive: true });
  }
});

test('8 independent OS processes can upgrade one pre-definition SQLite schema', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-upgrade-process-')),
    path = join(dir, 'queue.sqlite');
  let children = [];
  try {
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA journal_mode=WAL;');
      db.exec(`CREATE TABLE workonce (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL,
        due_at INTEGER, pending_next INTEGER NOT NULL, body TEXT NOT NULL
      );`);
    } finally {
      db.close();
    }
    children = Array.from({ length: 8 }, (_, i) => start(path, 'open', String(i)));
    await Promise.all(children.map(message));
    const replies = children.map(message);
    for (const child of children) child.send('go');
    const result = await Promise.all(replies);
    const errors = result.flatMap((reply) => (reply.error ? [reply.error] : []));
    assert.deepEqual(errors, []);
    assert.equal(result.filter((reply) => reply.opened).length, 8);
    const verify = new DatabaseSync(path);
    try {
      const columns = verify
        .prepare('PRAGMA table_info(workonce)')
        .all()
        .map((row) => row.name);
      assert.ok(columns.includes('definition'));
      const indexes = verify
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all()
        .map((row) => row.name);
      assert.ok(indexes.includes('workonce_due_v2'));
      assert.ok(indexes.includes('workonce_list_v2'));
    } finally {
      verify.close();
    }
  } finally {
    for (const child of children) if (!child.killed) child.kill();
    await sleep(30);
    rmSync(dir, { recursive: true });
  }
});

test('8 independent OS processes cannot double-claim one SQLite item', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-process-')),
    path = join(dir, 'queue.sqlite');
  let children = [];
  try {
    const store = createSqliteStore(path),
      q = createWorkOnce({ store, scope: 'process-test' }).define('work', {
        limits: { leaseMs: 3000 },
      });
    await q.enqueue(null, { key: 'job' });
    store.close();
    children = Array.from({ length: 8 }, (_, i) => start(path, 'claim', String(i)));
    await Promise.all(children.map(message));
    const replies = children.map(message);
    for (const child of children) child.send('go');
    const result = await Promise.all(replies);
    assert.equal(result.filter((r) => r.error).length, 0);
    assert.equal(result.flatMap((r) => r.claims).length, 1);
  } finally {
    for (const child of children) if (!child.killed) child.kill();
    await sleep(30);
    rmSync(dir, { recursive: true });
  }
});
test('SIGKILL after durable claim, restart and late callback preserve fencing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-crash-')),
    path = join(dir, 'queue.sqlite');
  let child, late;
  try {
    let store = createSqliteStore(path),
      q = createWorkOnce({ store, scope: 'process-test' }).define('work', {
        limits: { leaseMs: 3000 },
      });
    await q.enqueue(null, { key: 'job' });
    store.close();
    child = start(path, 'crash', 'A');
    const { claim } = await message(child);
    assert.ok(claim);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await sleep(3100);
    store = createSqliteStore(path);
    q = createWorkOnce({ store, scope: 'process-test' }).define('work', {
      limits: { leaseMs: 3000 },
    });
    const [replacement] = await q.claim({ workerId: 'B' });
    assert.ok(replacement.ref.fence > claim.fence);
    late = start(path, 'late', 'old-A');
    await message(late);
    const reply = message(late);
    late.send({ ref: claim });
    assert.equal((await reply).code, 'stale_attempt');
    await replacement.settle(replacement.succeed());
    store.close();
    store = createSqliteStore(path);
    q = createWorkOnce({ store, scope: 'process-test' }).define('work', {
      limits: { leaseMs: 3000 },
    });
    assert.equal((await q.inspect('job')).phase.state, 'succeeded');
    store.close();
  } finally {
    if (child && !child.killed) child.kill();
    if (late && !late.killed) late.kill();
    await sleep(30);
    rmSync(dir, { recursive: true });
  }
});
