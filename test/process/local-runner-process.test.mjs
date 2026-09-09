import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWorkOnce, succeed } from '../../dist/index.js';
import { createSqliteStore } from '../../dist/sqlite.js';

const childUrl = new URL('./local-runner-child.mjs', import.meta.url);
function start(path, mode) {
  return fork(childUrl, [path, mode], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
}
async function nextMessage(child) {
  return (await once(child, 'message', { signal: AbortSignal.timeout(15000) }))[0];
}
async function kill(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    assert.equal(child.signalCode, 'SIGKILL');
    return;
  }
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(15000) });
  child.kill('SIGKILL');
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
}
async function seed(path, count) {
  const store = createSqliteStore(path);
  try {
    const queue = createWorkOnce({ store, scope: 'local-runner-process' }).define('job', {
      limits: { leaseMs: 200, maxAttempts: 4, maxElapsedMs: 5000, maxDeferrals: 2 },
    });
    for (let index = 0; index < count; index++)
      await queue.ensure({ key: String(index) }, { key: String(index) });
  } finally {
    store.close();
  }
}
function reopen(path) {
  const store = createSqliteStore(path);
  const queue = createWorkOnce({ store, scope: 'local-runner-process' }).define('job', {
    limits: { leaseMs: 200, maxAttempts: 4, maxElapsedMs: 5000, maxDeferrals: 2 },
  });
  return { store, queue };
}

test('SIGKILL with three active local attempts leaves all durable leases reclaimable and fenced', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-local-runner-multi-'));
  const path = join(directory, 'queue.sqlite');
  try {
    await seed(path, 3);
    const child = start(path, 'multi-active');
    try {
      assert.equal((await nextMessage(child)).ready, true);
      const refs = [];
      while (refs.length < 3) {
        const message = await nextMessage(child);
        if (message.stage === 'started') refs.push(message.ref);
      }
      await kill(child);
      await sleep(250);
      const opened = reopen(path);
      try {
        const reclaimed = await opened.queue.claim({ workerId: 'restart', limit: 3 });
        assert.equal(reclaimed.length, 3);
        assert.deepEqual(
          reclaimed.map((run) => run.ref.fence).sort((a, b) => a - b),
          [2, 2, 2],
        );
        for (const ref of refs)
          await assert.rejects(
            opened.queue.settle(ref, succeed()),
            (error) => error?.code === 'stale_attempt',
          );
      } finally {
        opened.store.close();
      }
    } finally {
      if (!child.killed) child.kill('SIGKILL');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SIGKILL after heartbeat commit but before reply preserves renewed lease and later reclaim', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-local-runner-heartbeat-'));
  const path = join(directory, 'queue.sqlite');
  try {
    await seed(path, 1);
    const child = start(path, 'heartbeat-ack');
    let oldRef;
    try {
      assert.equal((await nextMessage(child)).ready, true);
      const stage = await nextMessage(child);
      assert.equal(stage.stage, 'heartbeat-committed');
      oldRef = stage.ref;
      await kill(child);
    } finally {
      if (!child.killed) child.kill('SIGKILL');
    }
    const opened = reopen(path);
    try {
      const renewed = await opened.queue.inspect('0');
      assert.equal(renewed.phase.state, 'running');
      assert.equal(renewed.phase.attempt.fence, oldRef.fence);
    } finally {
      opened.store.close();
    }
    await sleep(250);
    const reopened = reopen(path);
    try {
      const [reclaimed] = await reopened.queue.claim({ workerId: 'restart', limit: 1 });
      assert.ok(reclaimed);
      assert.equal(reclaimed.ref.fence, oldRef.fence + 1);
      await assert.rejects(
        reopened.queue.heartbeat(oldRef),
        (error) => error?.code === 'stale_attempt',
      );
    } finally {
      reopened.store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SIGKILL after settlement commit but before reply replays the exact terminal receipt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-local-runner-settle-'));
  const path = join(directory, 'queue.sqlite');
  try {
    await seed(path, 1);
    const child = start(path, 'settle-ack');
    let ref;
    try {
      assert.equal((await nextMessage(child)).ready, true);
      const stage = await nextMessage(child);
      assert.equal(stage.stage, 'settlement-committed');
      ref = stage.ref;
      await kill(child);
    } finally {
      if (!child.killed) child.kill('SIGKILL');
    }
    const opened = reopen(path);
    try {
      const before = await opened.queue.inspect('0');
      assert.equal(before.phase.state, 'succeeded');
      const replay = await opened.queue.settle(ref, succeed());
      assert.deepEqual(replay, before.phase);
      const after = await opened.queue.inspect('0');
      assert.deepEqual(after.phase, before.phase);
      assert.equal(after.attempts, before.attempts);
    } finally {
      opened.store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
