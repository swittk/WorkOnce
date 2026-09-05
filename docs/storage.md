# Storage contract

`WorkStore.atomic(id, decide)` is the correctness boundary. The store loads one detached row,
reads its trusted clock, evaluates a **synchronous, side-effect-free** decision, commits the
returned `next` row, and only then resolves its returned value. It must serialize this operation
against every other writer of that item in the declared deployment.

A database transaction, atomic CAS loop, or equivalent provider primitive can implement this.
A CAS adapter may evaluate the decision again after contention. It must re-read the clock too.
Do not invoke retry policy or domain side effects inside a retried storage decision. Never call
an async decision and pretend that the promise is covered by an earlier compare.

The insert-if-missing case participates in the same boundary. Scope, kind and key are encoded
unambiguously as a work identity. Do not remove/reuse an identity while older attempts might
exist. Every committed claim advances its fence across manual retry generations.

`getMany` preserves input order and missing entries. `query` provides bounded due, outbox and
all-item views. Candidate discovery does not itself grant ownership: `atomic` must still check
fresh eligibility. Duplicate/racing candidate reads are fine; unconditional saves are not.

Adapters return detached JSON data. Numeric timestamps/counters must round-trip exactly;
functions, Dates and arbitrary class instances are not work payloads. Results returned by
`atomic` in the supplied adapters are detached JSON values as well. Use `null`, not `undefined`,
for an empty returned value.

## Clock and durability

Use one trusted clock associated with the storage authority. The kernel clamps a given item's
clock to its last stored update time, but does not solve arbitrary clock skew between independent
servers. Lease equality means expired. Expiration is checked **inside** the atomic operation.

SQLite obtains time from SQL while holding the write transaction. The clock override is for
conformance tests. SQLite uses WAL, FULL synchronous commits and a busy timeout. Its local-file
adapter supports independent processes sharing that local file, not separate files in isolated
containers or an assumed-safe network filesystem.

A claimed lease is not a promise that only one physical handler is alive. An old handler can
still execute after a timeout; it simply cannot commit queue state with its old fence. Cooperative
external systems need their own idempotency keys or fencing. Queuing and unrelated application
DB writes are not automatically one transaction.

## Embedded application rows

`createEmbeddedStore(port)` reduces glue when an existing row already has durable work intent.
Its `commit(row, next)` can persist work state and a small application projection in the same
row. The port's `exclusive` operation must cover load through commit and every competing
application writer. A transient network lease around an unconditional save is not sufficient.

A port supplied with a process-local mutex has a **single-backend-process** deployment contract.
It can serve parallel external workers but must not be labeled a multi-backend adapter.
An application with multiple API replicas must provide a real shared conditional transaction
or equivalent protected write before claiming that stronger guarantee.

## Conformance

```ts
import { runConformance } from '@workonce/core/conformance';

await runConformance(async () => {
  const fixture = await createEmptyTestDatabase();
  return {
    store: fixture.store,
    advance: (ms) => fixture.advanceStorageClock(ms),
    close: () => fixture.destroyOnlyTestData(),
  };
});
```

Run the suite unchanged. Then add separate OS-process, lost-ACK, crash/restart and durability tests
for your real deployment. In-memory `Promise.all` tests alone do not certify cross-process writes.
If the provider cannot supply the contract, do not hide a weaker implementation behind the same
adapter name.

## Performance boundaries

The facade currently performs a bounded candidate query followed by per-item atomic claims.
It does not pretend every provider supports a single bulk claim statement. `inspectMany` batches
the caller's read; SQLite implements that within a read transaction using a prepared statement.

No global library mutex or network service exists. SQLite itself has one writer per database
file. Other adapters may use per-row concurrency. Heartbeats do not append history events, but
the reference SQLite adapter currently rewrites the compact JSON work row; use small payloads
and understand this cost before applying it to high-rate, very large payloads.

The retained transition history is the last 128 transitions, not an unlimited audit ledger.
A benchmark is a measurement of that adapter and hardware, not a promise of application speedup.
