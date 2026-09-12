import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompareExchangeStore } from '../dist/cas.js';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
import { createSqliteStore } from '../dist/sqlite.js';
import { assertExactBooleanSample } from './refinement-sample-schema.mjs';
import { createRefinementSqliteFixture } from './refinement-sqlite-fixture.mjs';

function casFixture(options = {}) {
  let now = 100;
  const native = createMemoryStore({ now: () => now });
  let falseWrites = options.falseWrites ?? 0;
  let compareCalls = 0;
  const port = {
    getMany: (ids) => native.getMany(ids),
    query: (query) => native.query(query),
    async compareExchange(change) {
      compareCalls++;
      if (falseWrites > 0) {
        falseWrites--;
        return false;
      }
      return native.atomic(change.id, (row, clock) => {
        if (
          row?.revision !== change.expectedRevision ||
          (change.validUntil !== undefined && clock >= change.validUntil)
        )
          return { value: false };
        return { next: change.next, value: true };
      });
    },
  };
  return {
    native,
    port,
    store: createCompareExchangeStore(port, { maxConflicts: options.maxConflicts ?? 100 }),
    compareCalls: () => compareCalls,
    setNow(value) {
      now = value;
    },
  };
}

function adapterFixture(adapter) {
  if (adapter === 'memory') return { store: createMemoryStore({ now: () => 100 }), close() {} };
  if (adapter === 'cas') return { store: casFixture().store, close() {} };
  return createRefinementSqliteFixture('workonce-storage-refinement-', 'queue.sqlite', {
    now: () => 100,
  });
}

async function detachedSample(adapter) {
  const fixture = adapterFixture(adapter);
  try {
    const scope = `storage-refinement-${adapter}`;
    const queue = createWorkOnce({ store: fixture.store, scope }).define('job');
    const snapshots = [];
    for (const key of ['delta', 'alpha', 'charlie', 'bravo'])
      snapshots.push(await queue.ensure({ nested: { key } }, { key }));
    const ids = snapshots.map((snapshot) => snapshot.id);
    const batch = await fixture.store.getMany(ids);
    batch.rows[0].input.nested.key = 'MUTATED';
    const getManyDetached =
      (await fixture.store.getMany([ids[0]])).rows[0].input.nested.key === 'delta';
    const duplicate = await fixture.store.getMany([ids[0], ids[1], ids[1]]);
    const duplicateSlotsExact =
      duplicate.rows.length === 3 &&
      duplicate.rows[0]?.id === ids[0] &&
      duplicate.rows[1]?.id === ids[1] &&
      duplicate.rows[2]?.id === ids[1];
    if (duplicate.rows[1]) duplicate.rows[1].input.nested.key = 'DUPLICATE-MUTATED';
    const duplicateSlotsDetached = duplicate.rows[2]?.input.nested.key === 'alpha';
    const all = await fixture.store.query({ scope, select: 'all', limit: 20 });
    const ordered = all.rows.map((row) => row.id);
    const orderExact = JSON.stringify(ordered) === JSON.stringify([...ordered].sort());
    all.rows[0].input.nested.key = 'QUERY-MUTATED';
    const expectedQueryKey = snapshots.find((snapshot) => snapshot.id === ordered[0])?.input.nested
      .key;
    const queryDetached =
      (await fixture.store.getMany([ordered[0]])).rows[0].input.nested.key === expectedQueryKey;
    let cursorExact = true;
    for (let index = 0; index < ordered.length; index++) {
      const page = await fixture.store.query({
        scope,
        select: 'all',
        limit: 2,
        afterId: ordered[index],
      });
      if (
        JSON.stringify(page.rows.map((row) => row.id)) !==
        JSON.stringify(ordered.slice(index + 1, index + 3))
      )
        cursorExact = false;
    }
    return {
      kind: 'detached',
      adapter,
      getManyDetached,
      duplicateSlotsExact,
      duplicateSlotsDetached,
      queryDetached,
      orderExact,
      cursorExact,
    };
  } finally {
    fixture.close();
  }
}

