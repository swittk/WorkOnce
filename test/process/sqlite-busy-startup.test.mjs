import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkWithInbox, nextChildMessage } from './child-ipc-inbox.mjs';
import { createSqliteStore } from '../../dist/sqlite.js';

const childUrl = new URL('./sqlite-busy-child.mjs', import.meta.url);
async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, 'exit', { signal: AbortSignal.timeout(timeoutMs) });
}

async function lock(path, holdMs) {
  const child = forkWithInbox(
    childUrl,
    [path, String(holdMs)],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    'SQLite busy child',
  );
  try {
    const message = await nextChildMessage(child, 5000);
    assert.equal(message.locked, true);
    return child;
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) }).catch(
        () => undefined,
      );
      child.kill('SIGKILL');
      await exited;
    }
    throw error;
  }
}

test('SQLite startup retries a real write lock and succeeds after the lock clears', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-sqlite-busy-retry-'));
  const path = join(dir, 'queue.sqlite');
  let child;
  try {
    child = await lock(path, 250);
    child.send({ startHold: true });
    const startedAt = Date.now();
    const store = createSqliteStore(path, { busyTimeoutMs: 2000 });
    const completedAt = Date.now();
    store.close();
    const unlocking = await nextChildMessage(child, 5000);
    assert.equal(unlocking.unlocking, true);
    assert.ok(unlocking.unlockingAt >= startedAt, 'child lock released before startup began');
    assert.ok(
      completedAt >= unlocking.unlockingAt,
      'startup completed before the held lock released',
    );
    await waitForExit(child);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite startup busy timeout propagates a native busy/locked failure without partial schema claims', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-sqlite-busy-timeout-'));
  const path = join(dir, 'queue.sqlite');
  let child;
  try {
    child = await lock(path, 0);
    const startedAt = Date.now();
    let failure;
    try {
      createSqliteStore(path, { busyTimeoutMs: 20 });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /database is (?:locked|busy)/iu);
    assert.equal(typeof failure.code, 'string');
    child.send({ startHold: true });
    const unlocking = await nextChildMessage(child, 5000);
    assert.equal(unlocking.unlocking, true);
    assert.ok(unlocking.unlockingAt >= startedAt, 'child lock released before timeout probe began');
    await waitForExit(child);
    const store = createSqliteStore(path, { busyTimeoutMs: 1000 });
    try {
      const columns = await store.query({ scope: 'none', select: 'all', limit: 1 });
      assert.deepEqual(columns.rows, []);
    } finally {
      store.close();
    }
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
