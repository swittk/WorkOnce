import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkOnce, exponentialBackoff } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
import { createSqliteStore } from '../dist/sqlite.js';
import { createCompareExchangeStore } from '../dist/cas.js';
import { auditPhases, seedAuditPhase } from '../scripts/runtime-boundary-refinement.mjs';

const actions = [
  'ensure',
  'enqueue',
  'claim',
  'heartbeat',
  'settleSame',
  'settleConflict',
  'cancel',
  'cancelCurrent',
  'retry',
  'rerun',
  'restart',
  'wake',
  'wakeCurrent',
  'item.retry',
  'item.rerun',
  'item.restart',
  'item.cancel',
  'item.wake',
];
function adapter(kind) {
  const base =
    kind === 'sqlite'
      ? createSqliteStore(':memory:', { now: () => 100 })
      : createMemoryStore({ now: () => 100 });
  if (kind !== 'cas') return base;
  return createCompareExchangeStore({
    getMany: (ids) => base.getMany(ids),
    query: (query) => base.query(query),
    compareExchange: (change) =>
      base.atomic(change.id, (row, now) => {
        if (
          row?.revision !== change.expectedRevision ||
          (change.validUntil !== undefined && now >= change.validUntil)
        )
          return { value: false };
        return { next: change.next, value: true };
      }),
  });
}
function outcomeFor(phase, action) {
  const waiting = phase === 'waitingRetry' || phase === 'waitingDefer';
  if (action === 'heartbeat') return phase === 'running' ? undefined : 'stale_attempt';
  if (action === 'settleSame' || action === 'settleConflict') {
    if (phase === 'running') return undefined;
    if (waiting || phase === 'failedManual' || phase === 'failedDenied' || phase === 'succeeded')
      return action === 'settleConflict' ? 'settlement_conflict' : undefined;
    return 'stale_attempt';
  }
  if (action.endsWith('retry')) return phase === 'failedManual' ? undefined : 'retry_denied';
  if (action.endsWith('rerun')) return phase === 'succeeded' ? undefined : 'retry_denied';
  if (action.endsWith('restart')) return phase === 'failedDenied' ? 'retry_denied' : undefined;
  if (action.endsWith('wake') || action === 'wakeCurrent')
    return waiting || phase === 'queued' ? undefined : 'not_waiting';
  return undefined;
}

