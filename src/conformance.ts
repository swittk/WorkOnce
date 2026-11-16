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
  await test('storage cursors are exclusive for all/outbox and rejected for due', async ({
    store,
  }) => {
    const scope = 'cursor-contract';
    const work = createWorkOnce({ store, scope });
    const parent = work.define('parent');
    const child = work.define('child');
    const snapshots = [];
    for (const key of ['delta', 'alpha', 'charlie', 'bravo'])
      snapshots.push(await parent.ensure(null, { key }));
    const expected = snapshots.map((snapshot) => snapshot.id).sort();
    const firstId = expected[0]!;
    await assert.rejects(
      store.query({ scope, kind: 'parent', select: 'due', limit: 1, afterId: firstId }),
      () => true,
      'due queries must reject the id-only afterId cursor',
    );

    async function assertExclusivePages(select: 'all' | 'outbox') {
      const actual: string[] = [];
      let afterId: string | undefined;
      let terminated = false;
      for (let page = 0; page <= expected.length; page++) {
        const result = await store.query({
          scope,
          kind: 'parent',
          select,
          limit: 2,
          ...(afterId === undefined ? {} : { afterId }),
        });
        assert.ok(result.rows.length <= 2, `${select} cursor page exceeded its limit`);
        if (result.rows.length === 0) {
          terminated = true;
          break;
        }
        actual.push(...result.rows.map((row) => row.id));
        afterId = result.rows.at(-1)!.id;
      }
      assert.equal(terminated, true, `${select} cursor pagination did not terminate`);
      assert.deepEqual(actual, expected, `${select} afterId must be exclusive and ordered`);
    }

    await assertExclusivePages('all');
    const runs = await parent.claim({ workerId: 'cursor-owner', limit: expected.length });
    assert.equal(runs.length, expected.length);
    for (let index = 0; index < runs.length; index++)
      await runs[index]!.settle(
        runs[index]!.succeed(null, { next: [child.request(null, { key: `next-${index}` })] }),
      );
    await assertExclusivePages('outbox');
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
      () => true,
      'skipped revision must be rejected by the store contract',
    );
    await assert.rejects(
      store.atomic(snapshot.id, (row) => ({
        next: { ...row!, revision: row!.revision + 1 },
        validUntil: Number.NaN,
        value: null,
      })),
    );
    await assert.rejects(
      store.atomic(snapshot.id, (row, clock) => ({
        next: { ...row!, revision: row!.revision + 1 },
        validUntil: clock,
        value: null,
      })),
      () => true,
      'validUntil equal to the storage clock must reject',
    );
    assert.equal(canonical((await store.getMany([snapshot.id])).rows), before);
    const accepted = await store.atomic(snapshot.id, (row, clock) => ({
      next: { ...row!, revision: row!.revision + 1 },
      validUntil: clock + 60_000,
      value: 'accepted-before-deadline',
    }));
    assert.equal(accepted, 'accepted-before-deadline');
  });
  await test('concurrent heartbeats retain one owner and both committed renewals', async ({
    store,
    advance,
  }) => {
    const first = createWorkOnce({ store, scope: 'heartbeat-race' }).define('task', {
      limits: { leaseMs: 40 },
    });
    const second = createWorkOnce({ store, scope: 'heartbeat-race' }).define('task', {
      limits: { leaseMs: 40 },
    });
    await first.ensure(null, { key: 'one' });
    const [run] = await first.claim({ workerId: 'owner' });
    assert.ok(run);
    const before = (await first.inspect('one'))!;
    advance(10);
    const renewals = await Promise.all([first.heartbeat(run.ref), second.heartbeat(run.ref)]);
    assert.equal(renewals[0]!.attempt.fence, run.ref.fence);
    assert.equal(renewals[1]!.attempt.fence, run.ref.fence);
    assert.equal(renewals[0]!.attempt.leaseUntil, renewals[1]!.attempt.leaseUntil);
    const after = (await first.inspect('one'))!;
    assert.equal(after.revision, before.revision + 2, 'both independent renewals must commit');
    assert.equal(after.attempts, 1, 'renewals cannot manufacture new claims');
    assert.equal(
      (await first.history('one')).filter((event) => event.action === 'renew').length,
      0,
    );
    await run.settle(run.succeed());
  });

  await test('scope, kind and definition are filtered before bounded due discovery', async ({
    store,
    advance,
  }) => {
    const clock = (await store.getMany([])).now;
    const scope = 'filtered-discovery';
    const current = createWorkOnce({ store, scope });
    const old = current.define('task', { version: 'old' });
    const fresh = current.define('task', { version: 'new' });
    const unrelatedKind = current.define('other');
    const unrelatedScope = createWorkOnce({ store, scope: 'another-scope' }).define('task', {
      version: 'new',
    });
    await old.ensure(null, { key: 'older-version', availableAt: clock });
    await unrelatedKind.ensure(null, { key: 'other-kind', availableAt: clock });
    await unrelatedScope.ensure(null, { key: 'other-scope', availableAt: clock });
    const earliest = await fresh.ensure(null, { key: 'first', availableAt: clock });
    const later = await fresh.ensure(null, { key: 'second', availableAt: clock + 3 });
    const query = {
      scope,
      kind: 'task',
      definition: 'new',
      select: 'due' as const,
      limit: 1,
    };
    assert.deepEqual(
      (await store.query(query)).rows.map((row) => row.id),
      [earliest.id],
      'wrong scope/kind/definition candidates must not consume the due limit',
    );
    advance(3);
    assert.deepEqual(
      (await store.query({ ...query, limit: 2 })).rows.map((row) => row.id),
      [earliest.id, later.id],
      'due discovery must sort by deadline before taking its limit',
    );
  });

  await test('retention capability, outbox protection and new incarnation agree', async ({
    store,
    advance,
  }) => {
    const work = createWorkOnce({ store, scope: 'retention-conformance' });
    const parent = work.define('parent', { retention: { afterTerminalMs: 5 } });
    const child = work.define('child');
    if (store.retention !== true) {
      await rejects(parent.ensure(null, { key: 'job' }), 'retention_unsupported');
      return;
    }
    const original = await parent.ensure(null, { key: 'job' });
    assert.ok(original.incarnation);
    const [run] = await parent.claim({ workerId: 'owner' });
    assert.ok(run);
    await run.settle(run.succeed(null, { thenDo: [child.request(null, { key: 'continuation' })] }));
    advance(5);
    assert.deepEqual(
      (await store.query({ scope: 'retention-conformance', select: 'expired', limit: 1 })).rows,
      [],
      'terminal parents with undispatched follow-ups are not expired candidates',
    );
    await assert.rejects(
      store.query({
        scope: 'retention-conformance',
        select: 'expired',
        limit: 1,
        afterId: original.id,
      }),
      () => true,
      'expired queries must reject an id-only cursor',
    );
    assert.equal(await parent.prune({ limit: 1 }), 0);
    assert.equal(await work.dispatch({ limit: 1 }), 1);
    assert.equal(await parent.prune({ limit: 1 }), 1);
    assert.equal((await store.getMany([original.id])).rows[0], undefined);
    const recreated = await parent.ensure(null, { key: 'job' });
    assert.ok(recreated.incarnation && recreated.incarnation !== original.incarnation);
    assert.equal(recreated.revision, 1);
    await rejects(run.settle(run.succeed()), 'stale_attempt');
    assert.equal((await child.inspect('continuation'))!.phase.state, 'queued');
  });

  await test('lost success acknowledgement replays the receipt without duplicating follow-ups', async ({
    store,
  }) => {
    const scope = 'unknown-ack-conformance';
    const work = createWorkOnce({ store, scope });
    const parent = work.define('parent');
    const child = work.define('child');
    await parent.ensure(null, { key: 'job' });
    const [run] = await parent.claim({ workerId: 'owner' });
    assert.ok(run);
    const outcome = run.succeed(null, {
      thenDo: [child.request(null, { key: 'apply-once' })],
    });
    let dropped = false;
    const ambiguous: WorkStore = {
      ...(store.retention === true ? { retention: true as const } : {}),
      getMany: (ids) => store.getMany(ids),
      query: (query) => store.query(query),
      async atomic(id, decide) {
        const receipt = await store.atomic(id, decide);
        if (id === run.ref.workId && !dropped) {
          const committed = (await store.getMany([id])).rows[0];
          if (committed?.phase.state === 'succeeded') {
            dropped = true;
            throw new Error('injected lost acknowledgement after durable commit');
          }
        }
        return receipt;
      },
    };
    const unreliable = createWorkOnce({ store: ambiguous, scope }).define('parent');
    await assert.rejects(
      unreliable.settle(run.ref, outcome),
      /injected lost acknowledgement after durable commit/u,
    );
    assert.equal(dropped, true);
    assert.equal((await parent.inspect('job'))!.pendingFollowups, 1);
    assert.equal(await child.inspect('apply-once'), undefined);
    assert.equal((await parent.settle(run.ref, outcome)).state, 'succeeded');
    assert.equal(await work.dispatch({ limit: 1 }), 1);
    assert.equal(await work.dispatch({ limit: 1 }), 0);
    assert.equal((await parent.inspect('job'))!.pendingFollowups, 0);
    assert.equal((await child.inspect('apply-once'))!.phase.state, 'queued');
  });

  await test('takeover-fenced expiry permits renewal and settlement until ownership changes', async ({
    store,
    advance,
  }) => {
    const root = createWorkOnce({ store, scope: 'takeover-late' });
    const q = root.define('job', {
      leaseMode: 'takeover-fenced',
      limits: { leaseMs: 10, maxElapsedMs: 100 },
    });
    const strict = root.define('job');
    const original = await q.ensure(null, { key: 'one' });
    assert.equal(original.leaseMode, 'takeover-fenced');
    await rejects(strict.inspect('one'), 'definition_changed');
    await rejects(strict.ensure(null, { key: 'one' }), 'key_conflict');

    const [run] = await q.claim({ workerId: 'original' });
    assert.ok(run);
    const firstExpiry = run.attempt.leaseUntil;
    advance(10);
    const renewal = await q.heartbeat(run.ref);
    assert.ok(renewal.attempt.leaseUntil > firstExpiry, 'expired but unreclaimed owner may renew');
    advance(10);
    const outcome = run.succeed();
    assert.equal((await run.settle(outcome)).state, 'succeeded');
    assert.equal((await q.inspect('one'))!.attempts, 1);
    assert.equal((await q.claim({ workerId: 'replacement' })).length, 0);
    advance(20);
    assert.equal((await run.settle(outcome)).state, 'succeeded', 'late replay uses the receipt');
  });

  await test('takeover-fenced reclamation irrevocably fences the old owner', async ({
    store,
    advance,
  }) => {
    const settings = { leaseMode: 'takeover-fenced' as const, limits: { leaseMs: 10 } };
    const a = createWorkOnce({ store, scope: 'takeover-fence' }).define('job', settings);
    const b = createWorkOnce({ store, scope: 'takeover-fence' }).define('job', settings);
    await a.ensure(null, { key: 'one' });
    const [old] = await a.claim({ workerId: 'A' });
    assert.ok(old);
    advance(10);
    const [current] = await b.claim({ workerId: 'B' });
    assert.ok(current);
    assert.ok(current.ref.fence > old.ref.fence);
    await rejects(old.heartbeat(), 'stale_attempt');
    await rejects(old.settle(old.succeed()), 'stale_attempt');
    assert.equal((await current.settle(current.succeed())).state, 'succeeded');
    assert.equal((await a.inspect('one'))!.attempts, 2);
  });

  await test('late takeover-fenced completion and reclaim have one atomic winner', async ({
    store,
    advance,
  }) => {
    const definition = { leaseMode: 'takeover-fenced' as const, limits: { leaseMs: 10 } };
    const first = createWorkOnce({ store, scope: 'takeover-race' }).define('job', definition);
    const second = createWorkOnce({ store, scope: 'takeover-race' }).define('job', definition);
    await first.ensure(null, { key: 'job' });
    const [old] = await first.claim({ workerId: 'A' });
    assert.ok(old);
    advance(10);
    const results = await Promise.allSettled([
      old.settle(old.succeed()),
      second.claim({ workerId: 'B' }),
    ]);
    const completion = results[0]!;
    const claim = results[1]!;
    assert.equal(claim.status, 'fulfilled');
    if (claim.status !== 'fulfilled') return;
    if (claim.value.length === 0) {
      assert.equal(completion.status, 'fulfilled');
      assert.equal((await first.inspect('job'))!.phase.state, 'succeeded');
    } else {
      assert.equal(claim.value.length, 1);
      assert.equal(completion.status, 'rejected');
      if (completion.status === 'rejected') {
        assert.ok(completion.reason instanceof WorkConflict);
        assert.equal(completion.reason.code, 'stale_attempt');
      }
      await claim.value[0]!.settle(claim.value[0]!.succeed());
    }
    assert.equal((await first.inspect('job'))!.phase.state, 'succeeded');
  });
  return completed;
}

