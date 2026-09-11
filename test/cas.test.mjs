import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompareExchangeStore } from '../dist/cas.js';
import { createMemoryStore } from '../dist/memory.js';
import { createWorkOnce, succeed } from '../dist/index.js';
import { runConformance } from '../dist/conformance.js';

function fixture() {
  let now = 100_000;
  const native = createMemoryStore({ now: () => now });
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
  return {
    store: createCompareExchangeStore(port),
    port,
    advance(ms) {
      now += ms;
    },
  };
}

test('one CAS port runs all shared conformance scenarios unchanged', async () => {
  assert.equal((await runConformance(fixture)).length, 19);
});
test('expiry BETWEEN read and native write rejects stale settlement without another worker', async () => {
  const f = fixture();
  let delay = false;
  const port = {
    ...f.port,
    async compareExchange(change) {
      if (delay) {
        delay = false;
        f.advance(11);
      }
      return f.port.compareExchange(change);
    },
  };
  const q = createWorkOnce({ store: createCompareExchangeStore(port), scope: 't' }).define('work', {
    limits: { leaseMs: 10 },
  });
  await q.enqueue(null, { key: 'job' });
  const [run] = await q.claim({ workerId: 'A' });
  delay = true;
  await assert.rejects(run.settle(run.succeed()), (error) => error.code === 'lease_expired');
  const [newRun] = await q.claim({ workerId: 'B' });
  assert.ok(newRun.ref.fence > run.ref.fence);
});
test('an unknown CAS acknowledgement does not blindly reapply a transition', async () => {
  const f = fixture();
  let lose = false;
  const port = {
    ...f.port,
    async compareExchange(change) {
      const result = await f.port.compareExchange(change);
      if (lose) {
        lose = false;
        throw new Error('ack lost');
      }
      return result;
    },
  };
  const q = createWorkOnce({ store: createCompareExchangeStore(port), scope: 't' }).define('work');
  await q.enqueue(null, { key: 'job' });
  const [run] = await q.claim({ workerId: 'A' });
  lose = true;
  await assert.rejects(run.settle(run.succeed()), /ack lost/);
  assert.equal((await run.settle(run.succeed())).state, 'succeeded');
});
test('limit callbacks and async retry/defer callbacks vary per input and reported reason', async () => {
  const f = fixture();
  const calls = [];
  const q = createWorkOnce({ store: f.store, scope: 't' }).define('work', {
    limits: (input) => ({ leaseMs: input.urgent ? 100 : 1000 }),
    retry: async (context) => {
      calls.push(['retry', context.input.urgent, context.reason]);
      return {
        retry: context.reason !== 'invalid',
        afterMs: context.input.urgent ? 2 : 20,
        maxRetries: 2,
        manualRetry: false,
      };
    },
    defer: async (context) => {
      calls.push(['defer', context.deferrals]);
      return { afterMs: context.input.urgent ? 3 : 30 };
    },
  });
  await q.enqueue({ urgent: true }, { key: 'a' });
  await q.enqueue({ urgent: false }, { key: 'b' });
  const [a, b] = await q.claim({ workerId: 'w', limit: 2 });
  assert.equal(a.attempt.leaseUntil - a.observedAt, 100);
  assert.equal(b.attempt.leaseUntil - b.observedAt, 1000);
  const waiting = await a.settle(a.defer('pending'));
  assert.equal(waiting.availableAt - a.observedAt, 3);
  await a.settle(a.defer('pending'));
  assert.equal(calls.length, 1, 'duplicate callback must not run policy twice');
  const failed = await b.settle(b.retry('invalid', { afterMs: 0 }));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.manualRetry, false);
});
test('a deferred policy callback cannot publish after its lease was reclaimed', async () => {
  const f = fixture();
  let release, entered;
  const started = new Promise((r) => (entered = r));
  const gate = new Promise((r) => (release = r));
  const q = createWorkOnce({ store: f.store, scope: 't' }).define('work', {
    limits: { leaseMs: 10 },
    defer: async () => {
      entered();
      await gate;
      return { afterMs: 1 };
    },
  });
  await q.enqueue(null, { key: 'job' });
  const [a] = await q.claim({ workerId: 'A' });
  const report = a.settle(a.defer('pending'));
  await started;
  f.advance(10);
  const [b] = await q.claim({ workerId: 'B' });
  release();
  await assert.rejects(report, (e) => e.code === 'stale_attempt');
  await b.settle(b.succeed());
});
test('undefined results fail instead of silently changing into null', () => {
  assert.equal(succeed().result, null);
  assert.throws(() => succeed(undefined));
});
