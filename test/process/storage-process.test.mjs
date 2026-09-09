import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkOnce } from '../../dist/index.js';
import { createSqliteStore } from '../../dist/sqlite.js';

const childUrl = new URL('./storage-child.mjs', import.meta.url);
async function message(child) {
  return (await once(child, 'message', { signal: AbortSignal.timeout(10000) }))[0];
}
async function killAt(path, mode, stage) {
  const child = fork(childUrl, [path, mode], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  try {
    assert.equal((await message(child)).ready, true);
    const seen = await message(child);
    assert.equal(seen.stage, stage);
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Storage child exited before SIGKILL: code=${String(child.exitCode)} signal=${String(child.signalCode)}`,
      );
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(15000) });
    child.kill('SIGKILL');
    const [, signal] = await exited;
    assert.equal(signal, 'SIGKILL');
    return seen;
  } finally {
    if (!child.killed) child.kill('SIGKILL');
  }
}

test('SQLite atomic commit survives process death before caller acknowledgement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-storage-commit-ack-'));
  const path = join(dir, 'queue.sqlite');
  try {
    const seen = await killAt(path, 'commit-before-ack', 'committed');
    assert.equal(seen.id, '["storage-process","job","x"]');
    const store = createSqliteStore(path);
    try {
      const queue = createWorkOnce({ store, scope: 'storage-process' }).define('job');
      const row = await queue.inspect('x');
      assert.equal(row?.phase.state, 'queued');
      assert.deepEqual(row?.input, { value: 1 });
      const replay = await queue.ensure({ value: 1 }, { key: 'x' });
      assert.equal(replay.revision, 1, 'lost caller ACK must not create a second durable write');
      await assert.rejects(
        queue.ensure({ value: 2 }, { key: 'x' }),
        (error) => error?.code === 'key_conflict',
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite decision failure leaves no durable row across process death/reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-storage-decision-fault-'));
  const path = join(dir, 'queue.sqlite');
  try {
    const seen = await killAt(path, 'decision-fault', 'decision-failed');
    assert.equal(seen.message, 'decision failed');
    const store = createSqliteStore(path);
    try {
      const rows = await store.query({ scope: 'storage-process', select: 'all', limit: 10 });
      assert.deepEqual(rows.rows, []);
      const queue = createWorkOnce({ store, scope: 'storage-process' }).define('job');
      const created = await queue.ensure(null, { key: 'x' });
      assert.equal(created.revision, 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
