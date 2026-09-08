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

`getMany` returns detached rows in the caller's order, with the trusted storage clock even when
no records exist. `query` applies scope, kind, definition, due time, cursor and limit in storage.
Candidate discovery is not ownership. The later compare-and-swap must recheck the exact version.

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

When `next` is supplied, the store commits that row durably before resolving. A decision with no
`next` performs no write. `validUntil`, when supplied, must
hold at its write linearization point. If expiry occurs between read and write, the operation
must reject/re-evaluate instead of accepting stale authority. SQLite enforces the condition in
its prepared write statement. The reference store rechecks before updating its map.

IDs are unambiguous ASCII-escaped tuples of scope/kind/key. Preserve their bytewise ordering in
cursor queries. Do not delete or reuse an id while an old attempt/receipt may remain in flight.
A claim advances the fence across manual-retry generations. Counters and times must round-trip
as exact safe integers; requests whose timing arithmetic already overflows are rejected before
insertion.

## Clocks and side effects

Use a trusted clock associated with storage. The kernel prevents one record's update time from
moving backward, but cannot repair arbitrary clock skew between unrelated authorities. Equality
with lease expiry means expired. A stored lease is not evidence that the physical handler has
stopped; cancellation/expiry cannot unsend an external HTTP request.

Cooperative external systems need their own idempotency keys or fencing. Queuing and unrelated
application writes are not automatically a transaction. There is intentionally no
`settle(ref, async () => writeDomainRows())` API claiming that an earlier lease check protects
later writes. Use real shared transactions, durable outbox intent, or explicit idempotent recovery.

If successful work already proves the external operation happened, read that result rather than
maintaining another mutable copy of the same terminal status in a domain object.

## Conformance

Run the shared suite unchanged against a fresh test database:

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

Also run separate-process competition, worker death/restart, native deadline checks and unknown
acknowledgement injection for the actual deployment. Promise races inside one process are not
sufficient evidence for a multi-backend claim.

## Performance and lifecycle

Claiming uses bounded indexed discovery followed by per-item native atomic writes. The current
facade does not claim every provider supports one bulk statement. `inspectMany` batches reads.
SQLite caches prepared query shapes and uses a short write transaction; SQLite itself serializes
writers per database file. Other adapters may allow per-row parallel writes.

Heartbeats do not append history. SQLite currently rewrites the compact JSON row, so payloads
should be references/small records, not file bodies. History is bounded to 128 transitions.
The dispatcher retains failed intents, attempts healthy siblings and advances a fairness cursor;
its cursor is an optimization, not durable authority.

Backups and restore must include the native work store, not only application ORM classes. A
separate work database needs its own coordinated backup/restore and worker fence. This kernel
does not silently add tables to an application's portable backup format or pretend domain
reconciliation can recover every lost receipt or retry budget.

The optional `/sqlite` adapter uses `node:sqlite` and requires Node >= 22.16; the default/browser graph does not import it.

SQLite initializes one current schema. WorkOnce is unreleased and supplies no upgrade or conversion
path for superseded development schemas. An incompatible table is rejected; opening a database
never deletes its contents or silently converts an old layout.
