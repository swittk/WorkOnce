import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteStore } from '../dist/sqlite.js';
import { createWorkOnce } from '../dist/index.js';
const trials = [];
const count = 1000;
for (let trial = 0; trial < 3; trial++) {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-benchmark-'));
  const store = createSqliteStore(join(directory, 'queue.sqlite'));
  try {
    const q = createWorkOnce({ store, scope: 'benchmark' }).define('noop');
    const start = performance.now();
    for (let i = 0; i < count; i++)
      await q.enqueue({ assetId: `asset-${i}`, urgent: false }, { key: String(i) });
    const enqueued = performance.now();
    let completed = 0;
    while (completed < count) {
      const jobs = await q.claim({ workerId: 'benchmark', limit: 32 });
      if (!jobs.length) throw new Error('Unexpected empty claim');
      for (const run of jobs) {
        await run.settle(run.succeed());
        completed++;
      }
    }
    const end = performance.now();
    if ((await q.inspect(String(count - 1))).phase.state !== 'succeeded')
      throw new Error('Benchmark did not commit');
    trials.push({
      enqueueMs: enqueued - start,
      claimAndSettleMs: end - enqueued,
      totalMs: end - start,
      jobsPerSecond: (count * 1000) / (end - start),
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
const median = (field) => [...trials].sort((a, b) => a[field] - b[field])[1][field];
console.log(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      adapter: 'SQLite local file, WAL, synchronous=FULL',
      jobsPerTrial: count,
      claimBatch: 32,
      trials,
      median: {
        enqueueMs: median('enqueueMs'),
        claimAndSettleMs: median('claimAndSettleMs'),
        jobsPerSecond: median('jobsPerSecond'),
      },
      limits:
        'Synthetic small-payload control-plane baseline, not an application before/after comparison.',
    },
    null,
    2,
  ),
);
