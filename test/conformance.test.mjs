import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConformance, runReadClockConformance } from '../dist/conformance.js';
import { createMemoryStore } from '../dist/memory.js';
import { createSqliteStore } from '../dist/sqlite.js';
import { createCompareExchangeStore } from '../dist/cas.js';
for (const adapter of ['memory', 'sqlite'])
  test(`${adapter}: shared adversarial conformance`, async () => {
    const passed = await runConformance(() => {
      let clock = 100_000;
      const directory = adapter === 'sqlite' ? mkdtempSync(join(tmpdir(), 'workonce-')) : undefined;
      let store;
      try {
        store = directory
          ? createSqliteStore(join(directory, 'queue.sqlite'), { now: () => clock })
          : createMemoryStore({ now: () => clock });
      } catch (error) {
        if (directory) rmSync(directory, { recursive: true, force: true });
        throw error;
      }
      return {
        store,
        advance(ms) {
          clock += ms;
        },
        close() {
          try {
            store.close?.();
          } finally {
            if (directory) rmSync(directory, { recursive: true, force: true });
          }
        },
      };
    });
    assert.equal(passed.length, 26);
    console.log(adapter, passed);
  });

test('shared conformance derives accepted write deadlines from the atomic decision clock', async () => {
  let clock = 100_000;
  const passed = await runConformance(() => {
    const base = createMemoryStore({ now: () => clock });
    return {
      store: {
        ...base,
        atomic(id, decide) {
          return base.atomic(id, (row, now) => {
            const change = decide(row, now);
            if (change.value === 'accepted-before-deadline') clock += 2;
            return change;
          });
        },
      },
      advance(ms) {
        clock += ms;
      },
    };
  });
  assert.equal(passed.length, 26);
});

test('shared conformance accepts adapter-specific invalid-write rejection messages', async () => {
  let clock = 100_000;
  const passed = await runConformance(() => {
    const base = createMemoryStore({ now: () => clock });
    return {
      store: {
        ...base,
        async atomic(id, decide) {
          try {
            return await base.atomic(id, decide);
          } catch (error) {
            if (/revision|validUntil/u.test(error?.message ?? ''))
              throw new Error('adapter rejected invalid write');
            throw error;
          }
        },
      },
      advance(ms) {
        clock += ms;
      },
    };
  });
  assert.equal(passed.length, 26);
});

test('shared conformance remains message-agnostic when an adapter uses the old assertion label verbatim', async () => {
  let clock = 100_000;
  const passed = await runConformance(() => {
    const base = createMemoryStore({ now: () => clock });
    return {
      store: {
        ...base,
        async atomic(id, decide) {
          try {
            return await base.atomic(id, decide);
          } catch (error) {
            if (/revision/u.test(error?.message ?? ''))
              throw new Error('next revision must equal expectedRevision exactly');
            throw error;
          }
        },
      },
      advance(ms) {
        clock += ms;
      },
    };
  });
  assert.equal(passed.length, 26);
});

test('shared conformance rejects adapters that treat validUntil equality as still writable', async () => {
  let clock = 100_000;
  await assert.rejects(
    runConformance(() => {
      const native = createMemoryStore({ now: () => clock });
      const store = createCompareExchangeStore({
        getMany: (ids) => native.getMany(ids),
        query: (query) => native.query(query),
        compareExchange: (change) =>
          native.atomic(change.id, (row, now) => {
            if (
              row?.revision !== change.expectedRevision ||
              (change.validUntil !== undefined && now > change.validUntil)
            )
              return { value: false };
            return { next: change.next, value: true };
          }),
      });
      return {
        store,
        advance(ms) {
          clock += ms;
        },
        close() {
          native.close?.();
        },
      };
    }),
    /validUntil equal to the storage clock must reject/u,
  );
});

test('shared conformance rejects deadline-equality bugs when the storage clock advances between read and decision', async () => {
  await assert.rejects(
    runConformance(() => {
      let clock = 100_000;
      let advanceAfterMalformedDeadlineRead = false;
      const native = createMemoryStore({ now: () => clock });
      const badEqualityStore = createCompareExchangeStore({
        getMany: (ids) => native.getMany(ids),
        query: (query) => native.query(query),
        compareExchange: (change) =>
          native.atomic(change.id, (row, now) => {
            if (
              row?.revision !== change.expectedRevision ||
              (change.validUntil !== undefined && now > change.validUntil)
            )
              return { value: false };
            return { next: change.next, value: true };
          }),
      });
      return {
        store: {
          ...badEqualityStore,
          atomic(id, decide) {
            return badEqualityStore.atomic(id, (row, now) => {
              const change = decide(row, now);
              if (Number.isNaN(change.validUntil)) advanceAfterMalformedDeadlineRead = true;
              return change;
            });
          },
          async getMany(ids) {
            const result = await badEqualityStore.getMany(ids);
            if (advanceAfterMalformedDeadlineRead) {
              advanceAfterMalformedDeadlineRead = false;
              clock += 1;
            }
            return result;
          },
        },
        advance(ms) {
          clock += ms;
        },
        close() {
          native.close?.();
        },
      };
    }),
    /validUntil equal to the storage clock must reject/u,
  );
});

