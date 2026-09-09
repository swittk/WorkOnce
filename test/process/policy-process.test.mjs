import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWorkOnce, retry, wait } from '../../dist/index.js';
import { createSqliteStore } from '../../dist/sqlite.js';

const childUrl = new URL('./policy-child.mjs', import.meta.url);
function start(path, mode, outcomeKind) {
  return fork(childUrl, [path, mode, outcomeKind], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
}
async function message(child) {
  return (await once(child, 'message', { signal: AbortSignal.timeout(15000) }))[0];
}
async function setup(path) {
  const store = createSqliteStore(path);
  try {
    const queue = createWorkOnce({ store, scope: 'policy-process' }).define('job', {
      retry: { retry: true, afterMs: 0, maxRetries: 2, manualRetry: true },
      wait: { afterMs: 0 },
      limits: { leaseMs: 250, maxAttempts: 4, maxElapsedMs: 5000, maxDeferrals: 4 },
    });
    await queue.ensure(null, { key: 'job' });
  } finally {
    store.close();
  }
}
function reopen(path) {
  const store = createSqliteStore(path);
  const queue = createWorkOnce({ store, scope: 'policy-process' }).define('job', {
    retry: { retry: true, afterMs: 0, maxRetries: 2, manualRetry: true },
    wait: { afterMs: 0 },
    limits: { leaseMs: 250, maxAttempts: 4, maxElapsedMs: 5000, maxDeferrals: 4 },
  });
  return { store, queue };
}
async function killAt(path, mode, outcomeKind, expectedStage) {
  const child = start(path, mode, outcomeKind);
  try {
    const ready = await message(child);
    assert.equal(ready.ready, true);
    const stage = await message(child);
    assert.equal(stage.stage, expectedStage);
    assert.equal(stage.ref.workId, ready.ref.workId);
    assert.equal(stage.ref.generation, ready.ref.generation);
    assert.equal(stage.ref.fence, ready.ref.fence);
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Policy child exited before SIGKILL: code=${String(child.exitCode)} signal=${String(child.signalCode)}`,
      );
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(15000) });
    child.kill('SIGKILL');
    const [, signal] = await exited;
    assert.equal(signal, 'SIGKILL');
    return ready.ref;
  } finally {
    if (!child.killed) child.kill('SIGKILL');
  }
}

for (const outcomeKind of ['retry', 'defer']) {
  test(`SIGKILL during async ${outcomeKind} policy leaves no policy write and stale owner cannot publish`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `workonce-${outcomeKind}-policy-crash-`));
    const path = join(dir, 'queue.sqlite');
    try {
      await setup(path);
      const ref = await killAt(path, 'during-policy', outcomeKind, 'policy-entered');
      let opened = reopen(path);
      try {
        const before = await opened.queue.inspect('job');
        assert.equal(before.phase.state, 'running');
        assert.equal(before.retries, 0);
        assert.equal(before.deferrals, 0);
        const raw = (await opened.store.getMany([ref.workId])).rows[0];
        assert.equal(raw.receipt, undefined);
      } finally {
        opened.store.close();
      }
      await sleep(300);
      opened = reopen(path);
      try {
        const [reclaimed] = await opened.queue.claim({ workerId: 'restart', limit: 1 });
        assert.ok(reclaimed);
        assert.equal(reclaimed.ref.fence, ref.fence + 1);
        await assert.rejects(
          opened.queue.settle(ref, outcomeKind === 'retry' ? retry('busy') : wait('pending')),
          (error) => error?.code === 'stale_attempt',
        );
      } finally {
        opened.store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`SIGKILL after durable ${outcomeKind} settlement but before ACK replays exactly after restart`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `workonce-${outcomeKind}-ack-crash-`));
    const path = join(dir, 'queue.sqlite');
    try {
      await setup(path);
      const ref = await killAt(path, 'after-commit', outcomeKind, 'settlement-committed');
      const opened = reopen(path);
      try {
        const before = (await opened.store.getMany([ref.workId])).rows[0];
        assert.equal(before.phase.state, 'waiting');
        assert.equal(before.retries, outcomeKind === 'retry' ? 1 : 0);
        assert.equal(before.deferrals, outcomeKind === 'defer' ? 1 : 0);
        assert.ok(before.receipt);
        const outcome = outcomeKind === 'retry' ? retry('busy') : wait('pending');
        const replay = await opened.queue.settle(ref, outcome);
        assert.deepEqual(replay, before.phase);
        const after = (await opened.store.getMany([ref.workId])).rows[0];
        assert.deepEqual(after, before);
        await assert.rejects(
          opened.queue.settle(
            ref,
            outcomeKind === 'retry' ? retry('different') : wait('different'),
          ),
          (error) => error?.code === 'settlement_conflict',
        );
      } finally {
        opened.store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
