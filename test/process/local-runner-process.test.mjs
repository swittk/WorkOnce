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
const childInboxes = new WeakMap();
function start(path, mode) {
  const child = fork(childUrl, [path, mode], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const inbox = { messages: [], waiters: [], ended: undefined };
  childInboxes.set(child, inbox);
  child.on('message', (message) => {
    const waiter = inbox.waiters.shift();
    if (waiter) waiter.resolve(message);
    else inbox.messages.push(message);
  });
  const end = (error) => {
    inbox.ended = error;
    for (const waiter of inbox.waiters.splice(0)) waiter.reject(error);
  };
  child.once('exit', (code, signal) =>
    end(
      new Error(
        `Local-runner child exited before its next IPC message: code=${String(code)} signal=${String(signal)}`,
      ),
    ),
  );
  child.once('error', end);
  return child;
}
async function nextMessage(child) {
  const inbox = childInboxes.get(child);
  assert.ok(inbox, 'Local-runner child inbox was not initialized');
  if (inbox.messages.length) return inbox.messages.shift();
  if (inbox.ended) throw inbox.ended;
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve(value) {
        clearTimeout(timeout);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timeout);
        reject(error);
      },
    };
    const timeout = setTimeout(() => {
      const index = inbox.waiters.indexOf(waiter);
      if (index >= 0) inbox.waiters.splice(index, 1);
      reject(new Error('Timed out waiting for local-runner child IPC message'));
    }, 15000);
    inbox.waiters.push(waiter);
  });
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
async function seed(path, count, leaseMs = 200) {
  const store = createSqliteStore(path);
  try {
    const queue = createWorkOnce({ store, scope: 'local-runner-process' }).define('job', {
      limits: { leaseMs, maxAttempts: 4, maxElapsedMs: 5000, maxDeferrals: 2 },
    });
    for (let index = 0; index < count; index++)
      await queue.ensure({ key: String(index) }, { key: String(index) });
  } finally {
    store.close();
  }
}
function reopen(path, leaseMs = 200) {
  const store = createSqliteStore(path);
  const queue = createWorkOnce({ store, scope: 'local-runner-process' }).define('job', {
    limits: { leaseMs, maxAttempts: 4, maxElapsedMs: 5000, maxDeferrals: 2 },
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
      await sleep(2050);
      const opened = reopen(path, 2000);
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
