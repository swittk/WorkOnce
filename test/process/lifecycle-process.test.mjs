import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkOnce } from '../../dist/index.js';
import { createSqliteStore } from '../../dist/sqlite.js';

const childUrl = new URL('./lifecycle-child.mjs', import.meta.url);
function start(path, mode, detail = '') {
  return fork(childUrl, [path, mode, detail], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
}
async function nextMessage(child) {
  return (await once(child, 'message', { signal: AbortSignal.timeout(15000) }))[0];
}
async function killAfterStage(path, mode, detail, expectedStage) {
  const child = start(path, mode, detail);
  try {
    let first = await nextMessage(child);
    let ready;
    let stage;
    if (first.stage) stage = first;
    else {
      ready = first;
      stage = await nextMessage(child);
    }
    assert.equal(stage.stage, expectedStage);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    return { ready, stage };
  } finally {
    if (!child.killed) child.kill('SIGKILL');
  }
}
function open(path) {
  const store = createSqliteStore(path);
  const queue = createWorkOnce({ store, scope: 'lifecycle-process' }).define('job', {
    limits: { leaseMs: 10000, maxAttempts: 4, maxElapsedMs: 60000, maxDeferrals: 4 },
  });
  return { store, queue };
}
async function seedQueued(path) {
  const opened = open(path);
  try {
    await opened.queue.ensure(null, { key: 'job' });
  } finally {
    opened.store.close();
  }
}

test('SIGKILL after durable ensure but before ACK remains idempotent on restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-ensure-crash-'));
  const path = join(dir, 'queue.sqlite');
  try {
    await killAfterStage(path, 'ensure-after-commit', '', 'ensure-after-commit');
    const opened = open(path);
    try {
      const before = await opened.queue.inspect('job');
      assert.equal(before.phase.state, 'queued');
      assert.equal(before.revision, 1);
      const rawBefore = (await opened.store.getMany([before.id])).rows[0];
      const replay = await opened.queue.ensure({ value: 1 }, { key: 'job' });
      assert.equal(replay.id, before.id);
      assert.equal(replay.revision, before.revision);
      assert.deepEqual(replay.phase, before.phase);
      assert.deepEqual(replay.input, before.input);
      const rawAfter = (await opened.store.getMany([before.id])).rows[0];
      assert.deepEqual(rawAfter, rawBefore);
      await assert.rejects(
        opened.queue.ensure({ value: 2 }, { key: 'job' }),
        (error) => error?.code === 'key_conflict',
      );
    } finally {
      opened.store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGKILL after durable renewal but before ACK preserves the renewed current fence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-renew-crash-'));
  const path = join(dir, 'queue.sqlite');
  try {
    await seedQueued(path);
    const { ready, stage } = await killAfterStage(
      path,
      'renew-after-commit',
      '',
      'renew-after-commit',
    );
    assert.deepEqual(stage.ref, ready.ref);
    const opened = open(path);
    try {
      const before = await opened.queue.inspect('job');
      assert.equal(before.phase.state, 'running');
      assert.equal(before.phase.attempt.fence, ready.ref.fence);
      assert.equal(before.revision, stage.revision);
      const renewedAgain = await opened.queue.renew(ready.ref);
      assert.equal(renewedAgain.attempt.fence, ready.ref.fence);
      assert.ok((await opened.queue.inspect('job')).revision > before.revision);
    } finally {
      opened.store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const outcomeKind of ['succeed', 'fail']) {
  test(`SIGKILL after durable ${outcomeKind} settlement but before ACK replays terminal receipt`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `workonce-${outcomeKind}-crash-`));
    const path = join(dir, 'queue.sqlite');
    try {
      await seedQueued(path);
      const { ready } = await killAfterStage(
        path,
        'terminal-after-commit',
        outcomeKind,
        'terminal-after-commit',
      );
      const opened = open(path);
      try {
        const row = (await opened.store.getMany([ready.ref.workId])).rows[0];
        const expectedState = outcomeKind === 'succeed' ? 'succeeded' : 'failed';
        assert.equal(row.phase.state, expectedState);
        assert.equal(row.receipt.attempt.fence, ready.ref.fence);
        const outcome =
          outcomeKind === 'succeed'
            ? { type: 'succeed', result: { value: 2 }, next: [] }
            : { type: 'fail', reason: 'bad', manualRetry: true, next: [] };
        const replay = await opened.queue.settle(ready.ref, outcome);
        assert.deepEqual(replay, row.phase);
        const after = (await opened.store.getMany([ready.ref.workId])).rows[0];
        assert.deepEqual(after, row);
      } finally {
        opened.store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('SIGKILL mid multi-record claim pass preserves later due work for the next invocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-claim-scan-crash-'));
  const path = join(dir, 'queue.sqlite');
  try {
    const seeded = open(path);
    try {
      for (const key of ['a', 'b', 'c', 'd', 'e']) await seeded.queue.ensure(key, { key });
    } finally {
      seeded.store.close();
    }
    const { stage } = await killAfterStage(
      path,
      'claim-scan-after-first-commit',
      '',
      'claim-scan-after-first-commit',
    );
    assert.equal(stage.ref.workerId, 'child-scan');
    const opened = open(path);
    try {
      const before = await opened.queue.inspectMany(['a', 'b', 'c', 'd', 'e']);
      assert.equal(before.filter((snapshot) => snapshot.phase.state === 'running').length, 1);
      assert.equal(before.filter((snapshot) => snapshot.phase.state === 'queued').length, 4);
      const next = await opened.queue.claim({ workerId: 'restart', limit: 3 });
      assert.equal(next.length, 3);
      assert.ok(next.every((run) => run.ref.workId !== stage.ref.workId));
      const tail = await opened.queue.claim({ workerId: 'restart', limit: 3 });
      assert.equal(tail.length, 1);
      assert.notEqual(tail[0].ref.workId, stage.ref.workId);
      assert.equal(new Set([...next, ...tail].map((run) => run.ref.workId)).size, 4);
    } finally {
      opened.store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function seedTerminal(path, resetKind) {
  const opened = open(path);
  try {
    await opened.queue.ensure(null, { key: 'job' });
    const [run] = await opened.queue.claim({ workerId: 'seed' });
    if (resetKind === 'retry') await run.settle(run.fail('bad', { manualRetry: true }));
    else await run.settle(run.succeed('done'));
  } finally {
    opened.store.close();
  }
}

for (const resetKind of ['retry', 'rerun']) {
  test(`SIGKILL after durable ${resetKind} reset but before ACK advances generation exactly once`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `workonce-${resetKind}-crash-`));
    const path = join(dir, 'queue.sqlite');
    try {
      await seedTerminal(path, resetKind);
      await killAfterStage(path, 'reset-after-commit', resetKind, 'reset-after-commit');
      const opened = open(path);
      try {
        const current = await opened.queue.inspect('job');
        assert.equal(current.generation, 2);
        assert.equal(current.phase.state, 'queued');
        const row = (await opened.store.getMany([current.id])).rows[0];
        assert.equal(row.receipt, undefined);
        const stale =
          resetKind === 'retry'
            ? opened.queue.retry({ key: 'job', generation: 1 })
            : opened.queue.rerun({ key: 'job', generation: 1 });
        await assert.rejects(stale, (error) => error?.code === 'generation_conflict');
        const [next] = await opened.queue.claim({ workerId: 'restart' });
        assert.ok(next);
        assert.equal(next.ref.generation, 2);
      } finally {
        opened.store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