async function adapterHistoryCongruenceSample(adapter) {
  async function lane(contended) {
    const fixture = adapterFixture(adapter);
    try {
      const scope = `storage-history-${adapter}`;
      const queue = createWorkOnce({ store: fixture.store, scope }).define('job');
      const requests = contended ? 12 : 1;
      const snapshots = await Promise.all(
        Array.from({ length: requests }, () => queue.ensure({ value: 1 }, { key: 'same' })),
      );
      const before = (await fixture.store.getMany([snapshots[0].id])).rows[0];
      const [run] = await queue.claim({ workerId: 'future', limit: 1 });
      const heartbeat = await run.heartbeat();
      const settled = await run.settle(run.succeed({ value: 2 }));
      const after = await queue.inspect('same');
      const history = await queue.history('same');
      return {
        completedRequests: snapshots.length,
        before,
        future: { heartbeat, settled, after, history },
      };
    } finally {
      fixture.close();
    }
  }
  const direct = await lane(false);
  const contended = await lane(true);
  return {
    kind: 'adapterHistoryCongruence',
    adapter,
    materiallyDifferentHistory:
      direct.completedRequests !== contended.completedRequests &&
      direct.before.revision === contended.before.revision &&
      direct.future.history.length === contended.future.history.length,
    sameDurableProjection: JSON.stringify(direct.before) === JSON.stringify(contended.before),
    sameFuture: JSON.stringify(direct.future) === JSON.stringify(contended.future),
  };
}

async function atomicContentionSample(adapter) {
  const fixture = adapterFixture(adapter);
  try {
    const scope = `storage-atomic-contention-${adapter}`;
    const queue = createWorkOnce({ store: fixture.store, scope }).define('job');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => queue.ensure({ value: 1 }, { key: 'same' })),
    );
    const row = (await fixture.store.getMany([results[0].id])).rows[0];
    return {
      kind: 'atomicContention',
      adapter,
      allSameSnapshot: results.every(
        (snapshot) => JSON.stringify(snapshot) === JSON.stringify(results[0]),
      ),
      oneInsertRevision: row?.revision === 1,
      oneStoredRow:
        (await fixture.store.query({ scope, select: 'all', limit: 10 })).rows.length === 1,
    };
  } finally {
    fixture.close();
  }
}

async function queryBoundarySample(adapter) {
  const fixture = adapterFixture(adapter);
  try {
    const scope = `storage-query-${adapter}`;
    const queue = createWorkOnce({ store: fixture.store, scope }).define('job');
    const created = [];
    for (const [key, availableAt] of [
      ['later', 102],
      ['same-b', 100],
      ['same-a', 100],
      ['future', 120],
    ])
      created.push(await queue.ensure(key, { key, availableAt }));
    const due = await fixture.store.query({
      scope,
      kind: 'job',
      definition: '1',
      select: 'due',
      limit: 10,
    });
    const dueLimited = await fixture.store.query({
      scope,
      kind: 'job',
      definition: '1',
      select: 'due',
      limit: 1,
    });
    const expectedDue = created
      .filter((snapshot) => snapshot.phase.state === 'queued' && snapshot.phase.availableAt <= 100)
      .map((snapshot) => snapshot.id)
      .sort();
    let dueCursorError;
    try {
      await fixture.store.query({ scope, select: 'due', limit: 1, afterId: created[0].id });
    } catch (error) {
      dueCursorError = error;
    }
    const all = await fixture.store.query({ scope, select: 'all', limit: 2 });
    const next = await fixture.store.query({
      scope,
      select: 'all',
      limit: 2,
      afterId: all.rows.at(-1)?.id,
    });
    const combined = [...all.rows, ...next.rows].map((row) => row.id);
    const expectedAll = created.map((snapshot) => snapshot.id).sort();
    return {
      kind: 'queryBoundary',
      adapter,
      dueOrderExact: JSON.stringify(due.rows.map((row) => row.id)) === JSON.stringify(expectedDue),
      dueLimitExact:
        expectedDue.length > 1 &&
        dueLimited.rows.length === 1 &&
        dueLimited.rows[0]?.id === expectedDue[0],
      dueCursorExactError:
        dueCursorError instanceof RangeError &&
        dueCursorError.message === 'afterId is not supported for due queries',
      allCursorContinuation: JSON.stringify(combined) === JSON.stringify(expectedAll),
      allPageBounded: all.rows.length === 2 && next.rows.length === 2,
    };
  } finally {
    fixture.close();
  }
}