test('shared conformance rejects adapters that accept due afterId cursors', async () => {
  await assert.rejects(
    runConformance(() => {
      let clock = 100_000;
      const base = createMemoryStore({ now: () => clock });
      return {
        store: {
          ...base,
          async query(query) {
            if (query.select === 'due' && query.afterId !== undefined) {
              const { afterId: _ignored, ...withoutCursor } = query;
              return base.query(withoutCursor);
            }
            return base.query(query);
          },
        },
        advance(ms) {
          clock += ms;
        },
      };
    }),
    /due queries must reject the id-only afterId cursor/u,
  );
});

for (const select of ['all', 'outbox'])
  test(`shared conformance rejects adapters that ignore ${select} afterId cursors`, async () => {
    await assert.rejects(
      runConformance(() => {
        let clock = 100_000;
        const base = createMemoryStore({ now: () => clock });
        return {
          store: {
            ...base,
            async query(query) {
              if (
                query.scope === 'cursor-contract' &&
                query.select === select &&
                query.afterId !== undefined
              ) {
                const { afterId: _ignored, ...withoutCursor } = query;
                return base.query(withoutCursor);
              }
              return base.query(query);
            },
          },
          advance(ms) {
            clock += ms;
          },
        };
      }),
      new RegExp(`${select} cursor pagination did not terminate`, 'u'),
    );
  });

test('shared conformance rejects adapters that deduplicate duplicate getMany ids', async () => {
  await assert.rejects(
    runConformance(() => {
      let clock = 100_000;
      const base = createMemoryStore({ now: () => clock });
      return {
        store: {
          ...base,
          async getMany(ids) {
            return base.getMany([...new Set(ids)]);
          },
        },
        advance(ms) {
          clock += ms;
        },
      };
    }),
    /getMany must preserve requested slots including duplicate ids/u,
  );
});

test('a conforming store may linearize completion before an earlier invoked cancellation', async () => {
  const passed = await runConformance(() => {
    let clock = 100_000;
    let calls = 0;
    const base = createMemoryStore({ now: () => clock });
    return {
      store: {
        ...base,
        async atomic(id, decide) {
          // Delay before entering the atomic boundary, not inside its synchronous decision.
          if (++calls % 2 === 1) await new Promise((resolve) => setTimeout(resolve, 15));
          return base.atomic(id, decide);
        },
      },
      advance(ms) {
        clock += ms;
      },
    };
  });
  assert.equal(passed.length, 26);
});

function makeReadClockFixture(lateClock) {
  let clock = 100_000;
  const native = createMemoryStore({ now: () => clock });
  let stalled;
  return {
    store: {
      ...native,
      async getMany(ids) {
        // Model a real DB read returning its old row before another writer renews it.
        const observed = await native.getMany(ids);
        if (stalled && ids.includes(stalled.id)) {
          const current = stalled;
          stalled = undefined;
          current.enter();
          await current.wait;
          // A buggy adapter samples now after reading its (now-stale) row.
          return { ...observed, now: lateClock ? clock : observed.now };
        }
        return observed;
      },
    },
    advance(ms) {
      clock += ms;
    },
    pauseGetManyAfterSnapshot(id) {
      let enter;
      let release;
      const entered = new Promise((resolve) => {
        enter = resolve;
      });
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      stalled = { id, enter, wait };
      return { entered, release };
    },
  };
}

test('read-clock conformance accepts a clock sampled before the storage read', async () => {
  await runReadClockConformance(() => makeReadClockFixture(false));
});

test('read-clock conformance rejects a stale read paired with a newer clock', async () => {
  await assert.rejects(
    runReadClockConformance(() => makeReadClockFixture(true)),
    (error) => error.code === 'lease_expired',
  );
});

test('shared conformance rejects applying definition filtering after the query limit', async () => {
  await assert.rejects(
    runConformance(() => {
      let clock = 100_000;
      const base = createMemoryStore({ now: () => clock });
      return {
        store: {
          ...base,
          async query(query) {
            if (query.scope !== 'filtered-discovery' || query.select !== 'due')
              return base.query(query);
            // Incorrect adapters select the first limit rows, THEN apply the definition.
            const result = await base.query({ ...query, definition: undefined });
            return {
              ...result,
              rows: result.rows.filter((row) => row.definition === query.definition),
            };
          },
        },
        advance(ms) {
          clock += ms;
        },
      };
    }),
    /due (discovery must sort by deadline|limit)/u,
  );
});

test('shared conformance rejects stores advertising retention without physical expiry', async () => {
  await assert.rejects(
    runConformance(() => {
      let clock = 100_000;
      const base = createMemoryStore({ now: () => clock });
      return {
        store: {
          ...base,
          query(query) {
            if (query.scope === 'retention-conformance' && query.select === 'expired') {
              return base.query(query).then(({ now }) => ({ rows: [], now }));
            }
            return base.query(query);
          },
        },
        advance(ms) {
          clock += ms;
        },
      };
    }),
    /Expected values to be strictly equal/u,
  );
});
