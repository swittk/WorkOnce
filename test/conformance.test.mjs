import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConformance } from '../dist/conformance.js';
import { createMemoryStore } from '../dist/memory.js';
import { createSqliteStore } from '../dist/sqlite.js';
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
    assert.equal(passed.length, 18);
    console.log(adapter, passed);
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
  assert.equal(passed.length, 18);
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
  assert.equal(passed.length, 18);
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
  assert.equal(passed.length, 18);
});