for (const kind of ['memory', 'sqlite', 'cas']) {
  test(`${kind}: complete public lifecycle command/phase matrix`, async () => {
    const store = adapter(kind);
    let cases = 0;
    try {
      for (const phase of auditPhases)
        for (const action of actions) {
          const scope = `${phase}:${action}`;
          const f = await seedAuditPhase(store, scope, phase);
          const q = f.queue;
          const before = (await store.getMany([f.snapshot.id])).rows[0];
          const ref = f.run?.ref ?? { workId: f.snapshot.id, generation: 1, fence: 0 };
          const item = q.item({ value: 1 }, 'job');
          const options = { key: 'job', generation: 1 };
          const invoke = () => {
            if (action === 'ensure' || action === 'enqueue')
              return q[action]({ value: 1 }, { key: 'job' });
            if (action === 'claim') return q.claim({ workerId: 'next', limit: 3 });
            if (action === 'heartbeat') return q.heartbeat(ref);
            if (action === 'settleSame')
              return q.settle(ref, f.outcome ?? { type: 'succeed', result: null, next: [] });
            if (action === 'settleConflict')
              return q.settle(ref, { type: 'succeed', result: 'different', next: [] });
            if (action === 'wake') return q.wake({ ...options, revision: f.snapshot.revision });
            if (action.startsWith('item.')) return item[action.slice(5)]({ expectedGeneration: 1 });
            return q[action](options);
          };
          const code = outcomeFor(phase, action);
          if (code) {
            await assert.rejects(invoke(), (error) => error?.code === code, `${scope}: ${code}`);
            assert.deepEqual(
              (await store.getMany([f.snapshot.id])).rows[0],
              before,
              `${scope}: rejection must not write`,
            );
          } else {
            const result = await invoke();
            const after = (await store.getMany([f.snapshot.id])).rows[0];
            const waiting = phase.startsWith('waiting');
            const terminal = ['failedManual', 'failedDenied', 'succeeded', 'cancelled'].includes(
              phase,
            );
            let state = before.phase.state,
              generation = 1,
              fence = before.fence,
              written = false;
            if (action === 'claim' && (waiting || phase === 'queued')) {
              state = 'running';
              fence++;
              written = true;
              assert.equal(result.length, 1, scope);
            } else if (action === 'claim') assert.equal(result.length, 0, scope);
            if (action === 'heartbeat') written = true;
            if (action.startsWith('settle') && phase === 'running') {
              state = 'succeeded';
              written = true;
            }
            if (action.includes('cancel') && !terminal) {
              state = 'cancelled';
              written = true;
            }
            if (
              action.endsWith('retry') ||
              action.endsWith('rerun') ||
              (action.endsWith('restart') && terminal)
            ) {
              if (phase === 'failedManual' || phase === 'succeeded') {
                state = 'queued';
                generation = 2;
                written = true;
              }
            }
            if (action.endsWith('wake') || action === 'wakeCurrent') written = true;
            assert.equal(after.phase.state, state, scope);
            assert.equal(after.generation, generation, scope);
            assert.equal(after.fence, fence, scope);
            assert.equal(after.revision, before.revision + (written ? 1 : 0), scope);
            if (!written) assert.deepEqual(after, before, `${scope}: no-op must preserve storage`);
            if (generation === 2) {
              assert.equal(after.attempts, 0);
              assert.equal(after.retries, 0);
              assert.equal(after.deferrals, 0);
              assert.equal(after.firstStartedAt, undefined);
              assert.equal(after.receipt, undefined);
            }
            if (action === 'cancelCurrent' || action === 'item.cancel') {
              assert.deepEqual(result.activeAttempt, phase === 'running' ? ref : undefined);
            }
          }
          cases++;
        }
      for (const phase of auditPhases) {
        const f = await seedAuditPhase(store, `stale-${phase}`, phase);
        const before = (await store.getMany([f.snapshot.id])).rows[0];
        const q = f.queue;
        for (const action of [
          'retry',
          'rerun',
          'cancel',
          'wake',
          'restart',
          'cancelCurrent',
          'wakeCurrent',
        ]) {
          await assert.rejects(
            q[action]({
              key: 'job',
              generation: 0,
              expectedGeneration: 0,
              revision: f.snapshot.revision,
            }),
            (error) => error?.code === 'generation_conflict',
          );
          assert.deepEqual((await store.getMany([f.snapshot.id])).rows[0], before);
          cases++;
        }
      }
      assert.equal(cases, 200);
    } finally {
      store.close?.();
    }
  });
}

test('a supported zero-delay policy remains immediately claimable after exponent overflow', async () => {
  const store = createMemoryStore({ now: () => 100 });
  const queue = createWorkOnce({ store, scope: 'zero-delay' }).define('job', {
    limits: { maxAttempts: 2000 },
    retry: exponentialBackoff({ initialDelayMs: 0, maxDelayMs: 100, maxRetries: 2000 }),
  });
  const seeded = await queue.ensure(null, { key: 'job' });
  await store.atomic(seeded.id, (row, now) => {
    assert.ok(row);
    return {
      next: { ...row, retries: 1024, revision: row.revision + 1, updatedAt: now },
      value: null,
    };
  });
  const [run] = await queue.claim({ workerId: 'worker' });
  assert.ok(run, 'overflow-boundary retry unexpectedly delayed');
  const phase = await run.settle(run.retry('pending'));
  assert.equal(phase.state, 'waiting');
  assert.equal(phase.availableAt, 100);
  const snapshot = await queue.inspect('job');
  assert.equal(snapshot?.retries, 1025);
  assert.equal((await queue.claim({ workerId: 'worker' })).length, 1);
});
