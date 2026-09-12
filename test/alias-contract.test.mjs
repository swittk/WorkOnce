import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as root from '../dist/index.js';
import * as memory from '../dist/memory.js';
import * as external from '../dist/external.js';

const require = createRequire(import.meta.url);

async function exerciseRuntimeAliases(api, memoryApi, label) {
  for (const name of ['wait', 'defer', 'runExternalAvailable', 'processExternal'])
    assert.equal(typeof api[name], 'function', `${label}.${name}`);
  for (const [type, names] of [
    [
      api.WorkQueue,
      ['ensure', 'enqueue', 'runAvailable', 'process', 'heartbeat', 'renew', 'restart'],
    ],
    [api.WorkItem, ['ensure', 'enqueue', 'retry', 'rerun', 'restart']],
    [api.WorkRun, ['wait', 'defer', 'heartbeat', 'renew']],
    [api.ExternalWorkRun, ['wait', 'defer']],
  ]) {
    for (const name of names)
      assert.equal(typeof type.prototype[name], 'function', `${label}.${type.name}.${name}`);
  }

  assert.deepEqual(api.wait('pending', { afterMs: 7 }), api.defer('pending', { afterMs: 7 }));
  const externalRun = new api.ExternalWorkRun(
    { workId: `${label}:external`, generation: 1, fence: 1 },
    10,
    0,
  );
  assert.deepEqual(
    externalRun.wait('pending', { afterMs: 7 }),
    externalRun.defer('pending', { afterMs: 7 }),
  );

  let now = 1000;
  const work = api.createWorkOnce({
    store: memoryApi.createMemoryStore({ now: () => now }),
    scope: `alias-${label}`,
  });
  const queue = work.define('job', {
    perform: async (run) => run.succeed('done'),
  });
  const enqueued = await queue.enqueue(null, { key: 'same' });
  const ensured = await queue.ensure(null, { key: 'same' });
  assert.equal(enqueued.id, ensured.id, `${label}.enqueue/ensure identity`);
  const processed = await queue.process({ workerId: `${label}:process` });
  assert.equal(processed[0]?.status, 'settled', `${label}.process/runAvailable semantics`);
  assert.equal((await queue.inspect('same')).phase.result, 'done');

  await queue.enqueue(null, { key: 'lease' });
  const [run] = await queue.claim({ workerId: `${label}:lease` });
  assert.deepEqual(run.wait('pending', { afterMs: 3 }), run.defer('pending', { afterMs: 3 }));
  const heartbeat = await run.heartbeat();
  const renewed = await run.renew();
  assert.equal(heartbeat.attempt.workId, renewed.attempt.workId);
  assert.equal(heartbeat.attempt.generation, renewed.attempt.generation);
  assert.equal(heartbeat.attempt.fence, renewed.attempt.fence);
  assert.equal(heartbeat.attempt.leaseUntil, renewed.attempt.leaseUntil);
  await run.settle(run.succeed('leased'));

  const externalQueue = work.define('external');
  const service = externalQueue.serveExternal({
    prepare: (leased) => leased.handoff(leased.input),
    onPrepareError: (leased) => leased.fail('prepare_failed'),
  });
  await service.ensure(null, { key: 'external' });
  const externalProcessed = await api.processExternal(
    service,
    { workerId: `${label}:external`, signal: new AbortController().signal },
    async (leased) => leased.succeed(),
  );
  assert.equal(
    externalProcessed[0]?.status,
    'settled',
    `${label}.processExternal/runExternalAvailable semantics`,
  );
}

// Readable and technical names are intentional first-class aliases, not old-format compatibility.
test('ESM and CommonJS aliases execute the same hardened operations, not merely similarly-shaped APIs', async () => {
  await exerciseRuntimeAliases(root, memory, 'esm');
  await exerciseRuntimeAliases(
    require('../dist-cjs/index.js'),
    require('../dist-cjs/memory.js'),
    'commonjs',
  );
  for (const api of [external, require('../dist-cjs/external.js')])
    assert.equal(typeof api.processExternal, 'function');
});

async function exerciseRestartSemantics(api, memoryApi, label) {
  const work = api.createWorkOnce({
    store: memoryApi.createMemoryStore({ now: () => 1000 }),
    scope: `restart-alias-${label}`,
  });
  const queue = work.define('job');

  const queued = await queue.ensure(null, { key: 'queued' });
  let queuedRestart;
  await assert.doesNotReject(async () => {
    queuedRestart = await queue.restart({ key: 'queued', expectedGeneration: queued.generation });
  }, `${label}.restart must not reject outside terminal states`);
  assert.deepEqual(
    queuedRestart,
    queued,
    `${label}.restart is a no-op outside terminal states rather than inventing a transition`,
  );

  await assert.rejects(
    queue.restart({ key: 'queued', expectedGeneration: queued.generation + 1 }),
    (error) => error instanceof api.WorkConflict && error.code === 'generation_conflict',
  );
  await assert.rejects(
    queue.restart({ key: 'queued', check: async () => false }),
    (error) => error instanceof api.WorkConflict && error.code === 'retry_denied',
  );
  await queue.cancel({ key: 'queued', generation: 1 });

  await queue.ensure(null, { key: 'failed' });
  const [failedRun] = await queue.claim({ workerId: `${label}:fail`, limit: 1 });
  await failedRun.settle(failedRun.fail('repair', { manualRetry: true }));
  const failedRestart = await queue.restart({ key: 'failed', expectedGeneration: 1 });
  assert.equal(failedRestart.generation, 2);
  assert.equal(failedRestart.phase.state, 'queued');
  await queue.cancel({ key: 'failed', generation: 2 });

  await queue.ensure(null, { key: 'succeeded' });
  const [succeededRun] = await queue.claim({ workerId: `${label}:succeed`, limit: 1 });
  await succeededRun.settle(succeededRun.succeed());
  const succeededRestart = await queue.restart({ key: 'succeeded', expectedGeneration: 1 });
  assert.equal(succeededRestart.generation, 2);
  assert.equal(succeededRestart.phase.state, 'queued');
}

test('restart preserves exact ergonomic-dispatch semantics and rejection causes', async () => {
  await exerciseRestartSemantics(root, memory, 'esm');
  await exerciseRestartSemantics(
    require('../dist-cjs/index.js'),
    require('../dist-cjs/memory.js'),
    'commonjs',
  );
});