async function invalidWriteSample(adapter) {
  const fixture = adapterFixture(adapter);
  try {
    const scope = `storage-invalid-write-${adapter}`;
    const queue = createWorkOnce({ store: fixture.store, scope }).define('job');
    const snapshot = await queue.ensure(null, { key: 'x' });
    const before = JSON.stringify((await fixture.store.getMany([snapshot.id])).rows[0]);
    const capture = async (decide) => {
      try {
        await fixture.store.atomic(snapshot.id, decide);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    const revisionError = await capture((row) => ({ next: { ...row }, value: null }));
    const identityError = await capture((row) => ({
      next: { ...row, id: `${row.id}-other`, revision: row.revision + 1 },
      value: null,
    }));
    const deadlineError = await capture((row) => ({
      next: { ...row, revision: row.revision + 1 },
      validUntil: Number.NaN,
      value: null,
    }));
    const serializationError = await capture((row) => ({
      next: { ...row, revision: row.revision + 1 },
      value: { unsupported: BigInt(1) },
    }));
    const expiredWrite = await capture((row) => ({
      next: { ...row, revision: row.revision + 1 },
      validUntil: 100,
      value: null,
    }));
    const after = JSON.stringify((await fixture.store.getMany([snapshot.id])).rows[0]);
    return {
      kind: 'invalidWrite',
      adapter,
      exactRevisionError:
        revisionError?.message === 'Store decision must advance exactly one revision',
      exactIdentityError: identityError?.message === 'Store decision changed work identity',
      exactDeadlineError:
        deadlineError instanceof RangeError &&
        deadlineError.message === 'validUntil must be a safe integer >= 0',
      serializationBeforeCommit:
        serializationError instanceof TypeError && /JSON data/u.test(serializationError.message),
      deadlineEqualityRejected: expiredWrite?.code === 'lease_expired',
      noWrite: before === after,
    };
  } finally {
    fixture.close();
  }
}

async function casHistoryCongruenceSample() {
  async function lane(falseWrites) {
    const f = casFixture({ falseWrites, maxConflicts: 5 });
    const queue = createWorkOnce({ store: f.store, scope: 'storage-cas-history' }).define('job');
    const ensured = await queue.ensure(null, { key: 'x' });
    const row = (await f.native.getMany([ensured.id])).rows[0];
    const [claimed] = await queue.claim({ workerId: 'next', limit: 1 });
    return {
      compareCalls: f.compareCalls(),
      durable: row,
      future: { fence: claimed.ref.fence, attempts: claimed.attempt.number },
    };
  }
  const direct = await lane(0);
  const contended = await lane(2);
  return {
    kind: 'casHistoryCongruence',
    materiallyDifferentHistory: direct.compareCalls === 2 && contended.compareCalls === 4,
    sameDurableProjection: JSON.stringify(direct.durable) === JSON.stringify(contended.durable),
    sameFuture: JSON.stringify(direct.future) === JSON.stringify(contended.future),
  };
}

function casBoundarySample() {
  let reads = 0;
  const base = createMemoryStore({ now: () => 100 });
  const port = {
    async getMany(ids) {
      reads++;
      return base.getMany(ids);
    },
    query: (query) => base.query(query),
    compareExchange: (change) =>
      base.atomic(change.id, (row, now) => {
        if (row?.revision !== change.expectedRevision) return { value: false };
        return { next: change.next, value: true };
      }),
  };
  let zeroError;
  try {
    createCompareExchangeStore(port, { maxConflicts: 0 });
  } catch (error) {
    zeroError = error;
  }
  let oneAccepted = false;
  let maxSafeAccepted = false;
  const one = createCompareExchangeStore(port, { maxConflicts: 1 });
  const max = createCompareExchangeStore(port, { maxConflicts: Number.MAX_SAFE_INTEGER });
  return Promise.all([
    createWorkOnce({ store: one, scope: 'cas-boundary-one' })
      .define('job')
      .ensure(null, { key: 'x' })
      .then(() => {
        oneAccepted = true;
      }),
    createWorkOnce({ store: max, scope: 'cas-boundary-max' })
      .define('job')
      .ensure(null, { key: 'x' })
      .then(() => {
        maxSafeAccepted = true;
      }),
  ]).then(() => ({
    kind: 'casBoundary',
    zeroRejectedBeforeRead:
      zeroError instanceof RangeError &&
      zeroError.message === 'maxConflicts must be a safe integer >= 1' &&
      reads === 2,
    oneAccepted,
    maxSafeAccepted,
  }));
}

async function casContentionSample() {
  const f = casFixture({ falseWrites: 2, maxConflicts: 5 });
  const q = createWorkOnce({ store: f.store, scope: 'storage-cas-contention' }).define('job');
  const snapshot = await q.ensure(null, { key: 'x' });
  return {
    kind: 'casContention',
    freshReadRetries: f.compareCalls() === 3,
    committedOnce: (await f.native.getMany([snapshot.id])).rows[0]?.revision === 1,
  };
}

async function casExhaustionSample() {
  const f = casFixture({ falseWrites: 100, maxConflicts: 3 });
  const q = createWorkOnce({ store: f.store, scope: 'storage-cas-exhaustion' }).define('job');
  let error;
  try {
    await q.ensure(null, { key: 'x' });
  } catch (caught) {
    error = caught;
  }
  const rows = await f.native.query({ scope: 'storage-cas-exhaustion', select: 'all', limit: 10 });
  return {
    kind: 'casExhaustion',
    exactAttempts: f.compareCalls() === 3,
    exactError:
      error?.message ===
      'Work store remained contended; retry the command, not the external effect',
    noCallerWrite: rows.rows.length === 0,
  };
}

async function casUnknownSample() {
  const f = casFixture();
  let throwAfterCommit = true;
  let calls = 0;
  const port = {
    ...f.port,
    async compareExchange(change) {
      calls++;
      const committed = await f.port.compareExchange(change);
      if (throwAfterCommit) {
        throwAfterCommit = false;
        throw new Error('unknown acknowledgement');
      }
      return committed;
    },
  };
  const store = createCompareExchangeStore(port, { maxConflicts: 5 });
  const q = createWorkOnce({ store, scope: 'storage-cas-unknown' }).define('job');
  let firstError;
  try {
    await q.ensure(null, { key: 'x' });
  } catch (error) {
    firstError = error;
  }
  const rows = await f.native.query({ scope: 'storage-cas-unknown', select: 'all', limit: 10 });
  const replay = await q.ensure(null, { key: 'x' });
  return {
    kind: 'casUnknown',
    exactError: firstError?.message === 'unknown acknowledgement',
    noBlindRetry: calls === 1,
    committedTruthPreserved: rows.rows.length === 1 && replay.phase.state === 'queued',
  };
}

function sqliteBoundarySample() {
  function open(value) {
    const directory = mkdtempSync(join(tmpdir(), 'workonce-sqlite-boundary-'));
    const path = join(directory, 'queue.sqlite');
    const originalExec = DatabaseSync.prototype.exec;
    let effectiveBusyTimeout;
    DatabaseSync.prototype.exec = function observedExec(sql) {
      const result = originalExec.call(this, sql);
      if (/^PRAGMA busy_timeout=/u.test(String(sql).trim())) {
        const row = this.prepare('PRAGMA busy_timeout').get();
        effectiveBusyTimeout = Number(Object.values(row ?? {})[0]);
      }
      return result;
    };
    try {
      const store = createSqliteStore(path, { busyTimeoutMs: value });
      store.close();
      return { accepted: true, effectiveBusyTimeout };
    } catch (error) {
      return { accepted: false, error, effectiveBusyTimeout };
    } finally {
      DatabaseSync.prototype.exec = originalExec;
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const zero = open(0);
  const max = open(Number.MAX_SAFE_INTEGER);
  const negative = open(-1);
  const fraction = open(1.5);
  return {
    kind: 'sqliteBoundary',
    zeroAccepted: zero.accepted,
    maxSafeAccepted: max.accepted && max.effectiveBusyTimeout === 2_147_483_647,
    negativeExact:
      !negative.accepted &&
      negative.error instanceof RangeError &&
      negative.error.message === 'busyTimeoutMs must be a safe integer >= 0',
    fractionExact:
      !fraction.accepted &&
      fraction.error instanceof RangeError &&
      fraction.error.message === 'busyTimeoutMs must be a safe integer >= 0',
  };
}

function sqliteBusyHelperSample() {
  function lane(kind) {
    const directory = mkdtempSync(join(tmpdir(), `workonce-storage-busy-${kind}-`));
    const path = join(directory, 'queue.sqlite');
    const original = DatabaseSync.prototype.exec;
    let injected = 0;
    let walAttempts = 0;
    DatabaseSync.prototype.exec = function patchedExec(sql) {
      if (String(sql).includes('PRAGMA journal_mode=WAL')) walAttempts++;
      if (injected === 0 && String(sql).includes('PRAGMA journal_mode=WAL')) {
        injected++;
        const error = new Error(
          kind === 'message' ? 'database is busy' : 'opaque native sqlite failure',
        );
        error.code = 'ERR_SQLITE_ERROR';
        if (kind === 'busyCode') {
          error.errcode = 5;
          error.errstr = 'database is busy';
        } else if (kind === 'lockedCode') {
          error.errcode = 6;
          error.errstr = 'database table is locked';
        }
        throw error;
      }
      return original.call(this, sql);
    };
    try {
      const store = createSqliteStore(path, { busyTimeoutMs: 1000 });
      store.close();
      return injected === 1 && walAttempts >= 2;
    } finally {
      DatabaseSync.prototype.exec = original;
      rmSync(directory, { recursive: true, force: true });
    }
  }
  return {
    kind: 'sqliteBusy',
    messageBusyRetried: lane('message'),
    nativeBusyCodeRetried: lane('busyCode'),
    nativeLockedCodeRetried: lane('lockedCode'),
  };
}

export async function runStorageRefinementSamples() {
  const samples = [];
  for (const adapter of ['memory', 'sqlite', 'cas']) {
    samples.push(await detachedSample(adapter));
    samples.push(await adapterHistoryCongruenceSample(adapter));
    samples.push(await atomicContentionSample(adapter));
    samples.push(await queryBoundarySample(adapter));
    samples.push(await invalidWriteSample(adapter));
  }
  samples.push(await casContentionSample());
  samples.push(await casExhaustionSample());
  samples.push(await casUnknownSample());
  samples.push(await casHistoryCongruenceSample());
  samples.push(await casBoundarySample());
  samples.push(sqliteBoundarySample());
  samples.push(sqliteBusyHelperSample());
  return samples;
}

const storageExpectedKindCounts = Object.freeze({
  detached: 3,
  adapterHistoryCongruence: 3,
  atomicContention: 3,
  queryBoundary: 3,
  invalidWrite: 3,
  casContention: 1,
  casExhaustion: 1,
  casUnknown: 1,
  casHistoryCongruence: 1,
  casBoundary: 1,
  sqliteBoundary: 1,
  sqliteBusy: 1,
});

export function assertStorageRefinementSamples(samples) {
  assert.equal(samples.length, 22, 'storage refinement sample family unexpectedly changed');
  const observedKindCounts = {};
  for (const sample of samples)
    observedKindCounts[sample.kind] = (observedKindCounts[sample.kind] ?? 0) + 1;
  assert.deepEqual(
    observedKindCounts,
    storageExpectedKindCounts,
    'storage sample kind multiplicity drifted',
  );
  const adapterSamples = samples
    .filter((sample) => sample.adapter !== undefined)
    .map((sample) => `${sample.kind}:${sample.adapter}`)
    .sort();
  const expectedAdapterSamples = [
    'adapterHistoryCongruence:cas',
    'adapterHistoryCongruence:memory',
    'adapterHistoryCongruence:sqlite',
    'atomicContention:cas',
    'atomicContention:memory',
    'atomicContention:sqlite',
    'detached:cas',
    'detached:memory',
    'detached:sqlite',
    'invalidWrite:cas',
    'invalidWrite:memory',
    'invalidWrite:sqlite',
    'queryBoundary:cas',
    'queryBoundary:memory',
    'queryBoundary:sqlite',
  ];
  assert.deepEqual(
    adapterSamples,
    expectedAdapterSamples,
    'storage adapter sample coverage drifted',
  );
  const booleanFields = {
    adapterHistoryCongruence: ['materiallyDifferentHistory', 'sameDurableProjection', 'sameFuture'],
    atomicContention: ['allSameSnapshot', 'oneInsertRevision', 'oneStoredRow'],
    casBoundary: ['maxSafeAccepted', 'oneAccepted', 'zeroRejectedBeforeRead'],
    casContention: ['committedOnce', 'freshReadRetries'],
    casExhaustion: ['exactAttempts', 'exactError', 'noCallerWrite'],
    casHistoryCongruence: ['materiallyDifferentHistory', 'sameDurableProjection', 'sameFuture'],
    casUnknown: ['committedTruthPreserved', 'exactError', 'noBlindRetry'],
    detached: [
      'cursorExact',
      'duplicateSlotsDetached',
      'duplicateSlotsExact',
      'getManyDetached',
      'orderExact',
      'queryDetached',
    ],
    invalidWrite: [
      'deadlineEqualityRejected',
      'exactDeadlineError',
      'exactIdentityError',
      'exactRevisionError',
      'noWrite',
      'serializationBeforeCommit',
    ],
    queryBoundary: [
      'allCursorContinuation',
      'allPageBounded',
      'dueCursorExactError',
      'dueLimitExact',
      'dueOrderExact',
    ],
    sqliteBoundary: ['fractionExact', 'maxSafeAccepted', 'negativeExact', 'zeroAccepted'],
    sqliteBusy: ['messageBusyRetried', 'nativeBusyCodeRetried', 'nativeLockedCodeRetried'],
  };
  for (const sample of samples) {
    const fields = booleanFields[sample.kind];
    assert.ok(fields, `Unmapped storage sample: ${JSON.stringify(sample)}`);
    assertExactBooleanSample(sample, fields, sample.adapter === undefined ? [] : ['adapter']);
  }
}
