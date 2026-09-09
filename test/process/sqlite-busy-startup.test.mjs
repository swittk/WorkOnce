import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteStore } from '../../dist/sqlite.js';

const childUrl = new URL('./sqlite-busy-child.mjs', import.meta.url);
async function lock(path, holdMs) {
  const child = fork(childUrl, [path, String(holdMs)], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  try {
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
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
    const started = performance.now();
    const store = createSqliteStore(path, { busyTimeoutMs: 2000 });
    const elapsed = performance.now() - started;
    store.close();
    await once(child, 'exit', { signal: AbortSignal.timeout(5000) });
    assert.ok(elapsed >= 100, `startup did not observe the held lock: ${elapsed}ms`);
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
    child = await lock(path, 500);
    let failure;
    try {
      createSqliteStore(path, { busyTimeoutMs: 20 });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /database is (?:locked|busy)/iu);
    assert.equal(typeof failure.code, 'string');
    await once(child, 'exit', { signal: AbortSignal.timeout(5000) });
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
