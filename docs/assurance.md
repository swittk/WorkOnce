# Verification boundaries

## Shared and native adapter tests

`src/conformance.ts` contains 17 shared scenarios. They cover competing claims, exact lease
expiry, stale renew/settle/retry/defer/failure rejection, delayed retry eligibility, bounded
prerequisite waiting, manual generations/gates, async policy races, retry denial, report replay,
cancel/complete races, crashed-attempt budgets, deadlines, outbox delivery, wake revisions,
scope/version boundaries and immutable rollback assertions.

The public tests run that suite against memory, real SQLite and a native-CAS test port. A BYO
application adapter runs the same suite independently; a tested reference port does not certify
a different database or application transaction boundary.

Additional regression tests cover:

- Expiry between read and actual native write, and an unknown CAS acknowledgement.
- Per-input limits and asynchronous retry, wait and continuation-planning callbacks.
- Cancellation/reclaim while a policy or continuation callback is waiting.
- Identical accepted outcomes not re-running those callbacks.
- Undefined result rejection, safe arithmetic, version filtering before limits, Unicode cursor order.
- Poison follow-up isolation/fairness, including a one-child dispatch limit.
- Async error observer rejection and truthful cancellation assertions.
- Managed parallel handlers, renewal, free-slot refill, safe worker serialization and inspection.

`test/process/sqlite-process.test.mjs` starts eight independent processes against the same SQLite
file, then separately kills an owning worker with SIGKILL, reopens storage, reclaims its lease
and rejects the stale reference. These are local-file SQLite guarantees, not an endorsement of
network filesystems or untested third-party stores.

`npm run test:consumer` packs and installs the real clean-built distribution in an isolated
consumer, runs ESM/CommonJS round trips and compiles both TypeScript module styles.
`npm run check` also compiles the developer-facing typed API examples.

## Bounded formal model

The model retains **every issued attempt token**, including older attempts from the same worker.
Claims append tokens; success/failure/retry/renew select an individual token and must match the
current generation/fence and unexpired lease. This tests the stale-token case rather than
replacing old worker tokens with their latest value.

The configured bounds are two workers, four time ticks, four fences, two generations, two
attempts and one automatic retry. TLC explored **8,310 distinct states / 13,782 generated**,
complete graph depth 15, with no invariant violation. Invariants cover one authoritative owner,
current-fence success, state/counter bounds and the parent/child outbox relationship.

This is bounded abstract safety evidence, **not a complete implementation refinement proof**.
It does not model database internals, external side effects, all callback implementations or
all deferred-work policies. Native tests and fault injection cover cases outside that small model.

The pinned official TLC release is `v1.7.4`, SHA-256
`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`.
CI verifies the tool digest. Set `TLA2TOOLS_JAR` or use ignored `.artifacts/tla2tools.jar` locally.

## Explicit limits

No distributed-global capacity limiter, arbitrary workflow replay, automatic database migration,
ID reuse/garbage collection or exactly-once external-effect claim is made. The old per-domain
embedded adapter helper was removed; supply one proven native store shared by all work kinds.
Production deployment additionally needs authentication, an appropriate storage clock,
coordinated backup/restore, correct external idempotency and the application's own domain guards.
