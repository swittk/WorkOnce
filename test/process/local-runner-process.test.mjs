import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkWithInbox, nextChildMessage } from './child-ipc-inbox.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWorkOnce, succeed } from '../../dist/index.js';
import { createSqliteStore } from '../../dist/sqlite.js';

const childUrl = new URL('./local-runner-child.mjs', import.meta.url);
function start(path, mode, now) {
  const args = [path, mode];
  if (now !== undefined) args.push(String(now));
  return forkWithInbox(
    childUrl,
    args,
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    'Local-runner child',
  );
}
const nextMessage = (child) => nextChildMessage(child, 15000);
async function kill(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    assert.equal(
      child.signalCode,
      'SIGKILL',
      `Local-runner child exited before SIGKILL: code=${String(child.exitCode)} signal=${String(child.signalCode)}`,
    );
    return;
  }
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(15000) });
  child.kill('SIGKILL');
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
}
async function cleanupChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(15000) }).catch(() => undefined);
  if (!child.killed) child.kill('SIGKILL');
  await exited;
}
async function seed(path, count, leaseMs = 200, now) {
  const store = createSqliteStore(path, now === undefined ? {} : { now: () => now });
  try {
    const queue = createWorkOnce({ store, scope: 'local-runner-process' }).define('job', {
      limits: { leaseMs, maxAttempts: 4, maxElapsedMs: 60_000, maxDeferrals: 2 },
    });
    for (let index = 0; index < count; index++)
      await queue.ensure({ key: String(index) }, { key: String(index) });
  } finally {
    store.close();
  }
}
function reopen(path, leaseMs = 200, now) {
  const store = createSqliteStore(path, now === undefined ? {} : { now: () => now });
  const queue = createWorkOnce({ store, scope: 'local-runner-process' }).define('job', {
    limits: { leaseMs, maxAttempts: 4, maxElapsedMs: 60_000, maxDeferrals: 2 },
  });
  return { store, queue };
}

test('SIGKILL with three active local attempts leaves all durable leases reclaimable and fenced', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-local-runner-multi-'));
  const path = join(directory, 'queue.sqlite');
  try {
    await seed(path, 3, 2000);
    const child = start(path, 'multi-active');
    try {
      const observing = reopen(path, 2000);
      let refs;
      try {
        const deadline = Date.now() + 15000;
        while (refs === undefined) {
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(
              `Local-runner child exited before three durable running attempts were observed: code=${String(child.exitCode)} signal=${String(child.signalCode)}`,
            );
          const snapshots = await observing.queue.inspectMany(['0', '1', '2']);
          if (snapshots.every((snapshot) => snapshot?.phase.state === 'running'))
            refs = snapshots.map((snapshot) => snapshot.phase.attempt);
          else if (Date.now() >= deadline)
            throw new Error('Timed out waiting for three durable WorkOnce running attempts');
          else await sleep(10);
        }
      } finally {
        observing.store.close();
      }
      await kill(child);
      const afterKill = reopen(path, 2000);
      let expiredAt;
      try {
        const snapshots = await afterKill.queue.inspectMany(['0', '1', '2']);
        assert.ok(snapshots.every((snapshot) => snapshot?.phase.state === 'running'));
        expiredAt = Math.max(...snapshots.map((snapshot) => snapshot.phase.attempt.leaseUntil)) + 1;
      } finally {
        afterKill.store.close();
      }
      const opened = reopen(path, 2000, expiredAt);
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
      await cleanupChild(child);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SIGKILL after heartbeat commit but before reply preserves renewed lease and later reclaim', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-local-runner-heartbeat-'));
  const path = join(directory, 'queue.sqlite');
  try {
    const logicalNow = 1000;
    await seed(path, 1, 200, logicalNow);
    const child = start(path, 'heartbeat-ack', logicalNow);
    let oldRef;
    try {
      assert.equal((await nextMessage(child)).ready, true);
      const stage = await nextMessage(child);
      assert.equal(stage.stage, 'heartbeat-committed');
      oldRef = stage.ref;
      await kill(child);
    } finally {
      await cleanupChild(child);
    }
    const opened = reopen(path, 200, oldRef.leaseUntil - 1);
    try {
      const renewed = await opened.queue.inspect('0');
      assert.equal(renewed.phase.state, 'running');
      assert.equal(renewed.phase.attempt.fence, oldRef.fence);
    } finally {
      opened.store.close();
    }
    const reopened = reopen(path, 200, oldRef.leaseUntil + 1);
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
      await cleanupChild(child);
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
