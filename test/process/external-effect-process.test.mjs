import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkWithInbox, nextChildMessage } from './child-ipc-inbox.mjs';
import { createWorkOnce, runExternalAvailable } from '../../dist/index.js';
import { createSqliteStore } from '../../dist/sqlite.js';

const childUrl = new URL('./external-effect-child.mjs', import.meta.url);
const childMessageTimeoutMs = 15_000;
const fixtureLeaseMs = childMessageTimeoutMs * 2;
function effects(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(Number);
}
const message = (child) => nextChildMessage(child, childMessageTimeoutMs);
function start(dbPath, effectPath, mode) {
  return forkWithInbox(
    childUrl,
    [dbPath, effectPath, mode, String(fixtureLeaseMs)],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    'External-effect child',
  );
}
async function setup(dbPath) {
  const store = createSqliteStore(dbPath);
  try {
    const work = createWorkOnce({ store, scope: 'external-effect-process' });
    const queue = work.define('job', {
      key: (input) => input.id,
      limits: { leaseMs: fixtureLeaseMs, maxAttempts: 4, maxElapsedMs: 60_000 },
    });
    await queue.ensure({ id: 'x' });
  } finally {
    store.close();
  }
}
function reopen(dbPath, now) {
  const store = createSqliteStore(dbPath, now === undefined ? {} : { now: () => now });
  const work = createWorkOnce({ store, scope: 'external-effect-process' });
  const queue = work.define('job', {
    key: (input) => input.id,
    limits: { leaseMs: fixtureLeaseMs, maxAttempts: 4, maxElapsedMs: 60_000 },
  });
  const service = queue.serveExternal({
    prepare: (run) => run.handoff(run.input),
    onPrepareError: (run) => run.fail('prepare_failed'),
  });
  return { store, queue, service };
}
async function killAfter(child, expectedStage) {
  assert.equal((await message(child)).ready, true);
  let stage = await message(child);
  if (stage.stage === 'effect-recorded' && expectedStage === 'settlement-committed')
    stage = await message(child);
  assert.equal(stage.stage, expectedStage);
  if (child.exitCode !== null || child.signalCode !== null)
    throw new Error(
      `External-effect child exited before SIGKILL: code=${String(child.exitCode)} signal=${String(child.signalCode)}`,
    );
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(childMessageTimeoutMs) });
  child.kill('SIGKILL');
  const [, signal] = await exited;
  assert.equal(signal, 'SIGKILL');
  return stage;
}

test('external effect before WorkOnce settlement may repeat after crash and reclaim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-external-effect-before-'));
  const dbPath = join(dir, 'queue.sqlite');
  const effectPath = join(dir, 'effects.log');
  let child;
  try {
    await setup(dbPath);
    child = start(dbPath, effectPath, 'before-settle');
    const stage = await killAfter(child, 'effect-recorded');
    assert.deepEqual(effects(effectPath), [1]);
    let opened = reopen(dbPath);
    let expiredAt;
    try {
      const running = await opened.queue.inspect('x');
      assert.equal(running.phase.state, 'running');
      assert.equal(running.phase.attempt.fence, 1);
      expiredAt = running.phase.attempt.leaseUntil + 1;
    } finally {
      opened.store.close();
    }
    opened = reopen(dbPath, expiredAt);
    try {
      let reruns = 0;
      const [result] = await runExternalAvailable(
        opened.service,
        { workerId: 'restart', signal: new AbortController().signal },
        async (run) => {
          reruns++;
          const { appendFileSync } = await import('node:fs');
          appendFileSync(effectPath, `${run.attempt.fence}\n`);
          return run.succeed();
        },
      );
      assert.equal(result.status, 'settled');
      assert.equal(reruns, 1);
      assert.deepEqual(effects(effectPath), [1, 2]);
      assert.equal((await opened.queue.inspect('x')).phase.state, 'succeeded');
      await assert.rejects(
        opened.service.settle(stage.attempt, { type: 'succeed', result: null, next: [] }),
        (error) => error?.code === 'stale_attempt',
      );
    } finally {
      opened.store.close();
    }
  } finally {
    if (child && !child.killed) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('durable WorkOnce settlement before executor ACK prevents re-claim after crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-external-effect-after-'));
  const dbPath = join(dir, 'queue.sqlite');
  const effectPath = join(dir, 'effects.log');
  let child;
  try {
    await setup(dbPath);
    child = start(dbPath, effectPath, 'after-settle');
    const stage = await killAfter(child, 'settlement-committed');
    assert.deepEqual(effects(effectPath), [1]);
    const opened = reopen(dbPath);
    try {
      assert.equal((await opened.queue.inspect('x')).phase.state, 'succeeded');
      let reruns = 0;
      const later = await runExternalAvailable(
        opened.service,
        { workerId: 'restart', signal: new AbortController().signal },
        async (run) => {
          reruns++;
          return run.succeed();
        },
      );
      assert.equal(later.length, 0);
      assert.equal(reruns, 0);
      assert.deepEqual(effects(effectPath), [1]);
      const beforeReplay = (await opened.store.getMany([stage.attempt.workId])).rows[0];
      const replay = await opened.service.settle(stage.attempt, stage.outcome);
      assert.equal(replay.state, 'succeeded');
      const afterReplay = (await opened.store.getMany([stage.attempt.workId])).rows[0];
      assert.deepEqual(
        afterReplay,
        beforeReplay,
        'settlement replay must not rewrite durable state',
      );
    } finally {
      opened.store.close();
    }
  } finally {
    if (child && !child.killed) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
