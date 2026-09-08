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
cannot be admitted. Its seven invariants cover control-state typing, failure presence, fatal
backoff, admission after stop, draining, rejection and agreement with fresh implementation
observations. The bounded graph has 229 generated / 58 distinct states, complete depth 9, with
local capacity at most two.

`scripts/runtime-boundary-refinement.mjs` collects **206 observations from the real compiled public
APIs**: 64 runner/error/race cases, 80 definition-bound reads, 36 backoff inputs, 24 overlapping
budget cases and both cancel/completion orders. `scripts/formal.mjs` puts these fresh observations
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

## Storage / adapter temporal refinement

The shared adapter suite is supplemented by storage-native internal-state proof.
`scripts/storage-refinement.mjs` observes detached `getMany`/`query` rows and exact UTF-8 cursor
ordering across memory, real SQLite and the native compare-exchange wrapper. The CAS lane separately
proves fresh reads after proven compare misses, exact bounded contention exhaustion with no caller
write, and unknown acknowledgements that propagate immediately rather than entering the safe
compare-miss retry loop; replay observes already-committed durable truth. A one-shot injected native
`database is busy` error proves the SQLite startup retry helper is active, while independent
OS-process tests hold a real SQLite write lock and check both retry-to-success and timeout failure.

`formal/WorkOnceStorage.tla` models the library-owned compare-exchange loop explicitly: read,
external competing write, compare miss, fresh retry, caller commit, unknown committed outcome and
decision failure. It bounds compare misses, allows at most one caller commit, forbids a compare miss
or decision failure from committing, requires a fresh observed revision before successful commit,
and makes the unknown-outcome state terminal for this library retry loop. The model also carries a monotonic deadline-reached state: once the storage deadline is reached, neither a known nor unknown caller commit remains legal. All ten configured storage checks, including the fresh compiled observation set, have dedicated mutants.

The complete gate also mutates the actual compiled memory detached-read path, CAS retry bound, CAS
unknown-ack handling and SQLite busy recognizer. A dedicated source/model digest binds storage,
validation, memory, SQLite, CAS and conformance source to the storage TLA/CFG, and a source mutation
with unchanged storage formal semantics must fail closed. Out-of-band hand-corrupted database rows
remain outside the supported boundary; this proof covers supported writes, current-schema startup,
concurrency and crash/recovery behavior rather than adversarial file tampering.

## Storage and adapter conformance refinement

`formal/WorkOnceStorage.tla` models the public `WorkStore`/native compare-and-exchange boundary
separately from lifecycle semantics. The model distinguishes a proven revision compare miss from an
unknown write outcome and from a write-deadline rejection. Ordinary compare misses may perform a
bounded fresh-read retry; an unknown outcome stops immediately, and an expired `validUntil` stops as
`lease_expired` rather than being misclassified as generic contention. Twenty-two fresh compiled
storage observations bind this model to memory, real SQLite and the native CAS adapter.

The observation matrix covers detached `getMany()`/`query()` rows, exact caller order, UTF-8/SQLite
BINARY ordering, exclusive `afterId` continuation, due ordering by `(dueAt,id)`, bounded query limits,
same-row concurrent idempotent insertion, invalid identity/revision/deadline writes, serialization
failure before commit, exact deadline equality, bounded CAS compare-miss retries/exhaustion, CAS
unknown acknowledgement, and materially distinct direct-vs-contended histories for memory, SQLite
and CAS that must converge to the same durable row and the same subsequent claim/heartbeat/success
trace. CAS also retains the explicit synthetic compare-miss-history witness. `maxConflicts` boundaries,
SQLite busy-timeout boundaries and SQLite startup BUSY/LOCKED recognition are covered as well. Every
configured storage invariant has a mutation witness and the compiled sample set has its own bad-sample
guard.

