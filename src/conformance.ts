import assert from 'node:assert/strict';
import { createWorkOnce } from './work.js';
import { WorkConflict, canonical } from './kernel.js';
import type { WorkStore } from './storage.js';
/** Use the same test clock in all independent handles to this test database. */
export interface ConformanceFixture {
  /** Fresh, empty adapter for this case. */
  store: WorkStore;
  /** Advance the storage clock, not just a worker-local fake Date. */
  advance(ms: number): void;
  /** Close connections and remove only test-owned data. */
  close?(): void | Promise<void>;
}
/** Adapter makers run this suite as-is; do not copy and weaken individual assertions. */
export type ConformanceFactory = () => ConformanceFixture | Promise<ConformanceFixture>;
const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error) => error instanceof WorkConflict && error.code === code);
/** Shared adversarial contract; real multi-process and crash tests supplement this suite. */
export async function runConformance(create: ConformanceFactory): Promise<string[]> {
  const completed: string[] = [];
  async function test(name: string, body: (f: ConformanceFixture) => Promise<void>) {
    const f = await create();
    try {
      await body(f);
      completed.push(name);
    } finally {
      await f.close?.();
    }
  }
  await test('ensure identity, alias isolation and ordered batch reads', async ({ store }) => {
    const q = createWorkOnce({ store, scope: 'tenant' }).define<{ a: number }>('one');
    const input = { a: 1 };
    const first = await q.ensure(input, { key: 'same' });
    input.a = 99;
    const again = await q.ensure({ a: 1 }, { key: 'same' });
    assert.deepEqual(first, again);
    await rejects(q.ensure({ a: 2 }, { key: 'same' }), 'key_conflict');
    const batch = await q.inspectMany(['missing', 'same', 'same']);
    assert.equal(batch.length, 3, 'getMany must preserve requested slots including duplicate ids');
    assert.equal(batch[0], undefined);
    assert.equal(batch[1]!.input.a, 1);
    assert.equal(batch[2]!.input.a, 1);
    batch[1]!.input.a = 9;
    assert.equal(batch[2]!.input.a, 1);
    assert.equal((await q.inspect('same'))!.input.a, 1);
  });
  await test('50 competing claimers produce one current owner', async ({ store }) => {
    const q = createWorkOnce({ store, scope: 't' }).define('one');
    await q.ensure(null, { key: 'job' });
    const claims = await Promise.all(
      Array.from({ length: 50 }, (_, i) => q.claim({ workerId: String(i) })),
    );
    assert.equal(claims.flat().length, 1);
    assert.equal((await q.inspect('job'))!.attempts, 1);
  });
  await test('lease expiry fences every late mutation, including renew', async ({
    store,
    advance,
  }) => {
    const q = createWorkOnce({ store, scope: 't' }).define('one', { limits: { leaseMs: 10 } });
    await q.ensure(null, { key: 'job' });
    const [a] = await q.claim({ workerId: 'A' });
    advance(10);
    await rejects(a!.renew(), 'lease_expired');
    const [b] = await q.claim({ workerId: 'B' });
    assert.ok(b!.ref.fence > a!.ref.fence);
    await rejects(a!.renew(), 'stale_attempt');
    for (const out of [
      a!.succeed(),
      a!.retry('busy'),
      a!.defer('wait', { afterMs: 1 }),
      a!.fail('bad'),
    ])
      await rejects(a!.settle(out), 'stale_attempt');
    await b!.settle(b!.succeed());
    assert.equal((await q.inspect('job'))!.phase.state, 'succeeded');
  });
  await test('retry delay, exact due boundary and failure budget', async ({ store, advance }) => {
    const q = createWorkOnce({ store, scope: 't' }).define('one', {
      retry: { retry: true, afterMs: 20, maxRetries: 1, manualRetry: true },
    });
    await q.ensure(null, { key: 'job' });
    const [a] = await q.claim({ workerId: 'A' });
    assert.equal((await a!.settle(a!.retry('busy'))).state, 'waiting');
    assert.equal((await q.claim({ workerId: 'B' })).length, 0);
    advance(19);
    assert.equal((await q.claim({ workerId: 'B' })).length, 0);
    advance(1);
    const [b] = await q.claim({ workerId: 'B' });
    const done = await b!.settle(b!.retry('busy'));
    assert.equal(done.state, 'failed');
    if (done.state === 'failed') assert.equal(done.reason, 'busy');
    assert.equal((await q.claim({ workerId: 'C' })).length, 0);
  });
  await test('deferral is distinct, bounded and releases worker capacity', async ({
    store,
    advance,
  }) => {
    const q = createWorkOnce({ store, scope: 't' }).define('one', { limits: { maxDeferrals: 1 } });
    await q.ensure(null, { key: 'job' });
    let [run] = await q.claim({ workerId: 'A' });
    await run!.settle(run!.defer('pending', { afterMs: 2 }));
    const snap = (await q.inspect('job'))!;
    assert.equal(snap.retries, 0);
    assert.equal(snap.deferrals, 1);
    assert.equal(snap.phase.state, 'waiting');
    advance(2);
    [run] = await q.claim({ workerId: 'B' });
    assert.equal((await run!.settle(run!.defer('pending', { afterMs: 2 }))).state, 'failed');
  });
  await test('manual retry gate and concurrent generation checks', async ({ store }) => {
    const q = createWorkOnce({ store, scope: 't' }).define('one');
    await q.ensure(null, { key: 'job' });
    const [a] = await q.claim({ workerId: 'A' });
    await a!.settle(a!.fail('bad', { manualRetry: true }));
    await rejects(q.retry({ key: 'job', generation: 1, check: () => false }), 'retry_denied');
    const races = await Promise.allSettled([
      q.retry({ key: 'job', generation: 1 }),
      q.retry({ key: 'job', generation: 1 }),
    ]);
    assert.equal(races.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal((await q.inspect('job'))!.generation, 2);
    await rejects(a!.settle(a!.fail('bad', { manualRetry: true })), 'stale_attempt');
    const [b] = await q.claim({ workerId: 'B' });
    assert.ok(b!.ref.fence > a!.ref.fence);
    await b!.settle(b!.fail('hard'));
    await rejects(q.retry({ key: 'job', generation: 2 }), 'retry_denied');
  });
  await test('dynamic policy varies by input and cannot outlive its attempt', async ({
    store,
    advance,
  }) => {
    let release!: () => void;
    const latch = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const q = createWorkOnce({ store, scope: 't' }).define<{ urgent: boolean }>('one', {
      limits: { leaseMs: 10 },
      retry: async ({ input }) => {
        entered();
        await latch;
        return { retry: true, afterMs: input.urgent ? 1 : 20, maxRetries: 2, manualRetry: true };
      },
    });
    await q.ensure({ urgent: true }, { key: 'job' });
    const [a] = await q.claim({ workerId: 'A' });
    const pending = a!.settle(a!.retry('busy'));
    await ready;
    advance(10);
    const [b] = await q.claim({ workerId: 'B' });
    release();
    await rejects(pending, 'stale_attempt');
    await b!.settle(b!.succeed());
  });
  await test('retry.never is not bypassed by per-result timing', async ({ store }) => {
    const q = createWorkOnce({ store, scope: 't' }).define('one', {
      retry: { retry: false, manualRetry: false },
    });
    await q.ensure(null, { key: 'job' });
    const [run] = await q.claim({ workerId: 'A' });
    const phase = await run!.settle(run!.retry('forbidden', { afterMs: 0 }));
    assert.equal(phase.state, 'failed');
    if (phase.state === 'failed') assert.equal(phase.manualRetry, false);
  });
  await test('identical report replay does not rerun policy, conflicting report is rejected', async ({
    store,
  }) => {
    let calls = 0;
    const q = createWorkOnce({ store, scope: 't' }).define('one', {
      retry: () => {
        calls++;
        return { retry: true, afterMs: 0, maxRetries: 2, manualRetry: true };
      },
    });
    await q.ensure(null, { key: 'job' });
    const [a] = await q.claim({ workerId: 'A' });
    const outcome = a!.retry('busy');
    const receipt = await a!.settle(outcome);
    const [b] = await q.claim({ workerId: 'B' });
    assert.deepEqual(await a!.settle(outcome), receipt);
    assert.equal(calls, 1);
    assert.equal((await q.inspect('job'))!.phase.state, 'running');
    await rejects(a!.settle(a!.fail('other')), 'settlement_conflict');
    await b!.settle(b!.succeed());
  });
  await test('cancel versus completion has one coherent result', async ({ store }) => {
    const q = createWorkOnce({ store, scope: 't' }).define('one');
    await q.ensure(null, { key: 'job' });
    const [a] = await q.claim({ workerId: 'A' });
    const raced = await Promise.allSettled([
      q.cancel({ key: 'job', generation: 1 }),
      a!.settle(a!.succeed()),
    ]);
    const phase = (await q.inspect('job'))!.phase;
    assert.ok(phase.state === 'cancelled' || phase.state === 'succeeded');
    const cancelled = raced[0]!;
    assert.equal(cancelled.status, 'fulfilled');
    if (cancelled.status === 'fulfilled') assert.deepEqual(cancelled.value.phase, phase);
    const completion = raced[1]!;
    if (phase.state === 'cancelled') {
      assert.equal(completion.status, 'rejected');
      if (completion.status === 'rejected') {
        assert.ok(completion.reason instanceof WorkConflict);
        assert.equal(completion.reason.code, 'stale_attempt');
      }
    } else {
      assert.equal(completion.status, 'fulfilled');
      if (completion.status === 'fulfilled') assert.deepEqual(completion.value, phase);
    }
    assert.equal((await q.claim({ workerId: 'B' })).length, 0);
  });
  await test('crashed workers cannot bypass the total claim budget', async ({ store, advance }) => {
    const q = createWorkOnce({ store, scope: 't' }).define('one', {
      limits: { leaseMs: 1, maxAttempts: 2 },
    });
    await q.ensure(null, { key: 'job' });
    await q.claim({ workerId: 'A' });
    advance(1);
    await q.claim({ workerId: 'B' });
    advance(1);
    assert.equal((await q.claim({ workerId: 'C' })).length, 0);
    assert.equal((await q.inspect('job'))!.phase.state, 'failed');
  });
  await test('lease renewal is capped by the per-generation deadline', async ({
    store,
    advance,
  }) => {
    const q = createWorkOnce({ store, scope: 't' }).define('one', {
      limits: { leaseMs: 10, maxElapsedMs: 15 },
    });
    await q.ensure(null, { key: 'job' });
    const [a] = await q.claim({ workerId: 'A' });
    advance(8);
    await a!.renew();
    advance(7);
    await rejects(a!.renew(), 'lease_expired');
    assert.equal((await q.claim({ workerId: 'B' })).length, 0);
    assert.equal((await q.inspect('job'))!.phase.state, 'failed');
  });
  await test('outbox intent survives success and dispatch races converge', async ({ store }) => {
    const work = createWorkOnce({ store, scope: 't' });
    const a = work.define('first');
    const b = work.define<{ value: number }>('second');
    await a.ensure(null, { key: 'job' });
    const [run] = await a.claim({ workerId: 'A' });
    const outcome = run!.succeed(null, {
      next: [b.request({ value: 1 }, { key: 'job-followup' })],
    });
    await run!.settle(outcome);
    assert.equal((await a.inspect('job'))!.pendingFollowups, 1);
    assert.equal(await b.inspect('job-followup'), undefined);
    await Promise.all([work.dispatch(), work.dispatch()]);
    assert.equal((await a.inspect('job'))!.pendingFollowups, 0);
    assert.equal((await b.claim({ workerId: 'B', limit: 10 })).length, 1);
    await run!.settle(outcome);
    assert.equal((await a.inspect('job'))!.pendingFollowups, 0);
  });
  await test('invalid follow-up never commits parent success', async ({ store }) => {
    const work = createWorkOnce({ store, scope: 't' });
    const a = work.define('one');
    await a.ensure(null, { key: 'job' });
    const [run] = await a.claim({ workerId: 'A' });
    await rejects(
      run!.settle(run!.succeed(null, { next: [a.request(null, { key: 'job' })] })),
      'key_conflict',
    );
    assert.equal((await a.inspect('job'))!.phase.state, 'running');
  });
  await test('wake is revision checked; no stale UI can shorten a later wait', async ({
    store,
  }) => {
    const q = createWorkOnce({ store, scope: 't' }).define('one');
    await q.ensure(null, { key: 'job' });
    const [a] = await q.claim({ workerId: 'A' });
    await a!.settle(a!.defer('wait', { afterMs: 1000 }));
    const snapshot = (await q.inspect('job'))!;
    await q.wake({ key: 'job', generation: snapshot.generation, revision: snapshot.revision });
    await rejects(
      q.wake({ key: 'job', generation: snapshot.generation, revision: snapshot.revision }),
      'generation_conflict',
    );
    assert.equal((await q.claim({ workerId: 'B' })).length, 1);
  });
  await test('scope and definition version fence wrong handlers', async ({ store }) => {
    const a = createWorkOnce({ store, scope: 'a' }).define('one', { version: '1' });
    const b = createWorkOnce({ store, scope: 'b' }).define('one');
    await a.ensure(null, { key: 'job' });
    assert.equal((await b.claim({ workerId: 'B' })).length, 0);
    const [run] = await a.claim({ workerId: 'A' });
    await rejects(b.renew(run!.ref), 'not_found');
    const newer = createWorkOnce({ store, scope: 'a' }).define('one', { version: '2' });
    await rejects(newer.renew(run!.ref), 'definition_changed');
    await rejects(newer.inspect('job'), 'definition_changed');
    await rejects(newer.inspectMany(['missing', 'job']), 'definition_changed');
    await rejects(newer.item(null, 'job').inspect(), 'definition_changed');
    await rejects(newer.inspectId(run!.ref.workId), 'definition_changed');
    await rejects(newer.history('job'), 'definition_changed');
  });
  await test('failed atomic decisions leave the stored row untouched', async ({ store }) => {
    const q = createWorkOnce({ store, scope: 't' }).define('one');
    const snapshot = await q.ensure(null, { key: 'job' });
    const before = canonical((await store.getMany([snapshot.id])).rows);
    await assert.rejects(
      store.atomic(snapshot.id, (row) => {
        row!.generation = 500;
        throw new Error('injected');
      }),
    );
    const after = await store.getMany([snapshot.id]);
    assert.equal(before, canonical(after.rows));
  });
  await test('stores reject skipped revisions and malformed write deadlines', async ({ store }) => {
    const q = createWorkOnce({ store, scope: 't' }).define('one');
    const snapshot = await q.ensure(null, { key: 'job' });
    const before = canonical((await store.getMany([snapshot.id])).rows);
    await assert.rejects(
      store.atomic(snapshot.id, (row) => ({
        next: { ...row!, revision: row!.revision },
        value: null,
      })),
    );
    await assert.rejects(
      store.atomic(snapshot.id, (row) => ({
        next: { ...row!, revision: row!.revision + 2 },
        value: null,
      })),
    );
    await assert.rejects(
      store.atomic(snapshot.id, (row) => ({
        next: { ...row!, revision: row!.revision + 1 },
        validUntil: Number.NaN,
        value: null,
      })),
    );
    assert.equal(canonical((await store.getMany([snapshot.id])).rows), before);
  });
  return completed;
}
