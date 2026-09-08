import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompareExchangeStore } from '../dist/cas.js';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
import { createSqliteStore } from '../dist/sqlite.js';

const observe = (promise) =>
  promise.then(
    (value) => ({ rejected: false, value }),
    (error) => ({ rejected: true, error }),
  );

function createCasStore() {
  const native = createMemoryStore({ now: () => 100 });
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

function sqliteFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-read-proof-'));
  const store = createSqliteStore(join(directory, 'workonce.sqlite'), { now: () => 100 });
  return {
    store,
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function adapterSample(adapter, store, cleanup = () => {}) {
  const scope = `typed-read-${adapter}`;
  try {
    const v1 = createWorkOnce({ store, scope }).define('job', { version: '1' });
    const v2 = createWorkOnce({ store, scope }).define('job', { version: '2' });
    const wrongKind = createWorkOnce({ store, scope }).define('other', { version: '1' });
    const wrongScope = createWorkOnce({ store, scope: `${scope}-other` }).define('job', {
      version: '1',
    });
    const oldSnapshot = await v1.ensure({ version: 1 }, { key: 'old' });
    const newSnapshot = await v2.ensure({ version: 2 }, { key: 'new' });

    const mismatchInspect = await observe(v2.inspect('old'));
    const mismatchId = await observe(v2.inspectId(oldSnapshot.id));
    const mismatchItem = await observe(v2.item({ version: 2 }, 'old').inspect());
    const mismatchHistory = await observe(v2.history('old'));
    const mixedForward = await observe(v2.inspectMany(['new', 'old']));
    const mixedReverse = await observe(v2.inspectMany(['old', 'new']));
    const ordered = await v2.inspectMany(['missing', 'new', 'new']);
    const missingInspect = await v2.inspect('missing');
    const missingId = await v2.inspectId('definitely-missing-id');
    const missingHistory = await observe(v2.history('missing'));
    const wrongKindId = await observe(wrongKind.inspectId(oldSnapshot.id));
    const wrongScopeId = await observe(wrongScope.inspectId(oldSnapshot.id));
    const currentById = await v2.inspectId(newSnapshot.id);

    const definitionFailures = [
      mismatchInspect,
      mismatchId,
      mismatchItem,
      mismatchHistory,
      mixedForward,
      mixedReverse,
    ];
    return {
      kind: 'readAdapter',
      adapter,
      definitionFenceExact: definitionFailures.every(
        (result) => result.rejected && result.error?.code === 'definition_changed',
      ),
      batchOrderExact:
        ordered.length === 3 &&
        ordered[0] === undefined &&
        JSON.stringify(ordered[1]) === JSON.stringify(newSnapshot) &&
        JSON.stringify(ordered[2]) === JSON.stringify(newSnapshot),
      missingReadsExact: missingInspect === undefined && missingId === undefined,
      missingHistoryNotFound: missingHistory.rejected && missingHistory.error?.code === 'not_found',
      wrongKindNotFound: wrongKindId.rejected && wrongKindId.error?.code === 'not_found',
      wrongScopeNotFound: wrongScopeId.rejected && wrongScopeId.error?.code === 'not_found',
      currentIdExact: JSON.stringify(currentById) === JSON.stringify(newSnapshot),
    };
  } finally {
    cleanup();
  }
}

export async function runTypedReadBoundarySamples() {
  const sqlite = sqliteFixture();
  return Promise.all([
    adapterSample('memory', createMemoryStore({ now: () => 100 })),
    adapterSample('sqlite', sqlite.store, sqlite.cleanup),
    adapterSample('cas', createCasStore()),
  ]);
}

export function assertTypedReadBoundarySamples(samples) {
  if (samples.length !== 3)
    throw new Error(`Expected 3 read adapter samples, got ${samples.length}`);
  const adapters = samples.map((sample) => sample.adapter).sort();
  if (JSON.stringify(adapters) !== JSON.stringify(['cas', 'memory', 'sqlite']))
    throw new Error(`Unexpected read adapter set: ${JSON.stringify(adapters)}`);
  for (const sample of samples)
    for (const [field, value] of Object.entries(sample))
      if (field !== 'kind' && field !== 'adapter' && value !== true)
        throw new Error(`Typed read refinement failed: ${sample.adapter}.${field}`);
}
