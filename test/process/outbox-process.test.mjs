import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWorkOnce } from '../../dist/index.js';
import { createSqliteStore } from '../../dist/sqlite.js';

const childUrl = new URL('./outbox-child.mjs', import.meta.url);
function start(path, mode, parentId) {
  return fork(childUrl, [path, mode, parentId], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
}
async function message(child) {
  return (await once(child, 'message', { signal: AbortSignal.timeout(15000) }))[0];
}
async function setup(path, childKeys) {
  const store = createSqliteStore(path);
  const work = createWorkOnce({ store, scope: 'outbox-process' });
  const parent = work.define('parent');
  const child = work.define('child');
  const snapshot = await parent.ensure(null, { key: 'p' });
  const [run] = await parent.claim({ workerId: 'setup' });
  await run.settle(
    run.succeed(null, { next: childKeys.map((key) => child.request(null, { key })) }),
  );
  store.close();
  return snapshot.id;
}
async function setupPoison(path) {
  const store = createSqliteStore(path);
  const work = createWorkOnce({ store, scope: 'outbox-process' });
  const parent = work.define('parent');
  const child = work.define('child');
  await child.ensure({ original: true }, { key: 'poison' });
  const snapshot = await parent.ensure(null, { key: 'p' });
  const [run] = await parent.claim({ workerId: 'setup' });
  await run.settle(
    run.succeed(null, {
      next: [
        child.request({ wrong: true }, { key: 'poison' }),
        child.request(null, { key: 'healthy' }),
      ],
    }),
  );
  store.close();
  return snapshot.id;
}

async function killAtStage(path, mode, parentId, expectedStage) {
  const child = start(path, mode, parentId);
  try {
    assert.equal((await message(child)).ready, true);
    const stage = message(child);
    child.send('go');
    assert.equal((await stage).stage, expectedStage);
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Outbox child exited before SIGKILL: code=${String(child.exitCode)} signal=${String(child.signalCode)}`,
      );
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(15000) });
    child.kill('SIGKILL');
    const [, signal] = await exited;
    assert.equal(signal, 'SIGKILL');
  } finally {
    if (!child.killed) child.kill('SIGKILL');
  }
}

test('SIGKILL before outbox dispatch leaves all durable intent unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-outbox-before-crash-'));
  const path = join(dir, 'queue.sqlite');
  let childProcess;
  try {
    const parentId = await setup(path, ['c1', 'c2']);
    childProcess = start(path, 'after-child', parentId);
    assert.equal((await message(childProcess)).ready, true);
    if (childProcess.exitCode !== null || childProcess.signalCode !== null)
      throw new Error(
        `Outbox child exited before SIGKILL: code=${String(childProcess.exitCode)} signal=${String(childProcess.signalCode)}`,
      );
    const exited = once(childProcess, 'exit', { signal: AbortSignal.timeout(15000) });
    childProcess.kill('SIGKILL');
    const [, signal] = await exited;
    assert.equal(signal, 'SIGKILL');
    const store = createSqliteStore(path);
    try {
      const work = createWorkOnce({ store, scope: 'outbox-process' });
      const parent = work.define('parent');
      const child = work.define('child');
      assert.equal((await parent.inspect('p')).pendingFollowups, 2);
      assert.equal(await child.inspect('c1'), undefined);
      assert.equal(await child.inspect('c2'), undefined);
    } finally {
      store.close();
    }
  } finally {
    if (childProcess && !childProcess.killed) childProcess.kill('SIGKILL');
    await sleep(20);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGKILL after durable child insert preserves parent intent and replay converges', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-outbox-child-crash-'));
  const path = join(dir, 'queue.sqlite');
  try {
    const parentId = await setup(path, ['c1', 'c2']);
    await killAtStage(path, 'after-child', parentId, 'child-committed');
    const store = createSqliteStore(path);
    try {
      const work = createWorkOnce({ store, scope: 'outbox-process' });
      const parent = work.define('parent');
      const child = work.define('child');
      assert.ok(await child.inspect('c1'));
      assert.equal(await child.inspect('c2'), undefined);
      assert.equal((await parent.inspect('p')).pendingFollowups, 2);
      assert.equal(await work.dispatch({ limit: 2 }), 2);
      assert.equal((await parent.inspect('p')).pendingFollowups, 0);
      assert.ok(await child.inspect('c1'));
      assert.ok(await child.inspect('c2'));
    } finally {
      store.close();
    }
  } finally {
    await sleep(20);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGKILL after durable parent ack preserves drained intent without duplicate work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-outbox-parent-crash-'));
  const path = join(dir, 'queue.sqlite');
  try {
    const parentId = await setup(path, ['c1', 'c2']);
    await killAtStage(path, 'after-parent-ack', parentId, 'parent-acked');
    const store = createSqliteStore(path);
    try {
      const work = createWorkOnce({ store, scope: 'outbox-process' });
      const parent = work.define('parent');
      const child = work.define('child');
      assert.ok(await child.inspect('c1'));
      assert.equal(await child.inspect('c2'), undefined);
      assert.equal((await parent.inspect('p')).pendingFollowups, 1);
      assert.equal(await work.dispatch({ limit: 1 }), 1);
      assert.equal((await parent.inspect('p')).pendingFollowups, 0);
      assert.ok(await child.inspect('c1'));
      assert.ok(await child.inspect('c2'));
    } finally {
      store.close();
    }
  } finally {
    await sleep(20);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGKILL after poison rotation preserves retained failure and exposes healthy sibling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-outbox-rotation-crash-'));
  const path = join(dir, 'queue.sqlite');
  try {
    const parentId = await setupPoison(path);
    await killAtStage(path, 'after-rotation', parentId, 'parent-rotated');
    const store = createSqliteStore(path);
    try {
      const work = createWorkOnce({ store, scope: 'outbox-process' });
      const parent = work.define('parent');
      const child = work.define('child');
      assert.equal((await parent.inspect('p')).pendingFollowups, 2);
      assert.ok(await child.inspect('poison'));
      assert.equal(await child.inspect('healthy'), undefined);
      assert.equal(await work.dispatch({ limit: 1 }), 1);
      assert.ok(await child.inspect('healthy'));
      assert.equal((await parent.inspect('p')).pendingFollowups, 1);
      await assert.rejects(work.dispatch({ limit: 1 }), (error) => error?.code === 'key_conflict');
      assert.equal((await parent.inspect('p')).pendingFollowups, 1);
    } finally {
      store.close();
    }
  } finally {
    await sleep(20);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two successive SIGKILL prefixes preserve one child exactly and drain the remaining intent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workonce-outbox-repeated-crash-'));
  const path = join(dir, 'queue.sqlite');
  try {
    const parentId = await setup(path, ['c1', 'c2']);
    await killAtStage(path, 'after-child', parentId, 'child-committed');
    await killAtStage(path, 'after-parent-ack', parentId, 'parent-acked');
    const store = createSqliteStore(path);
    try {
      const work = createWorkOnce({ store, scope: 'outbox-process' });
      const parent = work.define('parent');
      const child = work.define('child');
      assert.ok(await child.inspect('c1'));
      assert.equal(await child.inspect('c2'), undefined);
      assert.equal((await parent.inspect('p')).pendingFollowups, 1);
      assert.equal(await work.dispatch({ limit: 1 }), 1);
      assert.ok(await child.inspect('c2'));
      assert.equal((await parent.inspect('p')).pendingFollowups, 0);
    } finally {
      store.close();
    }
  } finally {
    await sleep(20);
    rmSync(dir, { recursive: true, force: true });
  }
});
