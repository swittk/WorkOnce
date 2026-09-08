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
      const store = directory
        ? createSqliteStore(join(directory, 'queue.sqlite'), { now: () => clock })
        : createMemoryStore({ now: () => clock });
      return {
        store,
        advance(ms) {
          clock += ms;
        },
        close() {
          store.close?.();
          if (directory) rmSync(directory, { recursive: true });
        },
      };
    });
    assert.equal(passed.length, 18);
    console.log(adapter, passed);
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
