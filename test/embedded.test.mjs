import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmbeddedStore } from '../dist/embedded.js';
import { runConformance } from '../dist/conformance.js';
import { canonical, dueAt } from '../dist/kernel.js';
test('embedded adapter passes the same shared contract when its supplied boundary really serializes writes', async () => {
  const passed = await runConformance(() => {
    let now = 100000;
    const rows = new Map(),
      locks = new Map();
    const store = createEmbeddedStore({
      now: () => now,
      async load(id) {
        if (!rows.has(id)) rows.set(id, { id });
        return structuredClone(rows.get(id));
      },
      async loadMany(ids) {
        return ids.map((id) => (rows.has(id) ? structuredClone(rows.get(id)) : undefined));
      },
      async select(query) {
        return [...rows.values()]
          .filter(
            (row) =>
              row.work?.scope === query.scope &&
              (!query.kind || row.work.kind === query.kind) &&
              (query.select !== 'due' || (dueAt(row.work) ?? Infinity) <= now) &&
              (query.select !== 'outbox' || row.work.outbox.length > 0) &&
              (!query.afterId || row.id > query.afterId),
          )
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, query.limit)
          .map((row) => structuredClone(row));
      },
      read: (row) => row.work,
      async commit(row, work) {
        rows.set(row.id, { id: row.id, work: JSON.parse(canonical(work)) });
      },
      async exclusive(id, execute) {
        const previous = locks.get(id) ?? Promise.resolve();
        let release;
        const current = new Promise((resolve) => (release = resolve));
        locks.set(id, current);
        await previous;
        try {
          return await execute();
        } finally {
          release();
          if (locks.get(id) === current) locks.delete(id);
        }
      },
    });
    return {
      store,
      advance(ms) {
        now += ms;
      },
    };
  });
  assert.equal(passed.length, 17);
});
