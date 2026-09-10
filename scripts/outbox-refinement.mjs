import { createCompareExchangeStore } from '../dist/cas.js';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
import { createRefinementSqliteFixture } from './refinement-sqlite-fixture.mjs';
import { assertExactBooleanSample } from './refinement-sample-schema.mjs';

function within(promise, label, timeoutMs = 3000) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`outbox refinement timed out waiting for ${label}`)),
        timeoutMs,
      );
    }),
  ]);
}

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

async function adapterBudgetSample(adapter, base, cleanup = () => {}) {
  const scope = `outbox-adapter-budget-${adapter}`;
  try {
    const work = createWorkOnce({ store: base, scope });
    const child = work.define('child');
    const [first, second, third] = await orderedParentQueues(
      work,
      base,
      scope,
      3,
      `budget-${adapter}`,
    );
    await terminal(first.queue, 'first', [
      child.request(null, { key: 'a1' }),
      child.request(null, { key: 'a2' }),
      child.request(null, { key: 'a3' }),
    ]);
    await terminal(second.queue, 'second', [
      child.request(null, { key: 'b1' }),
      child.request(null, { key: 'b2' }),
    ]);
    await terminal(third.queue, 'third', [child.request(null, { key: 'c1' })]);
    const counts = [
      await work.dispatch({ limit: 2 }),
      await work.dispatch({ limit: 2 }),
      await work.dispatch({ limit: 2 }),
      await work.dispatch({ limit: 2 }),
    ];
    const snapshots = await Promise.all(
      [first, second, third].map((parent) => parent.queue.inspect('p')),
    );
    const children = await Promise.all(
      ['a1', 'a2', 'a3', 'b1', 'b2', 'c1'].map((key) => child.inspect(key)),
    );
    const maxSafeParent = work.define(`max-safe-${adapter}`);
    await maxSafeParent.ensure(null, { key: 'p' });
    await terminal(maxSafeParent, 'max-safe', [child.request(null, { key: 'max-safe' })]);
    const maxSafeCount = await work.dispatch({ limit: Number.MAX_SAFE_INTEGER });
    return {
      kind: 'adapterBudget',
      adapter,
      exactCounts: JSON.stringify(counts) === JSON.stringify([2, 2, 1, 1]),
      allParentsDrained: snapshots.every((snapshot) => snapshot.pendingFollowups === 0),
      allChildrenDurable: children.every((snapshot) => snapshot !== undefined),
      maxSafeLimitWorks:
        maxSafeCount === 1 &&
        (await maxSafeParent.inspect('p')).pendingFollowups === 0 &&
        (await child.inspect('max-safe')) !== undefined,
    };
  } finally {
    cleanup();
  }
}

function sqliteFixture() {
  const sqlite = createRefinementSqliteFixture('workonce-outbox-proof-', 'workonce.sqlite');
  return { store: sqlite.store, cleanup: sqlite.close };
}

function ambiguousCasFixture() {
  const native = createMemoryStore({ now: () => 1000 });
  let fault;
  const port = {
    getMany: (ids) => native.getMany(ids),
    query: (query) => native.query(query),
    async compareExchange(change) {
      const applied = await native.atomic(change.id, (row, clock) => {
        if (
          row?.revision !== change.expectedRevision ||
          (change.validUntil !== undefined && clock >= change.validUntil)
        )
          return { value: false };
        return { next: change.next, value: true };
      });
      if (applied && fault?.predicate(change)) {
        const message = fault.message;
        fault = undefined;
        throw new Error(message);
      }
      return applied;
    },
  };
  return {
    store: createCompareExchangeStore(port),
    failNext(predicate, message) {
      fault = { predicate, message };
    },
  };
}

