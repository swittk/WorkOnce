# One store, shared by every work kind

Applications supply storage once. The kernel owns the work records, retry/defer decisions,
claim fences, terminal results and follow-up intents. Features do not store second copies of
those fields in domain rows. Domain status, identity, authorization and external-effect safety
remain application responsibilities.

## Native compare-and-swap port

`createCompareExchangeStore` takes three operations:

```ts
interface CompareExchangePort {
  getMany(ids: readonly string[]): Promise<{
    rows: (WorkRecord | undefined)[];
    now: number;
  }>;
  query(query: WorkQuery): Promise<{ rows: WorkRecord[]; now: number }>;
  compareExchange(change: CompareExchange): Promise<boolean>;
}
```

`getMany` returns detached rows in the caller's order, with a trusted storage-clock observation
even when no records exist. It preserves exactly one slot per requested id, including duplicates.
**Never attach a newer clock to an older row read.** If the adapter awaits a database query, sample
its clock before the potentially stale read begins, not after it completes. Otherwise, a heartbeat
may commit while the old read is in flight; attaching the later clock to the old lease makes a
legitimate settlement fail `lease_expired` before its authoritative atomic recheck.

A batch does **not** require cross-id transactional snapshot isolation: different ids may reflect
different concurrent revisions, and some rows may be newer than the common observation clock.
That clock is deliberately conservative. All clocks used for `getMany`, claim/heartbeat deadlines
and atomic writes must share a trusted time authority, including across backend replicas.
A framework-generated `createdAt` or `updatedAt` is not automatically database time or the
actual commit instant. Timestamping an operation lock before saving a result is not a substitute
for a deadline check at the result's commit.

`query` applies scope, kind, definition, due time, cursor and limit in storage. The
`afterId` cursor applies only to `all` and `outbox`; `due` and `expired` order by
their time deadline and id and reject `afterId`. Candidate discovery is not ownership. The
later compare-and-swap must recheck the exact version.

`compareExchange` receives the stable id, expected revision (absent means insert-if-absent),
complete next record and optional exclusive `validUntil`. It must atomically require both the
revision and `storageNow < validUntil`. The time guard belongs **in the write**, not merely in a
preceding read. That prevents a delayed heartbeat/completion from committing after lease expiry,
even when no second worker has reclaimed the record yet.

Return `true` only after a durable write. Return `false` only when storage proves the comparison
did not apply. Throw on network/commit ambiguity. The builder retries ordinary contention, but
never assumes that an unknown acknowledgement means nothing happened. Claim loss recovers by
lease expiry; identical accepted settlement redelivery returns its saved receipt.

Native database drivers belong to the application's adapter. There is no Parse/ORM wrapper or
implicit process-local-lock fallback in this package. Multi-process guarantees must be tested
against that actual native store, not inferred from the memory reference.

## Full atomic interface

Advanced adapters may implement `WorkStore.atomic(id, decide)` directly. The decision is a
synchronous deterministic function of `(row, now)` only. It must not read clocks, use random
values, perform IO, mutate captured state or await application callbacks. CAS adapters can
re-evaluate it after contention. `next` and the returned value must remain detached from storage.

When `next` is supplied, the store commits that row durably before resolving. A decision with
`delete: true` physically removes the eligible observed item and is mutually exclusive with `next`.
A decision with neither performs no write. Only stores advertising `retention: true` may accept
finite retention or deletion; other adapters must reject rather than silently ignore deletion. `validUntil`, when supplied, must
hold at its write linearization point. If expiry occurs between read and write, the operation
must reject/re-evaluate instead of accepting stale authority. SQLite enforces the condition in
its prepared write statement. The reference store rechecks before updating its map.

IDs are unambiguous ASCII-escaped tuples of scope/kind/key. Preserve their bytewise ordering in
cursor queries. Never delete/reuse an id outside the opt-in retention contract: finite records
carry a creation incarnation so stale attempts cannot match a new record whose counters repeat.
A claim advances the fence across manual-retry generations within that incarnation. Counters and times must round-trip
as exact safe integers; requests whose timing arithmetic already overflows are rejected before
insertion.

## Persisted lease authority modes

Each work request may carry `leaseMode`, set from its work definition:

| Policy                      | Deadline after which a worker can be reclaimed | Owner's late commit                                                              |
| --------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| Omitted / `commit-deadline` | `leaseUntil`                                   | Forbidden, even if nobody has reclaimed the item                                 |
| `takeover-fenced`           | `leaseUntil`                                   | Allowed only if the same generation/incarnation/fence still owns the running row |

The policy is durable and immutable for a work ID. Changing it is a conflicting request,
not a live rewrite or migration of existing authority. All backend replicas must use
the same definition and the same real atomically serialized store. TypeScript alone does
not prove that a user's database adapter implements cross-process atomicity.

**Takeover-fenced** changes only the accepted owner check and the presence of
`validUntil` in heartbeat/settlement writes. Reclaim itself remains time-gated, and
competes in the same storage-atomic work-ID ordering as settlement. Once reclaim or
cancel commits, an old generation/fence cannot settle. A renewal can cross an expired
lease when its owner still wins, but cannot extend the generation beyond `maxElapsedMs`.
A still-current completion may nevertheless win after that budget; the elapsed limit
bounds scheduler/recovery decisions, not retroactive invalidation of an owned result.

This permits well-defined _state safety_ without exact network-wide wall-clock
agreement. It is not a strict time-expiry guarantee, a proof that an old physical worker
has stopped, or a guarantee that multiple workers cannot perform duplicate external
side effects. Cooperative workers use their persisted mode to decide whether a local
deadline itself causes abort; actual rejected heartbeats still abort both modes.

**Strict commit-deadline mode** remains the default and requires `validUntil` to be
checked by storage at the write linearization point. Adapters that cannot implement
that predicate must not advertise strict conformance merely because they timestamp
an operation before sending it. The takeover-fenced alternative does not weaken
the strict mode or add storage round trips to either mode.

## Clocks and side effects

Use a trusted clock associated with storage. The kernel prevents one record's update time from
moving backward, but cannot repair arbitrary clock skew between unrelated authorities. Equality
with lease expiry means expired. A stored lease is not evidence that the physical handler has
stopped; cancellation/expiry cannot unsend an external HTTP request.

**Two different clock boundaries matter:**

1. The read observation used for a preliminary ownership check must not combine an older row
   with a later clock. A read overlapping a renewal may be stale; the atomic write rechecks the
   current row and can accept that renewed attempt.
2. `validUntil` must hold at the native write's **actual linearization point**, not merely
   when the application acquired an operation lock or initiated an HTTP request. Comparing an
   `updatedAt` returned by a save can detect a late commit after it happens but cannot undo
   it. A clock stamped before a delayed save proves only when the request began.

These are storage contract requirements, not automatic properties of arbitrary ORMs or remote
stores. If the backing API cannot enforce a native revision-and-time conditional write,
document the weaker deadline guarantee. Extra speculative reads or an earlier lock timestamp
cannot manufacture that guarantee.

Cooperative external systems need their own idempotency keys or fencing. Queuing and unrelated
application writes are not automatically a transaction. There is intentionally no
`settle(ref, async () => writeDomainRows())` API claiming that an earlier lease check protects
later writes. Use real shared transactions, durable outbox intent, or explicit idempotent recovery.

If successful work already proves the external operation happened, read that result rather than
maintaining another mutable copy of the same terminal status in a domain object.

## Conformance

Run the shared **26-case** suite unchanged against a fresh test database for each case:

```ts
import { runConformance } from '@workonce/core/conformance';
await runConformance(async () => {
  const store = await createTestStore();
  return {
    store,
    advance: (ms) => advanceTrustedTestClock(ms),
    close: async () => {
      store.close?.();
      await removeOnlyThisTestDatabase();
    },
  };
});
```

The suite covers strict deadline fencing, late takeover-fenced renewal/settlement and
atomic reclaim/settle races, receipt replay after a
**simulated** lost acknowledgement, scope/kind/definition filtering before bounded discovery,
cursor behavior, detached reads and physical retirement (where supported). Stores without
`retention: true` must explicitly reject finite-retention work.

**The actual read/clock race needs a deliberately paused storage read.** Run the additional
`runReadClockConformance` probe with a fixture that interrupts one underlying
`getMany` query _after fetching its old row but before the adapter finishes returning it_:

