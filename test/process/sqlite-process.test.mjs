import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkWithInbox, nextChildMessage } from './child-ipc-inbox.mjs';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWorkOnce } from '../../dist/index.js';
import { createSqliteStore } from '../../dist/sqlite.js';
const childUrl = new URL('./worker-child.mjs', import.meta.url);
function start(path, mode, id) {
  return forkWithInbox(
    childUrl,
    [path, mode, id],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    'SQLite worker child',
  );
}
const message = (child) => nextChildMessage(child, 15000);
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

test('8 independent OS processes reopen the one current SQLite schema without changing work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-reopen-process-'));
  const path = join(dir, 'queue.sqlite');
  let children = [];
  try {
    const store = createSqliteStore(path);
    let snapshot, before;
    try {
      const queue = createWorkOnce({ store, scope: 'reopen' }).define('job');
      snapshot = await queue.ensure({ value: 1 }, { key: 'saved' });
      before = (await store.getMany([snapshot.id])).rows[0];
    } finally {
      store.close();
    }
    children = Array.from({ length: 8 }, (_, i) => start(path, 'open', String(i)));
    await Promise.all(children.map(message));
    const replies = children.map(message);
    for (const child of children) child.send('go');
    const result = await Promise.all(replies);
    assert.deepEqual(
      result.flatMap((reply) => (reply.error ? [reply.error] : [])),
      [],
    );
    assert.equal(result.filter((reply) => reply.opened).length, 8);
    const verify = createSqliteStore(path);
    try {
      assert.deepEqual((await verify.getMany([snapshot.id])).rows[0], before);
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
    const store = createSqliteStore(path);
    try {
      const q = createWorkOnce({ store, scope: 'process-test' }).define('work', {
        limits: { leaseMs: 3000 },
      });
      await q.enqueue(null, { key: 'job' });
    } finally {
      store.close();
    }
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
  let child, late, store;
  try {
    store = createSqliteStore(path);
    let q = createWorkOnce({ store, scope: 'process-test' }).define('work', {
      limits: { leaseMs: 3000 },
    });
    await q.enqueue(null, { key: 'job' });
    store.close();
    child = start(path, 'crash', 'A');
    const { claim } = await message(child);
    assert.ok(claim);
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `SQLite child exited before SIGKILL: code=${String(child.exitCode)} signal=${String(child.signalCode)}`,
      );
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(15000) });
    child.kill('SIGKILL');
    const [, signal] = await exited;
    assert.equal(signal, 'SIGKILL');
    store = createSqliteStore(path);
    q = createWorkOnce({ store, scope: 'process-test' }).define('work', {
      limits: { leaseMs: 3000 },
    });
    const afterKill = await q.inspect('job');
    assert.equal(afterKill.phase.state, 'running');
    const expiredAt = afterKill.phase.attempt.leaseUntil + 1;
    store.close();
    store = createSqliteStore(path, { now: () => expiredAt });
    q = createWorkOnce({ store, scope: 'process-test' }).define('work', {
      limits: { leaseMs: 3000 },
    });
    const [replacement] = await q.claim({ workerId: 'B' });
    assert.ok(replacement, 'Expected the expired attempt to be reclaimable after lease expiry');
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
    try {
      store?.close();
    } catch {
      /* A success-path close may already have closed this handle. */
    }
    if (child && !child.killed) child.kill();
    if (late && !late.killed) late.kill();
    await sleep(30);
    rmSync(dir, { recursive: true });
  }
});
