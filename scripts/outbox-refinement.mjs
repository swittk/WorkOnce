import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompareExchangeStore } from '../dist/cas.js';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
import { createSqliteStore } from '../dist/sqlite.js';

function tracedStore(base) {
  const outboxQueries = [];
  return {
    store: {
      ...base,
      async query(query) {
        const result = await base.query(query);
        if (query.select === 'outbox')
          outboxQueries.push({
            afterId: query.afterId,
            rowIds: result.rows.map((row) => row.id),
          });
        return result;
      },
    },
    outboxQueries,
  };
}
async function terminal(queue, workerId, next) {
  const [run] = await queue.claim({ workerId, limit: 1 });
  if (!run) throw new Error('Expected a claimable parent');
  await run.settle(run.succeed(null, { next }));
}
async function orderedParents(work, store, scope, child, suffix) {
  const one = work.define(`parent-one-${suffix}`);
  const two = work.define(`parent-two-${suffix}`);
  const oneSnapshot = await one.ensure(null, { key: 'p' });
  const twoSnapshot = await two.ensure(null, { key: 'p' });
  const byId = new Map([
    [oneSnapshot.id, { queue: one, snapshot: oneSnapshot }],
    [twoSnapshot.id, { queue: two, snapshot: twoSnapshot }],
  ]);
  const rows = await store.query({ scope, select: 'all', limit: 20 });
  const ordered = rows.rows.map((row) => byId.get(row.id)).filter(Boolean);
  if (ordered.length !== 2) throw new Error('Could not recover adapter parent ordering');
  return { first: ordered[0], second: ordered[1], child };
}
async function rotationSample() {
  const base = createMemoryStore();
  const traced = tracedStore(base);
  const work = createWorkOnce({ store: traced.store, scope: 'outbox-rotation' });
  const child = work.define('child');
  const { first, second } = await orderedParents(
    work,
    traced.store,
    'outbox-rotation',
    child,
    'rotation',
  );
  await terminal(first.queue, 'first', [
    child.request(null, { key: 'a1' }),
    child.request(null, { key: 'a2' }),
  ]);
  await terminal(second.queue, 'second', [child.request(null, { key: 'b1' })]);
  traced.outboxQueries.length = 0;

  const pass1 = await work.dispatch({ limit: 1 });
  const firstPendingAfterFirst = (await first.queue.inspect('p')).pendingFollowups;
  const pass2 = await work.dispatch({ limit: 1 });
  const firstPendingAfterSecond = (await first.queue.inspect('p')).pendingFollowups;
  const b1AfterSecond = await child.inspect('b1');
  const pass3 = await work.dispatch({ limit: 1 });
  const firstPendingAfterThird = (await first.queue.inspect('p')).pendingFollowups;
  const a2AfterThird = await child.inspect('a2');
  const wrapped = traced.outboxQueries.some(
    (query, index, all) =>
      query.afterId === second.snapshot.id &&
      query.rowIds.length === 0 &&
      all[index + 1]?.afterId === undefined &&
      all[index + 1]?.rowIds[0] === first.snapshot.id,
  );
  return {
    kind: 'rotation',
    firstPassSent: pass1 === 1,
    firstParentPartiallyDrained: firstPendingAfterFirst === 1,
    secondPassSent: pass2 === 1,
    laterParentReached: b1AfterSecond !== undefined,
    firstParentStillReachable: firstPendingAfterSecond === 1,
    wrapped,
    thirdPassSent: pass3 === 1,
    firstParentDrained: firstPendingAfterThird === 0 && a2AfterThird !== undefined,
  };
}
async function poisonSample() {
  const base = createMemoryStore();
  const traced = tracedStore(base);
  const work = createWorkOnce({ store: traced.store, scope: 'outbox-poison' });
  const child = work.define('child');
  await child.ensure({ original: true }, { key: 'poison' });
  const { first, second } = await orderedParents(
    work,
    traced.store,
    'outbox-poison',
    child,
    'poison',
  );
  await terminal(first.queue, 'first', [
    child.request({ wrong: true }, { key: 'poison' }),
    child.request(null, { key: 'healthy' }),
  ]);
  await terminal(second.queue, 'second', [child.request(null, { key: 'neighbor' })]);
  traced.outboxQueries.length = 0;

  let firstError;
  try {
    await work.dispatch({ limit: 1 });
  } catch (error) {
    firstError = error;
  }
  const secondPass = await work.dispatch({ limit: 1 });
  const neighbor = await child.inspect('neighbor');
  const thirdPass = await work.dispatch({ limit: 1 });
  const healthy = await child.inspect('healthy');
  const pending = (await first.queue.inspect('p')).pendingFollowups;
  return {
    kind: 'poison',
    exactConflict: firstError?.code === 'key_conflict',
    laterParentReached: secondPass === 1 && neighbor !== undefined,
    healthySiblingReached: thirdPass === 1 && healthy !== undefined,
    poisonRetained: pending === 1,
  };
}
async function restartSample() {
  const base = createMemoryStore();
  const traced = tracedStore(base);
  let work = createWorkOnce({ store: traced.store, scope: 'outbox-restart' });
  let parent = work.define('parent');
  let child = work.define('child');
  await parent.ensure(null, { key: 'p' });
  await terminal(parent, 'first', [
    child.request(null, { key: 'r1' }),
    child.request(null, { key: 'r2' }),
  ]);
  await work.dispatch({ limit: 1 });
  const pendingBeforeRestart = (await parent.inspect('p')).pendingFollowups;

  traced.outboxQueries.length = 0;
  work = createWorkOnce({ store: traced.store, scope: 'outbox-restart' });
  parent = work.define('parent');
  child = work.define('child');
  const secondPass = await work.dispatch({ limit: 1 });
  const pendingAfterRestart = (await parent.inspect('p')).pendingFollowups;
  const restartedFromBeginning = traced.outboxQueries[0]?.afterId === undefined;
  return {
    kind: 'restart',
    pendingPreserved: pendingBeforeRestart === 1,
    restartedFromBeginning,
    remainingChildDelivered:
      secondPass === 1 && pendingAfterRestart === 0 && (await child.inspect('r2')) !== undefined,
  };
}
function createCasStore() {
  const native = createMemoryStore();
  const port = {
    getMany: (ids) => native.getMany(ids),
    query: (query) => native.query(query),
    compareExchange: (change) =>
      native.atomic(change.id, (row, clock) => {
        if (
          row?.revision !== change.expectedRevision ||
          (change.validUntil !== undefined && clock >= change.validUntil)
        )
          return { value: false };
        return { next: change.next, value: true };
      }),
  };
  return createCompareExchangeStore(port);
}
async function adapterRotationSample(adapter, base, cleanup = () => {}) {
  const scope = `outbox-adapter-${adapter}`;
  try {
    const traced = tracedStore(base);
    const work = createWorkOnce({ store: traced.store, scope });
    const child = work.define('child');
    const { first, second } = await orderedParents(
      work,
      traced.store,
      scope,
      child,
      `adapter-${adapter}`,
    );
    await terminal(first.queue, 'first', [
      child.request(null, { key: 'a1' }),
      child.request(null, { key: 'a2' }),
    ]);
    await terminal(second.queue, 'second', [child.request(null, { key: 'b1' })]);
    traced.outboxQueries.length = 0;
    const pass1 = await work.dispatch({ limit: 1 });
    const pass2 = await work.dispatch({ limit: 1 });
    const pass3 = await work.dispatch({ limit: 1 });
    const wrapped = traced.outboxQueries.some(
      (query, index, all) =>
        query.afterId === second.snapshot.id &&
        query.rowIds.length === 0 &&
        all[index + 1]?.afterId === undefined &&
        all[index + 1]?.rowIds[0] === first.snapshot.id,
    );
    return {
      kind: 'adapter',
      adapter,
      threePassesSent: pass1 === 1 && pass2 === 1 && pass3 === 1,
      laterParentReached: (await child.inspect('b1')) !== undefined,
      wrapped,
      firstParentDrained: (await first.queue.inspect('p')).pendingFollowups === 0,
    };
  } finally {
    cleanup();
  }
}
function sqliteFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-outbox-proof-'));
  const store = createSqliteStore(join(directory, 'workonce.sqlite'));
  return {
    store,
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function ackLossSample() {
  const base = createMemoryStore();
  let loseChildAck = true;
  const store = {
    ...base,
    async atomic(id, decide) {
      let next;
      const value = await base.atomic(id, (row, now) => {
        const change = decide(row, now);
        next = change.next;
        return change;
      });
      if (next?.kind === 'child' && loseChildAck) {
        loseChildAck = false;
        throw new Error('child ACK lost');
      }
      return value;
    },
  };
  const work = createWorkOnce({ store, scope: 'outbox-ack-loss' });
  const parent = work.define('parent');
  const child = work.define('child');
  await parent.ensure(null, { key: 'p' });
  await terminal(parent, 'first', [child.request(null, { key: 'c' })]);
  let firstError;
  try {
    await work.dispatch({ limit: 1 });
  } catch (error) {
    firstError = error;
  }
  const childAfterError = await child.inspect('c');
  const parentAfterError = await parent.inspect('p');
  const retry = await work.dispatch({ limit: 1 });
  const parentAfterRetry = await parent.inspect('p');
  return {
    kind: 'ackLoss',
    exactFailure: firstError?.message === 'child ACK lost',
    childDurableBeforeAck: childAfterError !== undefined,
    parentIntentRetained: parentAfterError.pendingFollowups === 1,
    retryConverged: retry === 1 && parentAfterRetry.pendingFollowups === 0,
  };
}

export async function runOutboxRefinementSamples() {
  const sqlite = sqliteFixture();
  return Promise.all([
    rotationSample(),
    poisonSample(),
    restartSample(),
    ackLossSample(),
    adapterRotationSample('memory', createMemoryStore()),
    adapterRotationSample('sqlite', sqlite.store, sqlite.cleanup),
    adapterRotationSample('cas', createCasStore()),
  ]);
}

export function assertOutboxRefinementSamples(samples) {
  const kinds = samples.map((sample) => sample.kind);
  const expectedKinds = [
    'rotation',
    'poison',
    'restart',
    'ackLoss',
    'adapter',
    'adapter',
    'adapter',
  ];
  if (JSON.stringify(kinds) !== JSON.stringify(expectedKinds))
    throw new Error(`Unexpected outbox sample kinds: ${JSON.stringify(kinds)}`);
  const adapters = samples
    .filter((sample) => sample.kind === 'adapter')
    .map((sample) => sample.adapter)
    .sort();
  if (JSON.stringify(adapters) !== JSON.stringify(['cas', 'memory', 'sqlite']))
    throw new Error(`Unexpected outbox adapter set: ${JSON.stringify(adapters)}`);
  for (const sample of samples) {
    for (const [field, value] of Object.entries(sample)) {
      if (field === 'kind' || field === 'adapter') continue;
      if (value !== true) throw new Error(`Outbox refinement failed: ${sample.kind}.${field}`);
    }
  }
}