One supported storage defect was exposed by the exhaustive matrix: the CAS adapter previously treated
a `false` compare-exchange caused by write-deadline equality as ordinary revision contention. A direct
`WorkStore.atomic()` call could therefore exhaust conflicts and return the generic contention error
while memory/SQLite returned `lease_expired`. After a false CAS write with `validUntil`, WorkOnce now
performs a fresh storage read: an unchanged expected revision at/after the deadline is classified as
exact `lease_expired`; a changed revision remains ordinary compare contention. The exact pre-fix
implementation is preserved as RED evidence.

Separately, SQLite startup now recognizes native SQLite primary result codes (`SQLITE_BUSY=5`,
`SQLITE_LOCKED=6`) before falling back to English error text. The exact Node 22.22.1 real-lock path
already supplied a matching busy/locked message before this hardening, so numeric-code recognition is
classified as proactive robustness rather than a second supported red-before runtime defect.

`test/process/storage-process.test.mjs` proves the direct SQLite durability boundary. A committed
atomic insert survives SIGKILL before the caller receives the Promise result, reopens as one revision,
and identical retry is idempotent; a decision exception performs no durable write across process
death/reopen. Existing process tests cover competing initialization, current-schema reopen and owner
SIGKILL/reclaim. Startup lock tests prove a real write lock can be retried, while timeout propagates
the native busy/locked error without partial schema claims. A deliberately old development table
shape is rejected and remains unchanged: WorkOnce has one current schema and no automatic
unreleased-schema adoption/migration path.

Memory is the reference transition store and intentionally has no crash durability. The native CAS
port inherits durability/availability from the application-supplied backing store; WorkOnce proves
its compare/retry/deadline/unknown-outcome wrapper semantics but does not claim persistence properties
that the port does not provide. Out-of-band hand-corrupted database rows remain outside supported
operation; when encountered, first-party parsing/metadata validation fails closed with
`Invalid persisted WorkOnce row` rather than interpreting corrupt control state.

The storage proof is source/model bound across `src/storage.ts`, `src/storage-validation.ts`,
`src/memory.ts`, `src/sqlite.ts`, `src/cas.ts` and shared conformance. The bounded evidence digest
includes the storage model/producer, focused refinement and contract tests, SQLite startup/atomic
process tests and mutation controls. Compiled mutants remove row detachment, widen compare retries,
swallow unknown CAS acknowledgement, erase CAS deadline classification, make `afterId` inclusive,
weaken exact +1 revision validation and disable SQLite busy recognition; each must make the focused
storage proof red for its intended witness.

## Fast complete gate

`npm run assurance` runs the complete local gate with one build, the ES2018/WebWorker compatibility
check, one compiler-map pass, one batched implementation test process, one real-process fault pass,
one bounded-domain audit, the durable-lifecycle/runtime TLC checks, the storage/conformance TLC checks
and the packed consumer smoke test. Read-only compiler/compatibility checks and the independent unit
vs real-process test groups execute in parallel, while storage TLC and lifecycle/runtime TLC remain
isolated from each other so one model checker cannot perturb another model checker's proof artifacts or
infrastructure outcome. The HPSERVER completion budget is **under 60 seconds wall-clock** on Node
22.22.1.

That budget is a local gate requirement, not a universal performance promise. The important design rule
is structural: no per-trace model-checker process explosion and no coverage reduction to meet the gate.

## Explicit limits

No distributed-global capacity limiter, arbitrary workflow replay, automatic database migration, ID reuse/garbage collection or exactly-once external-effect claim is made. The old per-domain embedded adapter helper was removed; supply one proven store shared by all work kinds. Production deployment additionally needs authentication, an appropriate storage clock, coordinated backup/restore, correct external idempotency and the application's own domain guards.

## Aliases and storage representation

Readable and conventional technical names are supported aliases to the same operations and
configuration. They do not introduce separate queues, states, record formats or conversion paths.
The 600-case lifecycle matrix retains its alias coverage. SQLite initializes one current schema;
obsolete development layouts are rejected rather than adopted or migrated. Current-schema
initialization, reopen, claim competition and crash recovery remain tested.
