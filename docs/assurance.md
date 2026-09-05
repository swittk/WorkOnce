# What the checks establish

The suite is deliberately split by what it actually exercises.

## Shared adapter conformance

`src/conformance.ts` currently contains 17 scenarios. It tests competing claims, exact lease
expiry, every stale settlement kind, current-owner renewal, backoff timing, separate bounded
deferrals, manual retry gates/generations, async policy evaluation racing reclaim, non-retryable
reasons, identical/conflicting report replay, cancellation/completion races, crashed-attempt
budgets, elapsed deadlines, outbox delivery races, invalid follow-ups, wake revision checks,
scope/version boundaries and rollback of a failed store decision.

It runs against memory, actual SQLite and the generic embedded-row helper with an explicitly
serialized test port. The embedded test fixture is not a certification of an arbitrary host
application's mutex or database topology.

## Runtime and real-process checks

`test/worker.test.mjs` tests bounded parallel handlers, automatic renewal, free-slot refill,
neighbor failure isolation and abort after renewal failure.

`test/crash.test.mjs` injects lost acknowledgements after success and child insertion.
`test/dispatcher.test.mjs` tests the recoverable follow-up pump and bounded delivery passes.
`test/inspection.test.mjs` tests safe worker serialization and preserving application failure
reasons separately from budget exhaustion.

`test/process/sqlite-process.test.mjs` starts eight independent Node processes against one
SQLite file, races their claims, kills a claimed worker with SIGKILL, waits for its lease,
reopens storage, reclaims with a higher fence and rejects the old process's callback.

`npm run test:consumer` packs the real distribution, installs it into an isolated consumer,
executes ESM and CommonJS round trips and compiles both module styles against the packed types.

`test/types/api.ts` checks the developer-facing input/result/reason types, timing alternatives,
manual generation requirement and discriminated snapshots. `npm run check` compiles it.

## Bounded TLA model

`formal/WorkOnce.tla` models a single work item, worker tokens, claims, retries, expiry,
cancellation, manual generations and a durable outbox child. The checked configuration has
2 workers, 4 time ticks, 4 fences, 2 generations, 2 attempts and 1 automatic retry.

The initial run with TLC 2.19 explored 6,262 distinct states (10,546 generated, graph depth 15)
without an invariant violation. It checks bounded ownership/state/outbox safety. It does not
model SQL/Mongo internals, network storage durability, application writes, arbitrary retry
callbacks, or exactly-once external effects. It does not claim a machine-checked full refinement
proof from the TypeScript implementation to TLA. Runtime/conformance tests cover additional
features such as deferral and dynamic callbacks which that small model does not yet include.

Install the official `tla2tools.jar` and set `TLA2TOOLS_JAR`; `scripts/formal.mjs` fails explicitly
if the jar is missing. A local `.artifacts/tla2tools.jar` is also accepted and is never committed.

## Release/review boundary

Passing these checks is evidence, not a production certification. Deployment claims are limited
to the adapters and failure modes actually exercised. This first version has memory and SQLite
adapters and an embedded-port helper, not every database adapter discussed during planning.
There is no migration, garbage-collection/tombstone API or distributed global-capacity limiter.

Application integration must also verify authorization, its real transaction/serialization
boundary, domain cancellation/cleanup ordering, and idempotent external operations. A queue
fence alone cannot protect an arbitrary callback that was merely preceded by a lease check.

The checked official TLC release is `v1.7.4`, SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`. CI verifies that digest before executing it.