async function casAckLossSample() {
  const childFixture = ambiguousCasFixture();
  const childWork = createWorkOnce({ store: childFixture.store, scope: 'outbox-cas-child-ack' });
  const childParent = childWork.define('parent');
  const childQueue = childWork.define('child');
  await childParent.ensure(null, { key: 'p' });
  await terminal(childParent, 'first', [childQueue.request(null, { key: 'c' })]);
  childFixture.failNext((change) => change.next.kind === 'child', 'child CAS ACK lost');
  let childFailure;
  try {
    await childWork.dispatch({ limit: 1 });
  } catch (error) {
    childFailure = error;
  }
  const childDurable = (await childQueue.inspect('c')) !== undefined;
  const childIntentRetained = (await childParent.inspect('p')).pendingFollowups === 1;
  const childRetry = await childWork.dispatch({ limit: 1 });

  const parentFixture = ambiguousCasFixture();
  const parentWork = createWorkOnce({ store: parentFixture.store, scope: 'outbox-cas-parent-ack' });
  const parentQueue = parentWork.define('parent');
  const parentChild = parentWork.define('child');
  const parentSnapshot = await parentQueue.ensure(null, { key: 'p' });
  await terminal(parentQueue, 'first', [parentChild.request(null, { key: 'c' })]);
  parentFixture.failNext(
    (change) => change.id === parentSnapshot.id && change.next.outbox.length === 0,
    'parent CAS ACK lost',
  );
  let parentFailure;
  try {
    await parentWork.dispatch({ limit: 1 });
  } catch (error) {
    parentFailure = error;
  }
  const parentDrained = (await parentQueue.inspect('p')).pendingFollowups === 0;
  const parentChildDurable = (await parentChild.inspect('c')) !== undefined;
  const parentRetry = await parentWork.dispatch({ limit: 1 });

  return {
    kind: 'casAckLoss',
    exactChildAckLoss: childFailure?.message === 'child CAS ACK lost',
    childCommitAmbiguityConverges:
      childDurable &&
      childIntentRetained &&
      childRetry === 1 &&
      (await childParent.inspect('p')).pendingFollowups === 0,
    exactParentAckLoss: parentFailure?.message === 'parent CAS ACK lost',
    parentCommitAmbiguityConverges: parentDrained && parentChildDurable && parentRetry === 0,
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

async function orderedParentQueues(work, store, scope, count, suffix) {
  const entries = [];
  for (let index = 0; index < count; index++) {
    const queue = work.define(`parent-${index}-${suffix}`);
    const snapshot = await queue.ensure(null, { key: 'p' });
    entries.push([snapshot.id, { queue, snapshot }]);
  }
  const byId = new Map(entries);
  const rows = await store.query({ scope, select: 'all', limit: count + 10 });
  const ordered = rows.rows.map((row) => byId.get(row.id)).filter(Boolean);
  if (ordered.length !== count)
    throw new Error('Could not recover complete adapter parent ordering');
  return ordered;
}

async function budgetMatrixSample() {
  const base = createMemoryStore({ now: () => 1000 });
  const traced = tracedStore(base);
  const scope = 'outbox-budget-matrix';
  const work = createWorkOnce({ store: traced.store, scope });
  const child = work.define('child');
  const [first, second, third] = await orderedParentQueues(work, traced.store, scope, 3, 'budget');
  await terminal(first.queue, 'first', [
    child.request(null, { key: 'a1' }),
    child.request(null, { key: 'a2' }),
    child.request(null, { key: 'a3' }),
  ]);
  await terminal(second.queue, 'second', [
    child.request(null, { key: 'b1' }),
    child.request(null, { key: 'b2' }),
  ]);
  await terminal(third.queue, 'third', [child.request(null, { key: 'c1' })]);
  traced.outboxQueries.length = 0;

  const counts = [];
  counts.push(await work.dispatch({ limit: 2 }));
  const afterFirst = {
    a1: (await child.inspect('a1')) !== undefined,
    a2: (await child.inspect('a2')) !== undefined,
    a3: (await child.inspect('a3')) !== undefined,
  };
  counts.push(await work.dispatch({ limit: 2 }));
  const afterSecond = {
    b1: (await child.inspect('b1')) !== undefined,
    b2: (await child.inspect('b2')) !== undefined,
  };
  counts.push(await work.dispatch({ limit: 2 }));
  const afterThird = (await child.inspect('c1')) !== undefined;
  counts.push(await work.dispatch({ limit: 2 }));
  const afterFourth = (await child.inspect('a3')) !== undefined;
  const wrapped = traced.outboxQueries.some(
    (query, index, all) =>
      query.afterId === third.snapshot.id &&
      query.rowIds.length === 0 &&
      all[index + 1]?.afterId === undefined &&
      all[index + 1]?.rowIds[0] === first.snapshot.id,
  );

  const largeScope = 'outbox-large-budget';
  const largeBase = createMemoryStore({ now: () => 1000 });
  const large = createWorkOnce({ store: largeBase, scope: largeScope });
  const largeChildQueue = large.define('child');
  const largeParents = await orderedParentQueues(large, largeBase, largeScope, 3, 'large');
  for (let index = 0; index < largeParents.length; index++) {
    await terminal(largeParents[index].queue, `large-${index}`, [
      largeChildQueue.request(null, { key: `l${index}-1` }),
      largeChildQueue.request(null, { key: `l${index}-2` }),
    ]);
  }
  const largeCount = await large.dispatch({ limit: Number.MAX_SAFE_INTEGER });
  const largeDrained = (
    await Promise.all(largeParents.map((parent) => parent.queue.inspect('p')))
  ).every((snapshot) => snapshot.pendingFollowups === 0);

  return {
    kind: 'budget',
    exactTwoAttemptCounts: JSON.stringify(counts) === JSON.stringify([2, 2, 1, 1]),
    midParentBudgetPreserved: afterFirst.a1 && afterFirst.a2 && !afterFirst.a3 && afterFourth,
    laterParentsReached: afterSecond.b1 && afterSecond.b2 && afterThird,
    wrapped,
    maxSafeLimitDrains: largeCount === 6 && largeDrained,
  };
}

async function gridScenario(parentCount, childrenPerParent, limit, poison) {
  const base = createMemoryStore({ now: () => 1000 });
  const scope = `outbox-grid-${poison ? 'poison' : 'normal'}-${parentCount}-${childrenPerParent}-${limit}`;
  const work = createWorkOnce({ store: base, scope });
  const child = work.define('child');
  const parents = await orderedParentQueues(work, base, scope, parentCount, 'grid');
  const healthyKeys = [];
  const poisonKey = 'p0-c0';
  if (poison) await child.ensure({ original: true }, { key: poisonKey });
  for (let parentIndex = 0; parentIndex < parents.length; parentIndex++) {
    const requests = [];
    for (let childIndex = 0; childIndex < childrenPerParent; childIndex++) {
      const key = `p${parentIndex}-c${childIndex}`;
      if (poison && parentIndex === 0 && childIndex === 0) {
        requests.push(child.request({ wrong: true }, { key }));
      } else {
        healthyKeys.push(key);
        requests.push(child.request(null, { key }));
      }
    }
    await terminal(parents[parentIndex].queue, `grid-${parentIndex}`, requests);
  }
  const errors = [];
  const maxCalls = parentCount * childrenPerParent * 4 + parentCount * 4 + 8;
  let calls = 0;
  for (; calls < maxCalls; calls++) {
    const snapshots = await Promise.all(parents.map((parent) => parent.queue.inspect('p')));
    const pending = snapshots.reduce((sum, snapshot) => sum + snapshot.pendingFollowups, 0);
    if (pending === (poison ? 1 : 0)) break;
    try {
      await work.dispatch({ limit });
    } catch (error) {
      errors.push(error?.code ?? error?.name ?? String(error));
    }
  }
  const final = await Promise.all(parents.map((parent) => parent.queue.inspect('p')));
  const pending = final.reduce((sum, snapshot) => sum + snapshot.pendingFollowups, 0);
  const healthy = await Promise.all(healthyKeys.map((key) => child.inspect(key)));
  return {
    drainedToExpectedPending: pending === (poison ? 1 : 0),
    allHealthyReached: healthy.every((snapshot) => snapshot !== undefined),
    exactPoisonCauses:
      !poison || (errors.length > 0 && errors.every((code) => code === 'key_conflict')),
    boundedCalls: calls < maxCalls,
  };
}

async function schedulerGridSample() {
  const normal = [];
  for (let limit = 1; limit <= 4; limit++)
    for (let parents = 2; parents <= 4; parents++)
      for (let children = 1; children <= 4; children++)
        normal.push(await gridScenario(parents, children, limit, false));
  const poison = [];
  for (let limit = 1; limit <= 3; limit++)
    for (let parents = 2; parents <= 3; parents++)
      for (let children = 2; children <= 3; children++)
        poison.push(await gridScenario(parents, children, limit, true));
  return {
    kind: 'grid',
    normalMatrixComplete: normal.length === 48,
    poisonMatrixComplete: poison.length === 12,
    allNormalConverged: normal.every(
      (result) =>
        result.drainedToExpectedPending && result.allHealthyReached && result.boundedCalls,
    ),
    allPoisonHealthyReached: poison.every(
      (result) =>
        result.drainedToExpectedPending &&
        result.allHealthyReached &&
        result.exactPoisonCauses &&
        result.boundedCalls,
    ),
  };
}

async function dynamicArrivalSample() {
  const base = createMemoryStore({ now: () => 1000 });
  const traced = tracedStore(base);
  const scope = 'outbox-dynamic-arrival';
  const work = createWorkOnce({ store: traced.store, scope });
  const child = work.define('child');
  const [first, second] = await orderedParentQueues(work, traced.store, scope, 2, 'dynamic');
  await terminal(first.queue, 'first', [
    child.request(null, { key: 'a1' }),
    child.request(null, { key: 'a2' }),
  ]);
  await terminal(second.queue, 'second', [child.request(null, { key: 'b1' })]);
  await work.dispatch({ limit: 1 });

  const inserted = work.define('000-before-cursor');
  const insertedSnapshot = await inserted.ensure(null, { key: 'p' });
  await terminal(inserted, 'inserted', [child.request(null, { key: 'new1' })]);
  const insertedBeforeCursor =
    Buffer.compare(
      Buffer.from(insertedSnapshot.id, 'utf8'),
      Buffer.from(first.snapshot.id, 'utf8'),
    ) < 0;
  const secondPass = await work.dispatch({ limit: 1 });
  const laterParentReached = secondPass === 1 && (await child.inspect('b1')) !== undefined;
  const thirdPass = await work.dispatch({ limit: 1 });
  const insertedReachedAfterWrap = thirdPass === 1 && (await child.inspect('new1')) !== undefined;
  const fourthPass = await work.dispatch({ limit: 1 });
  const originalPartialStillReachable =
    fourthPass === 1 && (await child.inspect('a2')) !== undefined;
  return {
    kind: 'dynamic',
    insertedBeforeCursor,
    laterParentReached,
    insertedReachedAfterWrap,
    originalPartialStillReachable,
  };
}

async function concurrentDispatchersSample() {
  const base = createMemoryStore({ now: () => 1000 });
  const scope = 'outbox-concurrent-dispatchers';
  const firstWork = createWorkOnce({ store: base, scope });
  const secondWork = createWorkOnce({ store: base, scope });
  const child = firstWork.define('child');
  const [first, second] = await orderedParentQueues(firstWork, base, scope, 2, 'concurrent');
  await terminal(first.queue, 'first', [
    child.request(null, { key: 'a1' }),
    child.request(null, { key: 'a2' }),
  ]);
  await terminal(second.queue, 'second', [
    child.request(null, { key: 'b1' }),
    child.request(null, { key: 'b2' }),
  ]);
  await Promise.all([firstWork.dispatch({ limit: 1 }), secondWork.dispatch({ limit: 1 })]);
  let rounds = 0;
  while (rounds < 6) {
    const snapshots = await Promise.all([first.queue.inspect('p'), second.queue.inspect('p')]);
    if (snapshots.every((snapshot) => snapshot.pendingFollowups === 0)) break;
    await Promise.allSettled([firstWork.dispatch({ limit: 1 }), secondWork.dispatch({ limit: 1 })]);
    rounds++;
  }
  const snapshots = await Promise.all([first.queue.inspect('p'), second.queue.inspect('p')]);
  const allChildren = await Promise.all(['a1', 'a2', 'b1', 'b2'].map((key) => child.inspect(key)));
  return {
    kind: 'concurrent',
    independentCursorsConverge: snapshots.every((snapshot) => snapshot.pendingFollowups === 0),
    allChildrenDurable: allChildren.every((snapshot) => snapshot !== undefined),
    boundedRounds: rounds <= 4,
  };
}

async function staleParentRaceSample() {
  const base = createMemoryStore({ now: () => 1000 });
  const scope = 'outbox-stale-parent-race';
  let holdParentAck = false;
  let held = false;
  let release;
  let entered;
  const gate = new Promise((resolve) => (release = resolve));
  const parentAckEntered = new Promise((resolve) => (entered = resolve));
  let parentId;
  const store = {
    ...base,
    async atomic(id, decide) {
      if (holdParentAck && id === parentId && !held) {
        held = true;
        entered();
        await gate;
      }
      return base.atomic(id, decide);
    },
  };
  const firstWork = createWorkOnce({ store, scope });
  const secondWork = createWorkOnce({ store, scope });
  const parent = firstWork.define('parent');
  const parent2 = secondWork.define('parent');
  const child = firstWork.define('child');
  const snapshot = await parent.ensure(null, { key: 'p' });
  parentId = snapshot.id;
  await terminal(parent, 'first', [child.request(null, { key: 'c' })]);
  holdParentAck = true;
  const delayed = firstWork.dispatch({ limit: 1 });
  await within(parentAckEntered, 'stale-parent held acknowledgement');
  let winner;
  let drained;
  let rerun;
  let staleError;
  try {
    winner = await secondWork.dispatch({ limit: 1 });
    drained = (await parent.inspect('p')).pendingFollowups === 0;
    rerun = await parent2.rerun({ key: 'p', generation: 1 });
  } finally {
    release();
    try {
      await delayed;
    } catch (error) {
      staleError = error;
    }
  }
  return {
    kind: 'staleParent',
    winnerAcked: winner === 1 && drained,
    rerunAdvancedGeneration: rerun.generation === 2 && rerun.phase.state === 'queued',
    exactStaleCause: staleError?.code === 'stale_attempt',
    childPreserved: (await child.inspect('c')) !== undefined,
  };
}

async function rotationFailurePrecisionSample() {
  const base = createMemoryStore({ now: () => 1000 });
  const scope = 'outbox-rotation-failure-precision';
  let parentId;
  let failRotation = false;
  const store = {
    ...base,
    async atomic(id, decide) {
      if (failRotation && id === parentId) {
        failRotation = false;
        throw new Error('rotation helper failed');
      }
      return base.atomic(id, decide);
    },
  };
  const work = createWorkOnce({ store, scope });
  const parent = work.define('parent');
  const child = work.define('child');
  await child.ensure({ original: true }, { key: 'poison' });
  const snapshot = await parent.ensure(null, { key: 'p' });
  parentId = snapshot.id;
  await terminal(parent, 'first', [
    child.request({ wrong: true }, { key: 'poison' }),
    child.request(null, { key: 'healthy' }),
  ]);
  failRotation = true;
  let failure;
  try {
    await work.dispatch({ limit: 1 });
  } catch (error) {
    failure = error;
  }
  return {
    kind: 'rotationFailure',
    originalCausePreserved: failure?.code === 'key_conflict',
    helperFailureNotSurfaced: failure?.message !== 'rotation helper failed',
    durableIntentPreserved: (await parent.inspect('p')).pendingFollowups === 2,
  };
}

async function multiErrorSample() {
  const base = createMemoryStore({ now: () => 1000 });
  const scope = 'outbox-multi-error';
  const work = createWorkOnce({ store: base, scope });
  const parent = work.define('parent');
  const child = work.define('child');
  await child.ensure({ original: 1 }, { key: 'p1' });
  await child.ensure({ original: 2 }, { key: 'p2' });
  await parent.ensure(null, { key: 'p' });
  await terminal(parent, 'first', [
    child.request({ wrong: 1 }, { key: 'p1' }),
    child.request({ wrong: 2 }, { key: 'p2' }),
  ]);
  let failure;
  try {
    await work.dispatch({ limit: 2 });
  } catch (error) {
    failure = error;
  }
  return {
    kind: 'multiError',
    exactContainer: failure?.name === 'WorkDispatchError',
    exactCount: failure?.errors?.length === 2,
    exactCauses: failure?.errors?.every((error) => error?.code === 'key_conflict') === true,
    bothIntentsRetained: (await parent.inspect('p')).pendingFollowups === 2,
  };
}

async function runDispatcherPoisonSample() {
  const base = createMemoryStore();
  const scope = 'outbox-run-dispatcher-poison';
  const work = createWorkOnce({ store: base, scope });
  const child = work.define('child');
  const [first, second] = await orderedParentQueues(work, base, scope, 2, 'pump');
  await child.ensure({ original: true }, { key: 'poison' });
  await terminal(first.queue, 'first', [
    child.request({ wrong: true }, { key: 'poison' }),
    child.request(null, { key: 'healthy' }),
  ]);
  await terminal(second.queue, 'second', [child.request(null, { key: 'neighbor' })]);
  const controller = new AbortController();
  const errors = [];
  const pumping = work.runDispatcher({
    signal: controller.signal,
    intervalMs: 1,
    limit: 1,
    onError(error) {
      errors.push(error?.code ?? error?.name ?? String(error));
    },
  });
  const deadline = performance.now() + 2000;
  let observedWithinDeadline = false;
  while (performance.now() < deadline) {
    if ((await child.inspect('healthy')) && (await child.inspect('neighbor'))) {
      observedWithinDeadline = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  controller.abort();
  await within(pumping, 'run-dispatcher shutdown');
  return {
    kind: 'runDispatcher',
    observedWithinDeadline,
    exactPoisonObserved: errors[0] === 'key_conflict',
    neighborDelivered: (await child.inspect('neighbor')) !== undefined,
    healthySiblingDelivered: (await child.inspect('healthy')) !== undefined,
    poisonStillRetained: (await first.queue.inspect('p')).pendingFollowups === 1,
  };
}

async function historyScenario(restartBeforeSecondCall) {
  const base = createMemoryStore({ now: () => 1000 });
  const scope = 'outbox-history-split';
  let work = createWorkOnce({ store: base, scope });
  let child = work.define('child');
  const [first, second] = await orderedParentQueues(work, base, scope, 2, 'history');
  await terminal(first.queue, 'first', [
    child.request(null, { key: 'a1' }),
    child.request(null, { key: 'a2' }),
  ]);
  await terminal(second.queue, 'second', [child.request(null, { key: 'b1' })]);
  await work.dispatch({ limit: 1 });
  const durable = await base.query({ scope, select: 'all', limit: 20 });
  if (restartBeforeSecondCall) {
    work = createWorkOnce({ store: base, scope });
    child = work.define('child');
  }
  await work.dispatch({ limit: 1 });
  const next = {
    a2: (await child.inspect('a2')) !== undefined,
    b1: (await child.inspect('b1')) !== undefined,
  };
  for (let index = 0; index < 4; index++) await work.dispatch({ limit: 1 });
  return {
    durable: JSON.stringify(durable.rows),
    next,
    final: JSON.stringify((await base.query({ scope, select: 'all', limit: 20 })).rows),
  };
}

async function congruentHistoryScenario(mode) {
  const base = createMemoryStore({ now: () => 1000 });
  const scope = 'outbox-history-congruence';
  let parentId;
  let loseParentAck = mode === 'ackLoss';
  const store = {
    ...base,
    async atomic(id, decide) {
      let before;
      let after;
      const value = await base.atomic(id, (row, now) => {
        before = row;
        const change = decide(row, now);
        after = change.next;
        return change;
      });
      if (
        loseParentAck &&
        id === parentId &&
        before?.outbox?.length === 2 &&
        after?.outbox?.length === 1
      ) {
        loseParentAck = false;
        throw new Error('parent ACK lost');
      }
      return value;
    },
  };
  const primary = createWorkOnce({ store, scope });
  const secondary = createWorkOnce({ store, scope });
  const child = primary.define('child');
  const [first, second] = await orderedParentQueues(primary, store, scope, 2, 'congruent');
  parentId = first.snapshot.id;
  await terminal(first.queue, 'first', [
    child.request(null, { key: 'a1' }),
    child.request(null, { key: 'a2' }),
  ]);
  await terminal(second.queue, 'second', [child.request(null, { key: 'b1' })]);
  let firstResult = 'fulfilled';
  try {
    if (mode === 'concurrent')
      await Promise.all([primary.dispatch({ limit: 1 }), secondary.dispatch({ limit: 1 })]);
    else await primary.dispatch({ limit: 1 });
  } catch (error) {
    firstResult = error?.message ?? String(error);
  }
  const durable = JSON.stringify((await base.query({ scope, select: 'all', limit: 20 })).rows);
  await primary.dispatch({ limit: 1 });
  return {
    durable,
    firstResult,
    future: {
      b1: (await child.inspect('b1')) !== undefined,
      a2: (await child.inspect('a2')) !== undefined,
    },
  };
}

async function historyCongruenceSample() {
  const normal = await congruentHistoryScenario('normal');
  const concurrent = await congruentHistoryScenario('concurrent');
  const ackLoss = await congruentHistoryScenario('ackLoss');
  const projections = [normal.durable, concurrent.durable, ackLoss.durable];
  const futures = [normal.future, concurrent.future, ackLoss.future];
  return {
    kind: 'historyCongruence',
    threeMaterialHistories:
      normal.firstResult === 'fulfilled' &&
      concurrent.firstResult === 'fulfilled' &&
      ackLoss.firstResult === 'parent ACK lost',
    sameEnrichedProjection: projections.every((value) => value === projections[0]),
    sameNextFuture: futures.every((future) => future.b1 === true && future.a2 === false),
    futureProjectionEqual: futures.every(
      (future) => JSON.stringify(future) === JSON.stringify(futures[0]),
    ),
  };
}

async function historySplitSample() {
  const retainedCursor = await historyScenario(false);
  const freshCursor = await historyScenario(true);
  return {
    kind: 'historySplit',
    sameDurableProjection: retainedCursor.durable === freshCursor.durable,
    differentImmediateFuture:
      retainedCursor.next.b1 &&
      !retainedCursor.next.a2 &&
      freshCursor.next.a2 &&
      !freshCursor.next.b1,
    cursorRequiredInAbstraction: retainedCursor.next.b1 !== freshCursor.next.b1,
    eventualDurableConvergence: retainedCursor.final === freshCursor.final,
  };
}

function adapterFixture(adapter) {
  if (adapter === 'memory') return { store: createMemoryStore(), cleanup() {} };
  if (adapter === 'cas') return { store: createCasStore(), cleanup() {} };
  if (adapter === 'sqlite') return sqliteFixture();
  throw new Error(`Unknown outbox adapter: ${adapter}`);
}

async function ackFaultLane(adapter, fault) {
  const fixture = adapterFixture(adapter);
  const scope = `outbox-fault-${adapter}-${fault}`;
  let parentId;
  let injected = false;
  const sentinel = new Error(`${adapter}-${fault}-ack-lost`);
  const store = {
    ...fixture.store,
    async atomic(id, decide) {
      let before;
      let after;
      const value = await fixture.store.atomic(id, (row, now) => {
        before = row;
        const change = decide(row, now);
        after = change.next;
        return change;
      });
      const childCommit = before === undefined && after?.kind === 'child';
      const parentCommit =
        id === parentId &&
        before?.outbox?.length > 0 &&
        after?.outbox?.length === before.outbox.length - 1;
      if (
        !injected &&
        ((fault === 'child' && childCommit) || (fault === 'parent' && parentCommit))
      ) {
        injected = true;
        throw sentinel;
      }
      return value;
    },
  };
  try {
    const work = createWorkOnce({ store, scope });
    const parent = work.define('parent');
    const child = work.define('child');
    const parentSnapshot = await parent.ensure(null, { key: 'p' });
    parentId = parentSnapshot.id;
    await terminal(parent, 'setup', [
      child.request(null, { key: 'c1' }),
      child.request(null, { key: 'c2' }),
    ]);
    let failure;
    try {
      await work.dispatch({ limit: 1 });
    } catch (error) {
      failure = error;
    }
    const afterFault = await parent.inspect('p');
    const firstChild = await child.inspect('c1');
    let calls = 0;
    while ((await parent.inspect('p')).pendingFollowups > 0 && calls++ < 4) {
      try {
        await work.dispatch({ limit: 2 });
      } catch {}
    }
    const final = await parent.inspect('p');
    return {
      exactFault: failure === sentinel,
      durablePrefix:
        firstChild !== undefined && afterFault.pendingFollowups === (fault === 'child' ? 2 : 1),
      converged: final.pendingFollowups === 0 && (await child.inspect('c2')) !== undefined,
      boundedReplay: calls <= 2,
    };
  } finally {
    fixture.cleanup();
  }
}

async function adapterFaultMatrixSample() {
  const results = [];
  for (const adapter of ['memory', 'sqlite', 'cas'])
    for (const fault of ['child', 'parent'])
      results.push({ adapter, fault, ...(await ackFaultLane(adapter, fault)) });
  return {
    kind: 'adapterFaults',
    sixPrefixes: results.length === 6,
    exactErrors: results.every((result) => result.exactFault),
    durablePrefixesMatch: results.every((result) => result.durablePrefix),
    allReplayConverge: results.every((result) => result.converged && result.boundedReplay),
  };
}

async function concurrentAdapterLane(adapter) {
  const fixture = adapterFixture(adapter);
  const scope = `outbox-concurrent-${adapter}`;
  try {
    const firstWork = createWorkOnce({ store: fixture.store, scope });
    const secondWork = createWorkOnce({ store: fixture.store, scope });
    const child = firstWork.define('child');
    const parents = await orderedParentQueues(
      firstWork,
      fixture.store,
      scope,
      3,
      `concurrent-${adapter}`,
    );
    const keys = [];
    for (let parentIndex = 0; parentIndex < parents.length; parentIndex++) {
      const requests = [];
      for (let childIndex = 0; childIndex < 2; childIndex++) {
        const key = `p${parentIndex}-c${childIndex}`;
        keys.push(key);
        requests.push(child.request(null, { key }));
      }
      await terminal(parents[parentIndex].queue, `setup-${parentIndex}`, requests);
    }
    let rounds = 0;
    for (; rounds < 8; rounds++) {
      const snapshots = await Promise.all(parents.map((parent) => parent.queue.inspect('p')));
      if (snapshots.every((snapshot) => snapshot.pendingFollowups === 0)) break;
      await Promise.allSettled([
        firstWork.dispatch({ limit: 2 }),
        secondWork.dispatch({ limit: 2 }),
      ]);
    }
    const snapshots = await Promise.all(parents.map((parent) => parent.queue.inspect('p')));
    const children = await Promise.all(keys.map((key) => child.inspect(key)));
    return {
      drained: snapshots.every((snapshot) => snapshot.pendingFollowups === 0),
      allChildren: children.every((snapshot) => snapshot !== undefined),
      bounded: rounds < 8,
    };
  } finally {
    fixture.cleanup();
  }
}

async function adapterConcurrentSample() {
  const results = [];
  for (const adapter of ['memory', 'sqlite', 'cas'])
    results.push({ adapter, ...(await concurrentAdapterLane(adapter)) });
  return {
    kind: 'adapterConcurrent',
    threeAdapters: results.length === 3,
    allConverge: results.every((result) => result.drained && result.allChildren && result.bounded),
  };
}

async function multiPoisonSample() {
  async function lane(limit) {
    const base = createMemoryStore({ now: () => 1000 });
    const scope = `outbox-multi-poison-${limit}`;
    const work = createWorkOnce({ store: base, scope });
    const child = work.define('child');
    const parents = await orderedParentQueues(work, base, scope, 3, `poison-${limit}`);
    await child.ensure({ original: 1 }, { key: 'poison-1' });
    await child.ensure({ original: 2 }, { key: 'poison-2' });
    await terminal(parents[0].queue, 'p0', [
      child.request({ wrong: 1 }, { key: 'poison-1' }),
      child.request({ wrong: 2 }, { key: 'poison-2' }),
      child.request(null, { key: 'healthy-a' }),
      child.request(null, { key: 'healthy-b' }),
    ]);
    await terminal(parents[1].queue, 'p1', [child.request(null, { key: 'neighbor-1' })]);
    await terminal(parents[2].queue, 'p2', [child.request(null, { key: 'neighbor-2' })]);
    const errors = [];
    let calls = 0;
    for (; calls < 20; calls++) {
      const pending = (
        await Promise.all(parents.map((parent) => parent.queue.inspect('p')))
      ).reduce((sum, snapshot) => sum + snapshot.pendingFollowups, 0);
      if (pending === 2) break;
      try {
        await work.dispatch({ limit });
      } catch (error) {
        const causes = error?.errors ?? [error];
        errors.push(...causes.map((cause) => cause?.code));
      }
    }
    return {
      bounded: calls < 20,
      exactErrors: errors.length > 0 && errors.every((code) => code === 'key_conflict'),
      healthyReached: (
        await Promise.all(
          ['healthy-a', 'healthy-b', 'neighbor-1', 'neighbor-2'].map((key) => child.inspect(key)),
        )
      ).every((snapshot) => snapshot !== undefined),
      poisonRetained: (await parents[0].queue.inspect('p')).pendingFollowups === 2,
    };
  }
  const one = await lane(1);
  const two = await lane(2);
  return {
    kind: 'multiPoison',
    limitOneConverges: Object.values(one).every(Boolean),
    limitTwoConverges: Object.values(two).every(Boolean),
  };
}

async function finiteArrivalBurstSample() {
  const base = createMemoryStore({ now: () => 1000 });
  const scope = 'outbox-finite-arrival-burst';
  const work = createWorkOnce({ store: base, scope });
  const child = work.define('child');
  const seed = work.define('m-seed');
  await seed.ensure(null, { key: 'p' });
  await terminal(seed, 'seed', [
    child.request(null, { key: 'seed-1' }),
    child.request(null, { key: 'seed-2' }),
  ]);
  await work.dispatch({ limit: 1 });
  const arrivals = [
    ['000-before-1', 'new-a'],
    ['zzz-after-1', 'new-b'],
    ['000-before-2', 'new-c'],
    ['zzz-after-2', 'new-d'],
  ];
  for (const [kind, key] of arrivals) {
    const parent = work.define(kind);
    await parent.ensure(null, { key: 'p' });
    await terminal(parent, kind, [child.request(null, { key })]);
    await work.dispatch({ limit: 1 });
  }
  let calls = 0;
  for (; calls < 16; calls++) {
    const rows = await base.query({ scope, select: 'outbox', limit: 20 });
    if (!rows.rows.length) break;
    await work.dispatch({ limit: 2 });
  }
  const all = await Promise.all(
    ['seed-1', 'seed-2', ...arrivals.map(([, key]) => key)].map((key) => child.inspect(key)),
  );
  return {
    kind: 'finiteArrivals',
    allFiniteArrivalsReached: all.every((snapshot) => snapshot !== undefined),
    boundedAfterQuiescence: calls < 16,
    noPendingAfterQuiescence:
      (await base.query({ scope, select: 'outbox', limit: 20 })).rows.length === 0,
  };
}

async function limitBoundarySample() {
  const base = createMemoryStore();
  let outboxQueries = 0;
  const store = {
    ...base,
    async query(query) {
      if (query.select === 'outbox') outboxQueries++;
      return base.query(query);
    },
  };
  const work = createWorkOnce({ store, scope: 'outbox-limit-boundary' });
  const invalid = [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1];
  const errors = [];
  for (const limit of invalid) {
    try {
      await work.dispatch({ limit });
      errors.push('accepted');
    } catch (error) {
      errors.push(error instanceof RangeError ? 'range' : error?.name);
    }
  }
  const controller = new AbortController();
  controller.abort();
  let dispatcherError;
  try {
    await work.runDispatcher({ signal: controller.signal, intervalMs: 0 });
  } catch (error) {
    dispatcherError = error;
  }
  return {
    kind: 'limitBoundary',
    invalidLimitsRejected: errors.every((value) => value === 'range'),
    invalidLimitsNoQuery: outboxQueries === 0,
    invalidIntervalExact: dispatcherError instanceof RangeError,
  };
}

export async function runOutboxRefinementSamples() {
  const sqlite = sqliteFixture();
  const sqliteBudget = sqliteFixture();
  return Promise.all([
    rotationSample(),
    poisonSample(),
    restartSample(),
    ackLossSample(),
    casAckLossSample(),
    adapterRotationSample('memory', createMemoryStore()),
    adapterRotationSample('sqlite', sqlite.store, sqlite.cleanup),
    adapterRotationSample('cas', createCasStore()),
    adapterBudgetSample('memory', createMemoryStore()),
    adapterBudgetSample('sqlite', sqliteBudget.store, sqliteBudget.cleanup),
    adapterBudgetSample('cas', createCasStore()),
    adapterFaultMatrixSample(),
    adapterConcurrentSample(),
    budgetMatrixSample(),
    schedulerGridSample(),
    multiPoisonSample(),
    dynamicArrivalSample(),
    finiteArrivalBurstSample(),
    concurrentDispatchersSample(),
    limitBoundarySample(),
    staleParentRaceSample(),
    rotationFailurePrecisionSample(),
    multiErrorSample(),
    runDispatcherPoisonSample(),
    historyCongruenceSample(),
    historySplitSample(),
  ]);
}

const outboxBooleanFields = {
  ackLoss: ['childDurableBeforeAck', 'exactFailure', 'parentIntentRetained', 'retryConverged'],
  adapter: ['firstParentDrained', 'laterParentReached', 'threePassesSent', 'wrapped'],
  adapterBudget: ['allChildrenDurable', 'allParentsDrained', 'exactCounts', 'maxSafeLimitWorks'],
  adapterConcurrent: ['allConverge', 'threeAdapters'],
  adapterFaults: ['allReplayConverge', 'durablePrefixesMatch', 'exactErrors', 'sixPrefixes'],
  budget: [
    'exactTwoAttemptCounts',
    'laterParentsReached',
    'maxSafeLimitDrains',
    'midParentBudgetPreserved',
    'wrapped',
  ],
  casAckLoss: [
    'childCommitAmbiguityConverges',
    'exactChildAckLoss',
    'exactParentAckLoss',
    'parentCommitAmbiguityConverges',
  ],
  concurrent: ['allChildrenDurable', 'boundedRounds', 'independentCursorsConverge'],
  dynamic: [
    'insertedBeforeCursor',
    'insertedReachedAfterWrap',
    'laterParentReached',
    'originalPartialStillReachable',
  ],
  finiteArrivals: [
    'allFiniteArrivalsReached',
    'boundedAfterQuiescence',
    'noPendingAfterQuiescence',
  ],
  grid: [
    'allNormalConverged',
    'allPoisonHealthyReached',
    'normalMatrixComplete',
    'poisonMatrixComplete',
  ],
  historyCongruence: [
    'futureProjectionEqual',
    'sameEnrichedProjection',
    'sameNextFuture',
    'threeMaterialHistories',
  ],
  historySplit: [
    'cursorRequiredInAbstraction',
    'differentImmediateFuture',
    'eventualDurableConvergence',
    'sameDurableProjection',
  ],
  limitBoundary: ['invalidIntervalExact', 'invalidLimitsNoQuery', 'invalidLimitsRejected'],
  multiError: ['bothIntentsRetained', 'exactCauses', 'exactContainer', 'exactCount'],
  multiPoison: ['limitOneConverges', 'limitTwoConverges'],
  poison: ['exactConflict', 'healthySiblingReached', 'laterParentReached', 'poisonRetained'],
  restart: ['pendingPreserved', 'remainingChildDelivered', 'restartedFromBeginning'],
  rotation: [
    'firstParentDrained',
    'firstParentPartiallyDrained',
    'firstParentStillReachable',
    'firstPassSent',
    'laterParentReached',
    'secondPassSent',
    'thirdPassSent',
    'wrapped',
  ],
  rotationFailure: ['durableIntentPreserved', 'helperFailureNotSurfaced', 'originalCausePreserved'],
  runDispatcher: [
    'exactPoisonObserved',
    'healthySiblingDelivered',
    'neighborDelivered',
    'observedWithinDeadline',
    'poisonStillRetained',
  ],
  staleParent: ['childPreserved', 'exactStaleCause', 'rerunAdvancedGeneration', 'winnerAcked'],
};
const outboxMetadataFields = { adapter: ['adapter'], adapterBudget: ['adapter'] };

export function assertOutboxRefinementSamples(samples) {
  const kinds = [...new Set(samples.map((sample) => sample.kind))].sort();
  const expectedKinds = Object.keys(outboxBooleanFields).sort();
  if (JSON.stringify(kinds) !== JSON.stringify(expectedKinds))
    throw new Error(`Unexpected outbox sample kinds: ${JSON.stringify(kinds)}`);
  const adapters = samples
    .filter((sample) => sample.kind === 'adapter' || sample.kind === 'adapterBudget')
    .map((sample) => sample.adapter)
    .sort();
  if (
    JSON.stringify(adapters) !==
    JSON.stringify(['cas', 'cas', 'memory', 'memory', 'sqlite', 'sqlite'])
  )
    throw new Error(`Unexpected outbox adapter set: ${JSON.stringify(adapters)}`);
  for (const sample of samples)
    assertExactBooleanSample(
      sample,
      outboxBooleanFields[sample.kind],
      outboxMetadataFields[sample.kind] ?? [],
    );
}
