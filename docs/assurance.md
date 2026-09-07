# Verification boundaries

WorkOnce assurance has four separate layers. None is presented as proof of exactly-once external effects.

## Exhaustive implementation surface map

`npm run assurance:manifest` invokes the TypeScript compiler over every public package subpath:

- root API;
- storage contract;
- memory and SQLite stores;
- pure kernel;
- shared conformance suite;
- compare-and-swap port;
- foreign-worker service/runtime surface.

The extractor inventories exported functions/constructors, public class methods, exported interface methods, returned callable objects such as `createWorkOnce().dispatch`, and callable policy fields. It then recursively walks every package-owned input/output/callback type, including optional/null/undefined flags, recursive references, index values and callback arguments/results.

The reviewed manifest currently maps **128 public callables**, **18 callable policy/storage fields**, **104 reachable package-owned types**, and **329 individual fields**. Every field carries a semantic classification, model/abstraction concepts, a type hash and executable evidence. No traversed public type is truncated.

`assurance/formal-implementation-manifest.json` is fail-closed. A new callable, input/output/callback field, overload/signature, field type, configured TLA invariant, or bound source/model semantic digest makes assurance fail until the map is deliberately regenerated and reviewed. Bound WorkOnce lifecycle source changing without a TLA/CFG semantic change is rejected by `assurance:update` unless the reviewer explicitly acknowledges that the abstract machine intentionally stays unchanged.

The generated human summary is `formal/FORMAL_COVERAGE_GAPS.md`; despite the historical filename, a clean run currently reports no unmapped public surface.

## Batched executable refinement and fuzz corpus

`test/formal-bounded-refinement.test.mjs` drives the **real public WorkOnce API** through one in-process bounded corpus. It currently contains 28 deliberate lifecycle scenarios plus **96 deterministic seeded traces × 10 steps**. It checks the state after every step and covers 42 reviewed dimensions, including:

- queued/running/retry-wait/defer-wait/succeeded/failed/cancelled states;
- both worker identities, lease reclaim, increasing fences and stale renew/settle rejection;
- retry allowed, denied and budget exhausted;
- defer, wake and deferral exhaustion;
- manual retry allowed/denied and successful rerun;
- cancel from queued/running/waiting;
- attempt-budget and elapsed-deadline exhaustion;
- terminal success/failure with and without durable follow-ups;
- follow-up dispatch and reset blocking while prior intent is pending;
- identical settlement replay and conflicting-result rejection;
- dynamic limits/retry/defer/continuation callbacks;
- parallel claim competition and neighboring-handler failure isolation.

`assurance/bounded-trace-domain.json` binds that semantic domain to the executable corpus. Changing the corpus or adding/removing a required dimension fails `npm run assurance:traces` until reviewed.

The corpus is deliberately **batched in one Node process**. WorkOnce does not launch TLC once per trace. This follows the same performance lesson used by the owner's other hardened-kernel assurance harnesses: enumerate/refine executable traces cheaply, and use one model-checker graph run for the abstract machine.

## Shared adapters and real-process faults

`src/conformance.ts` contains 18 shared adapter scenarios. They cover competing claims, exact lease expiry, stale renew/settle/retry/defer/failure rejection, delayed retry eligibility, bounded prerequisite waiting, manual generations/gates, async policy races, retry denial, report replay, cancel/complete races, crashed-attempt budgets, deadlines, outbox delivery, wake revisions, scope/version boundaries and immutable rollback assertions.

The public tests run that suite against memory, real SQLite and a native-CAS test port. A BYO application adapter runs the same suite independently; a tested reference port does not certify a different database or application transaction boundary.

Additional tests cover expiry between read and the actual native write, unknown CAS acknowledgements, async continuation planning, poison follow-up fairness, worker lease-loss cancellation, and reset blocking while previous durable follow-ups are pending.

`test/process/sqlite-process.test.mjs` barriers eight independent processes onto the same brand-new SQLite path, then separately onto one pre-definition WAL schema, proving both first initialization and startup migration converge. It then races eight claimers against one item. A final case kills an owning worker with SIGKILL, reopens storage, reclaims its lease and rejects the stale reference. These are local-file SQLite guarantees, not an endorsement of network filesystems or untested third-party stores.

`npm run test:consumer` packs and installs the real clean-built distribution in an isolated consumer, runs ESM/CommonJS round trips and compiles both TypeScript module styles. `npm run check` also compiles the developer-facing typed API examples.

`test/documentation.test.mjs` walks the exported TypeScript contract with the compiler AST and fails when an exported declaration or direct public member lacks purpose JSDoc; it also rejects obvious tautological filler. Inline anonymous option-object fields are intentionally excluded to avoid ceremonial comments.

## Bounded TLA+ machine

`formal/WorkOnce.tla` models every current lifecycle transition rather than only claim/success/retry:

- claim/reclaim and renewable fenced ownership;
- success and typed failure;
- automatic retry allowed/denied/budget exhausted;
- deferred prerequisite waits and deferral exhaustion;
- cancellation and wake;
- explicit manual retry and successful-generation rerun;
- attempt and elapsed-deadline exhaustion;
- pending durable continuation creation/acknowledgement;
- the rule that retry/rerun cannot erase pending prior-generation continuation intent.

The model retains **every issued attempt token**, including older attempts from the same worker. Claims append tokens; success/failure/retry/defer/renew select an individual token and must match the current generation/fence and unexpired lease.

The checked bounds are two workers, five time ticks, four fences, two generations, two claims per generation, one automatic retry, one deferral and a three-tick elapsed budget. The current graph is **203,641 generated / 135,366 distinct states**, complete depth **19**, with no invariant violation. The 10 configured invariants cover state/counter typing, uniqueness of the issued current fence, proof that a running owner token was actually issued, accepted-fence currentness, current-fence success, wait-cause consistency, terminal-only pending follow-ups, no reset state retaining prior pending intent, and no lost continuation obligation. Generation restart explicitly clears generation-local child evidence so an old child cannot satisfy a later continuation.

This is bounded abstract safety evidence, **not a complete machine-checked refinement proof from every TypeScript instruction to TLA+**. `Renew` is bounded by the modeled per-generation deadline, but `Spec` intentionally declares no fairness or liveness property; eventual scheduling/delivery is therefore not a TLC-proven claim. The compiler map plus executable refinement/fuzz corpus is the implementation bridge; native adapter/fault tests cover storage behavior outside the abstract machine. External side effects remain at-least-once unless their own system participates in idempotency/fencing.

The pinned official TLC release is `v1.7.4`, SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`. CI verifies that digest. Set `TLA2TOOLS_JAR` or use ignored `.artifacts/tla2tools.jar` locally.

## Fast complete gate

`npm run assurance` runs the complete local gate with one build, one compiler-map pass, one batched implementation test process, one real-process fault pass, one bounded-domain audit, one TLC run, and the packed consumer smoke test. On the current HPSERVER development machine the measured full gate is about **20 seconds wall-clock**; the 135k-state TLC run itself is about **1–2.5 seconds** with bounded worker parallelism and parallel GC.

That timing is evidence for this machine/version, not a universal performance promise. The important design rule is structural: no per-trace model-checker process explosion.

## Explicit limits

No distributed-global capacity limiter, arbitrary workflow replay, automatic database migration, ID reuse/garbage collection or exactly-once external-effect claim is made. The old per-domain embedded adapter helper was removed; supply one proven store shared by all work kinds. Production deployment additionally needs authentication, an appropriate storage clock, coordinated backup/restore, correct external idempotency and the application's own domain guards.
