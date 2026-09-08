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
- external-executor service/runtime surface.

The extractor inventories exported functions/constructors, public class methods, exported interface methods, returned callable objects such as `createWorkOnce().dispatch`, and callable policy fields. It then recursively walks every package-owned input/output/callback type, including optional/null/undefined flags, recursive references, index values and callback arguments/results.

The reviewed manifest currently maps **124 public callables**, **21 callable policy/storage fields**, **107 reachable package-owned types**, and **333 individual fields**. Every field carries a semantic classification, model/abstraction concepts, a type hash and executable evidence. No traversed public type is truncated.

`assurance/formal-implementation-manifest.json` is fail-closed. A new callable, input/output/callback field, overload/signature, field type, configured TLA invariant, or bound source/model semantic digest makes assurance fail until the map is deliberately regenerated and reviewed. Bound WorkOnce lifecycle source changing without a TLA/CFG semantic change is rejected by `assurance:update` unless the reviewer explicitly acknowledges that the abstract machine intentionally stays unchanged.

The compiled observation bridge is fail-closed too. `npm run build` writes an ignored content binding for every `src/**/*.ts` build input plus the TypeScript configs **and for every emitted file under `dist/` and `dist-cjs/`**. `npm run formal`, `npm run assurance:traces` and the standalone real-process test command verify that binding before consuming emitted code, so neither stale JavaScript nor a post-build edit to ESM, CommonJS or declarations can certify newer/current TypeScript. The complete assurance gate deliberately corrupts the source stamp and separately mutates ESM JavaScript, CommonJS JavaScript and declarations; all four mutants must be rejected.

The generated human summary is `formal/FORMAL_COVERAGE_GAPS.md`; despite the historical filename, a clean run currently reports no unmapped public surface.

## Batched executable refinement and fuzz corpus

`test/formal-bounded-refinement.test.mjs` drives the **real public WorkOnce API** through one in-process bounded corpus. It currently contains 43 deliberate lifecycle scenarios plus **96 deterministic seeded traces × 10 steps**. It checks the state after every step and covers 57 reviewed dimensions, including:

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
- parallel claim competition, local-vs-external executor competition, and neighboring-handler failure isolation.

`assurance/bounded-trace-domain.json` binds that semantic domain to the executable corpus. Changing the corpus or adding/removing a required dimension fails `npm run assurance:traces` until reviewed.

The corpus is deliberately **batched in one Node process**. WorkOnce does not launch TLC once per trace. This follows the same performance lesson used by the owner's other hardened-kernel assurance harnesses: enumerate/refine executable traces cheaply, and use one model-checker graph run for the abstract machine.

## Shared adapters and real-process faults

`src/conformance.ts` contains 18 shared adapter scenarios. They cover competing claims, exact lease expiry, stale renew/settle/retry/defer/failure rejection, delayed retry eligibility, bounded prerequisite waiting, manual generations/gates, async policy races, retry denial, report replay, cancel/complete races, crashed-attempt budgets, deadlines, outbox delivery, wake revisions, scope/version boundaries and immutable rollback assertions.

The public tests run that suite against memory, real SQLite and a native-CAS test port. A BYO application adapter runs the same suite independently; a tested reference port does not certify a different database or application transaction boundary.

Additional tests cover expiry between read and the actual native write, unknown CAS acknowledgements, async continuation planning, poison follow-up fairness, worker lease-loss cancellation, and reset blocking while previous durable follow-ups are pending.

`test/process/sqlite-process.test.mjs` barriers eight independent processes onto the same brand-new SQLite path, then separately reopens a populated current-schema database, proving initialization and concurrent reopen preserve existing work. SQLite has one schema and no automatic development-schema conversion. It then races eight claimers against one item. A final case kills an owning worker with SIGKILL, reopens storage, reclaims its lease and rejects the stale reference. These are local-file SQLite guarantees, not an endorsement of network filesystems or untested third-party stores.

`npm run check:web` compiles the default API with only ES2018 + WebWorker libraries and no Node ambient types, then rejects Node builtins/external runtime dependencies or root-runtime size-budget regressions. The optional `/sqlite` subpath is intentionally outside that browser graph.

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

The checked bounds are two workers, five time ticks, four fences, two generations, two claims per generation, one automatic retry, one deferral and a three-tick elapsed budget. The current graph is **228,573 generated / 133,714 distinct states**, complete depth **17**, with no invariant violation. The 10 configured invariants cover state/counter typing, uniqueness of the issued current fence, proof that a running owner token was actually issued, accepted-fence currentness, current-fence success, wait-cause consistency, terminal-only pending follow-ups, no reset state retaining prior pending intent, and no lost continuation obligation. Generation restart explicitly clears generation-local child evidence so an old child cannot satisfy a later continuation.

