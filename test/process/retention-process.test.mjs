import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWorkOnce, succeed } from '../../dist/index.js';
import { createSqliteStore } from '../../dist/sqlite.js';
import { forkWithInbox, nextChildMessage } from './child-ipc-inbox.mjs';

const childUrl = new URL('./retention-child.mjs', import.meta.url);

test('SIGKILL after terminal commit preserves expiry, physical deletion and incarnation fencing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-retention-crash-'));
  const path = join(directory, 'queue.sqlite');
  const child = forkWithInbox(
    childUrl,
    [path],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    'retention crash child',
  );
  let store;
  try {
    const committed = await nextChildMessage(child, 15_000);
    assert.equal(committed.stage, 'terminal-committed');
    assert.equal(committed.snapshot.phase.state, 'succeeded');
    assert.match(committed.snapshot.incarnation, /^[0-9a-f]{32}$/u);
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(15_000) });
    child.kill('SIGKILL');
    const [, signal] = await exited;
    assert.equal(signal, 'SIGKILL');

    store = createSqliteStore(path, { now: () => 100 });
    let queue = createWorkOnce({ store, scope: 'retention-crash' }).define('job', {
      retention: { afterTerminalMs: 0 },
    });
    const recovered = await queue.inspect('same');
    assert.equal(recovered.phase.state, 'succeeded');
    assert.equal(recovered.incarnation, committed.snapshot.incarnation);
    assert.equal(await queue.prune(), 1);
    assert.equal(await queue.inspect('same'), undefined);
    assert.equal((await store.getMany([committed.snapshot.id])).rows[0], undefined);

    const fresh = await queue.ensure({ payload: 1 }, { key: 'same' });
    assert.notEqual(fresh.incarnation, committed.snapshot.incarnation);
    await assert.rejects(
      queue.heartbeat(committed.ref),
      (error) => error?.code === 'stale_attempt',
    );
    await assert.rejects(
      queue.settle(committed.ref, succeed()),
      (error) => error?.code === 'stale_attempt',
    );
    assert.equal((await queue.inspect('same')).phase.state, 'queued');

    store.close();
    store = createSqliteStore(path, { now: () => 100 });
    queue = createWorkOnce({ store, scope: 'retention-crash' }).define('job', {
      retention: { afterTerminalMs: 0 },
    });
    const restarted = await queue.inspect('same');
    assert.equal(restarted.incarnation, fresh.incarnation);
    assert.equal(restarted.phase.state, 'queued');
  } finally {
    try {
      store?.close();
    } catch {
      // A success-path close may already have closed this handle.
    }
    if (!child.killed) child.kill();
    await sleep(30);
    rmSync(directory, { recursive: true, force: true });
  }
});