```ts
import { runReadClockConformance } from '@workonce/core/conformance';

// An instrumented test store, NOT production latency or random sleeps.
await runReadClockConformance(async () => {
  const fixture = await createInstrumentedTestStore();
  return {
    store: fixture.store,
    advance: fixture.advanceTrustedClock,
    // Gate the actual storage-read boundary, not a wrapper after getMany returned.
    pauseGetManyAfterSnapshot: fixture.pauseNextStoredRowRead,
    close: fixture.close,
  };
});
```

The probe starts settlement reading an old lease, holds that row read, renews the same attempt
via a second handle, advances the test clock past the _old_ lease but not the _renewed_ lease,
then resumes settlement. The conformant adapter accepts it after its atomic recheck.
An adapter that uses a post-read clock prematurely rejects it. Package tests exercise both
a passing reference and a deliberately broken clock-ordering witness.

These are in-process behavioral tests. Also run separate-process competition, worker death/restart,
native deadline checks, retirement interruption, and unknown **native** acknowledgement injection
against the actual deployment. The simulated lost acknowledgement in the standard suite cannot
prove an adapter handles a database connection dropping in the middle of a commit. Neither suite
assumes all storage backends provide native database-time predicates.

## Performance and lifecycle

Claiming uses bounded indexed discovery followed by per-item native atomic writes. The current
facade does not claim every provider supports one bulk statement. `inspectMany` batches reads.
SQLite caches prepared query shapes and uses a short write transaction; SQLite itself serializes
writers per database file. Other adapters may allow per-row parallel writes.

Heartbeats do not append history. SQLite currently rewrites the compact JSON row, so payloads
should be references/small records, not file bodies. History is bounded to **the latest 128 diagnostic transitions**.
This is not a complete business retry ledger: do not reconstruct attempt budgets, first-failure
timestamps, application approval, or evidence that a particular old report settled from
`history()` once more than 128 events are possible. Use persisted `attempts`,
`retries`, `deferrals`, generation/fence and receipts for execution authority, and
application-owned durable evidence for business-specific time windows.
The dispatcher retains failed intents, attempts healthy siblings and advances a fairness cursor;
its cursor is an optimization, not durable authority.

Backups and restore must include the native work store, not only application ORM classes. A
separate work database needs its own coordinated backup/restore and worker fence. This kernel
does not silently add tables to an application's portable backup format or pretend domain
reconciliation can recover every lost receipt or retry budget.

The optional `/sqlite` adapter requires Node >= 22.16. Passing a path lazily opens `node:sqlite`; passing a compatible synchronous SQLite handle reuses that connection without loading `node:sqlite`. WorkOnce creates only its own `workonce` table/indexes in that database. Caller-supplied handles remain caller-owned unless `closeDatabase: true` is requested; the default/browser graph does not import the SQLite adapter.

SQLite adds a nullable `expires_at` projection to the exact published 0.3.0 table shape without
rewriting saved bodies; existing permanent items remain permanent. Superseded development layouts
are not adopted or converted. Opening a database never deletes its existing contents.

## Retention-capable storage

`select: 'expired'` discovers only finite terminal records with no pending outbox, ordered by
`(expiresAt, id)` and bounded by `limit`. Like due discovery, it rejects `afterId`. Apply scope,
optional kind and definition filters before the limit. `expiresAt(row)` from the kernel supplies
the shared index projection. Native stores must index expiry; do not load the entire job history
for each maintenance pass.

`prune()` rechecks the discovered incarnation, revision and deadline inside each atomic operation.
A competing retry, outbox change, delete/recreate or clock rollback therefore prevents the stale
candidate from deleting different work. The full atomic adapter must actually delete, not retain a
permanent tombstone. For CAS, `CompareDelete` / `deleteExchange` enforce the exact observed revision,
creation incarnation and minimum expiry time at the native write; ordinary CAS replacements on a
retention-capable port also compare incarnation (including exact absence). This prevents the ABA
problem where a newly created row has the same numeric revision as a deleted row.

An adapter retaining its own control/version records is responsible for retiring those too, fencing
delayed writers and recovering interrupted cleanup. Advertising support while retaining one control
record per deleted key does not provide bounded storage. See [retention](retention.md).