This is bounded abstract safety evidence, **not a complete machine-checked refinement proof from every TypeScript instruction to TLA+**. `Renew` is bounded by the modeled per-generation deadline, but `Spec` intentionally declares no fairness or liveness property; eventual scheduling/delivery is therefore not a TLC-proven claim. The compiler map plus executable refinement/fuzz corpus is the implementation bridge; native adapter/fault tests cover storage behavior outside the abstract machine. External side effects remain at-least-once unless their own system participates in idempotency/fencing.

The pinned official TLC release is `v1.7.4`, SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`. CI verifies that digest. Set `TLA2TOOLS_JAR` or use ignored `.artifacts/tla2tools.jar` locally.

## Runtime boundaries and full transition matrix

The durable machine now considers retry/wait delays of zero, one and two ticks. Its deferral
stop reason uses the same ordered predicate checked against real settlements: attempt budget,
then elapsed deadline, then deferral budget. Existing worker/time/fence/generation/counter bounds
are unchanged. Different graph counts reflect the corrected stop-reason branches and expanded
delay choices, not removal of supported transitions.

`formal/WorkOnceRuntime.tla` separately models bounded local/external runner control: claim replies,
error observers, active completion, interruptible backoff, shutdown, draining and final rejection.
Failure presence is independent of the rejection payload, including JavaScript `undefined`. When
execution first stops, the model records the number of already-active handlers; that count may
fall while draining but can never increase, so a claim response arriving after abort/fatal stop
cannot be admitted. Its eight invariants cover control-state typing, failure presence and representative failure-value
identity, fatal backoff, admission after stop, draining, rejection and agreement with fresh
implementation observations. The bounded graph has 949 generated / 126 distinct states, complete
depth 9, with local capacity at most two.

`scripts/runtime-boundary-refinement.mjs` collects **233 observations from the real compiled public
APIs**: 86 runner/error/race cases, two local alternate-history congruence comparisons, 80
definition-bound reads plus three cross-adapter typed-read bundles, 36 backoff inputs, 24 overlapping
budget cases and both cancel/completion
orders. The runner observations include exact representative rejection identities (`undefined`,
`null`, `0`, empty string and two distinct Error identities), stop while a claim reply is in flight,
stop while a handler is active, drain-before-return, and reclaim after the abandoned lease expires. `scripts/formal.mjs` puts these fresh observations
into one generated TLA module and checks `BoundarySampleOK` from `WorkOnceContract.tla`. The
expanded durable `Defer` action uses that contract's stop-reason operator too. The observations are
not replaced by a simulated implementation or cached verdict. The larger retry indices have an
explicit saturation abstraction only for the sampled zero/one/eight initial delays, one/two
multipliers and a 64 ms cap; this is not an unbounded arithmetic proof. The formal runner also
injects one explicit unsafe late-admission transition and requires `NoAdmissionAfterStop` to reject
that mutant. This keeps the admission invariant from becoming a permanently-true bookkeeping flag.

`test/lifecycle-transition-matrix.test.mjs` adds **600 command/phase/adapter cases**, including
rejected-operation no-write assertions, across memory, SQLite and native CAS. An additional
public-API regression performs 1,025 real zero-delay retries and proves immediate eligibility
survives exponent overflow. Shared conformance also runs unchanged against a conforming adapter
that reorders atomic invocation arrival, so a legitimate completion-before-cancel result is not
misclassified as an adapter defect.

The manifest now binds conformance implementation source as well as runtime source. It maps
explicit item retry/rerun wrappers and relevant timer/backoff fields to their actual semantics.
The bounded-domain evidence digest includes the new producer, matrices and observation-to-TLA
runner. These are bounded executable refinements and safety checks, not instruction-by-instruction
TypeScript verification. Neither model assumes fairness or proves that an application callback or
network request must eventually resolve. Keeping the two graphs separate avoids a large artificial
cross-product and does not launch TLC per observation.

## Assurance-infrastructure non-vacuity

The proof machinery is itself content-bound. The compiler/formal manifest records a raw-content
digest over the formal surface extractor, manifest checker, bounded-trace checker, TLC runner,
compiled observation producers, build/source-artifact binding, mutation guards, full assurance
runner and `package.json`. The bounded-trace report independently hashes the same critical proof
wiring. An unreviewed change to the proof runner therefore makes both committed reports drift; the
full gate injects such a proof-runner mutation and requires both reports to go red before restoring
the file.

Every supported package-script entrypoint that consumes emitted artifacts is also audited. Commands
such as `test`, consumer smoke, benchmark, update flows and web tests must build first; direct
process tests must verify the existing bound build; `formal` and `assurance:traces` must perform the
binding check before dynamically importing `dist`-backed producers. The full assurance runner must
build before any emitted-artifact consumer. A mutation that removes the `test:process` freshness
guard is required to fail this entrypoint audit.

Configured formal invariants are fail-closed too. `scripts/formal.mjs` compares its mutation map to
the exact invariant names parsed from both CFG files, so adding/removing a configured invariant
without a corresponding mutation control fails. The current gate injects one-transition violating
states for all ten lifecycle invariants and all seven runtime invariants and requires TLC to report
the intended invariant violation. `RuntimeSamplesConform` gets a deliberately invalid observed
sample set, while `NoAdmissionAfterStop` additionally keeps the realistic late-admission mutant.
These controls prove that each configured invariant is active; they do not replace the real bounded
state-space runs.

## Typed-read / definition-fence refinement

Typed inspection is now bound as its own semantic family rather than only an accept/reject helper.
The existing 80 phase/method observations require exact snapshots (and exact durable history for
`history()`), exact `definition_changed` rejection on mismatched definition versions, and no error
on matched reads. Three additional compiled cross-adapter bundles exercise memory, real SQLite and
the native compare-exchange test port with mixed-version batches, missing keys/ids, wrong
scope/kind ids, duplicate-key ordering, item-level inspection and current opaque-id reads. Missing
`inspect`/`inspectId` returns `undefined`, missing `history` rejects `not_found`, while a present row
under the wrong definition rejects `definition_changed`.

The compiler/formal manifest carries a method-level semantic digest over the exact read and
definition-fence methods (`WorkItem.inspect`, queue key/item/read helpers, `requireRow`,
`assertDefinition` and snapshot construction) plus the read contract digest. A change to those
methods with an unchanged read abstraction therefore fails closed unless deliberately reviewed.
The bounded-domain digest also binds the cross-adapter producer/test. A TLA sample mutant that
accepts a mismatched definition must violate `RuntimeSamplesConform`, and the complete assurance
gate additionally disables the compiled `assertDefinition()` method and requires the real
cross-adapter producer to go red.

These reads do not own durable partial-progress, cursor scheduling or restart state; those matrix
classes are N/A for this family rather than being fabricated as read-local claims. Concurrent
snapshot behavior and storage transaction semantics remain adapter/storage obligations where they
are not established directly by the read contract.

## Local managed-runner internal-state refinement

The local runner abstraction no longer collapses every defined JavaScript rejection into one
formal value. `WorkOnceRuntime.tla` carries a bounded representative failure identity and the
`FatalValuePreserved` invariant requires the terminal rejection value to match the first fatal
value exactly. Fresh compiled observations still use strict object/value identity in JavaScript;
the finite TLA values stand for representative equivalence classes rather than claiming an
exhaustive universe of arbitrary application error objects.

Two alternate-history pairs are checked explicitly: direct claim failure versus claim-observer
failure, and direct active-handler failure versus active-observer failure. Each pair uses the same
concrete rejection object and must converge to the same runner terminal projection and returned
identity. Separate local observations abort while the first claim reply is in flight and while an
active handler is draining; neither may admit new handler work after stop, and both abandoned
attempts are reclaimable after their durable lease expires.

The compiler/formal manifest now carries a dedicated runner source/model digest over
`src/worker.ts`, `src/work.ts` and the runtime TLA/CFG/contract, in addition to the broader package
semantic binding. A runner source change with an unchanged runtime abstraction therefore fails
closed unless deliberately acknowledged after review. This remains bounded safety evidence: process
crash persistence itself belongs to the durable lifecycle/storage families, and unbounded fleet
fairness is not claimed here.

## Fast complete gate

`npm run assurance` runs the complete local gate with one build, the ES2018/WebWorker compatibility check, one compiler-map pass, one batched implementation test process, one real-process fault pass, one bounded-domain audit, a durable-lifecycle TLC graph, one small runtime-boundary TLC graph plus its admission mutation guard, and the packed consumer smoke test. On the current HPSERVER development machine the expanded exhaustive-proof candidate measured **50.43 seconds wall-clock** and about **365 MB peak RSS** under Node 22.22.1; the durable-lifecycle TLC run itself remains about **1–2.5 seconds** with bounded worker parallelism and parallel GC. The complete gate remains below the 60-second hard budget despite the emitted-artifact guards and per-invariant mutation controls.

That timing is evidence for this machine/version, not a universal performance promise. The important design rule is structural: no per-trace model-checker process explosion.

## Explicit limits

No distributed-global capacity limiter, arbitrary workflow replay, automatic database migration, ID reuse/garbage collection or exactly-once external-effect claim is made. The old per-domain embedded adapter helper was removed; supply one proven store shared by all work kinds. Production deployment additionally needs authentication, an appropriate storage clock, coordinated backup/restore, correct external idempotency and the application's own domain guards.

## Aliases and storage representation

Readable and conventional technical names are supported aliases to the same operations and
configuration. They do not introduce separate queues, states, record formats or conversion paths.
The 600-case lifecycle matrix retains its alias coverage. SQLite initializes one current schema;
obsolete development layouts are rejected rather than adopted or migrated. Current-schema
initialization, reopen, claim competition and crash recovery remain tested.