/**
 * Adapter-specific probe for the subtle read-clock race: hold a storage read AFTER it
 * captured an old row, but BEFORE getMany has finished constructing { rows, now }.
 * Hook the real database/ORM read boundary, not a wrapper after getMany has returned.
 */
export interface ReadClockConformanceFixture extends ConformanceFixture {
  /** Install a one-shot stall on a read containing this work ID. */
  pauseGetManyAfterSnapshot(workId: string): {
    /** Resolves when the old storage snapshot has been captured and is being held. */
    entered: Promise<void>;
    /** Resume the read, permitting getMany to return its rows and observation clock. */
    release(): void;
  };
}

/** Factory that instruments a real getMany read boundary instead of simulating a stale result. */
export type ReadClockConformanceFactory = () =>
  | ReadClockConformanceFixture
  | Promise<ReadClockConformanceFixture>;

/**
 * Deterministically overlap a stale read with an accepted heartbeat. If an adapter samples
 * its observation clock AFTER the held read, the valid settlement will be falsely expired.
 * Run this in addition to runConformance against the actual backing-store implementation.
 */
export async function runReadClockConformance(create: ReadClockConformanceFactory): Promise<void> {
  const fixture = await create();
  try {
    const first = createWorkOnce({ store: fixture.store, scope: 'read-clock-conformance' }).define(
      'task',
      { limits: { leaseMs: 40 } },
    );
    const other = createWorkOnce({ store: fixture.store, scope: 'read-clock-conformance' }).define(
      'task',
      { limits: { leaseMs: 40 } },
    );
    await first.ensure(null, { key: 'job' });
    const [run] = await first.claim({ workerId: 'owner' });
    assert.ok(run);
    fixture.advance(20);
    const gate = fixture.pauseGetManyAfterSnapshot(run.ref.workId);
    const pending = first.settle(run.ref, run.succeed());
    // Attach a rejection handler immediately, even while the read is deliberately suspended.
    void pending.catch(() => undefined);
    try {
      await gate.entered;
      const renewed = await other.heartbeat(run.ref);
      assert.equal(renewed.attempt.leaseUntil - renewed.observedAt, 40);
      // The OLD row's lease has now expired, but the committed renewal has not.
      fixture.advance(25);
      gate.release();
      assert.equal(
        (await pending).state,
        'succeeded',
        'a stale pre-heartbeat read must not be paired with a post-heartbeat clock',
      );
    } finally {
      gate.release();
      await pending.catch(() => undefined);
    }
  } finally {
    await fixture.close?.();
  }
}
