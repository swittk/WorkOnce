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

The reviewed manifest currently maps **142 public callables**, **21 callable policy/storage fields**, **109 reachable package-owned types**, and **337 individual fields**. Every field carries a semantic classification, model/abstraction concepts, a type hash and executable evidence. No traversed public type is truncated.

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

The checked bounds are two workers, five time ticks, four fences, two generations, two claims per generation, one automatic retry, one deferral and a three-tick elapsed budget. The current graph is **228,573 generated / 133,714 distinct states**, complete depth **17**, with no invariant violation. The 11 configured invariants cover state/counter typing, uniqueness of the issued current fence, proof that a running owner token was actually issued, accepted-fence currentness, current-fence success, wait-cause consistency, terminal-only pending follow-ups, no reset state retaining prior pending intent, no lost continuation obligation, and child evidence requiring current-generation continuation intent. Generation restart explicitly clears generation-local child evidence so an old child cannot satisfy a later continuation.

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
cannot be admitted. Its nine invariants cover control-state typing, failure presence and representative failure-value
identity, fatal backoff, admission after stop, draining, rejection and agreement with fresh
implementation observations. The bounded graph has 949 generated / 126 distinct states, complete
depth 9, with local capacity at most two.

`scripts/runtime-boundary-refinement.mjs` collects **235 observations from the real compiled public
APIs**: 88 runner/error/race cases, two local alternate-history congruence comparisons, 80
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

Configured formal invariants are fail-closed too. `scripts/formal.mjs` compares its mutation maps to
the exact invariant names parsed from the lifecycle, runtime, local-runner and policy CFG files, so adding or
removing a configured invariant without a corresponding mutation control fails. The current gate
covers eleven durable lifecycle invariants (ten transition witnesses and the semantic
`AckChild` guard mutation), nine runtime invariants (eight transition witnesses and the
observed-sample contract), eight local-runner invariants (seven transition witnesses and
its sample contract), and seven policy invariants (six transition witnesses and its sample
contract). `NoAdmissionAfterStop` additionally keeps the realistic late-admission mutant.
These controls establish predicate sensitivity; they do not by themselves establish that
a counterexample belongs to the legal transition domain. The real bounded state-space
runs remain required.

The shared reachable-mutation checker for outbox and external execution requires the
unsafe poststate to satisfy the model's actual type/bound invariant. Its live domain-escape
sentinel must never be violated. Every reported TLC `-continue` invariant violation must
belong to the exact expected witness set, so an unrelated failure cannot be hidden behind
an expected counterexample or status zero. Reducing the outbox bound below the required
third pass fails the actual reachable-witness gate rather than earning vacuous coverage.

### Independent assurance controls

Every individual implementation mutation in lifecycle, external execution, local runners,
policy, outbox and storage first runs its **same witness** against restored original bytes.
Only a green baseline followed by the intended red mutant earns credit; all original bytes
are restored on exit. An already-broken witness, unrelated exception, timeout or unchanged
mutation cannot certify a kill. The existing read/alias and source/model controls retain
their own green-baseline checks.

The eight observed TLA boundaries also exercise **1,322 individual boolean mutations**
against fresh compiled observations. Each mutation flips exactly one asserted observation
and must be rejected independently by both the executable validator and the actual TLA
sample predicate. Explicit scenario inputs and conditionally irrelevant observations are
excluded, not mistaken for unconditional guarantees. The controls run as constant checks
inside the existing TLC invocations, without adding JVMs or inflating the state graph.
This catches omitted semantic clauses that a single invalid-kind or multiply-invalid
sample could not distinguish. The checked surface is these mapped boolean observations,
not a claim of exhaustive verification of every JavaScript instruction or all possible
mutations.

`ChildEvidenceRequiresIntent` additionally ties child evidence to the current generation's
continuation obligation. It rejects premature child creation and child evidence surviving
either retry or rerun reset. Together with `NoLostContinuation`, this protects both sides
of the create/acknowledge/reset lifecycle without changing supported runtime behavior.

Source/model semantic digests use the pinned `typescript-ast-printer-directives-v3` schema. WorkOnce parses
current TypeScript, prints the actual AST with ordinary comments removed, and appends canonical compiler-semantic
directive metadata before hashing. `@ts-ignore` / `@ts-expect-error` retain their target-token ordinal, while
file pragmas, triple-slash references, AMD dependencies and no-default-lib metadata are preserved without raw
source positions so comment/whitespace-only edits remain neutral. Symbol-level bindings print the
already-parsed function or method node plus that compiler-semantic file metadata. This is conservative:
a directive change invalidates every bound symbol in its file rather than risking an unsound narrow reuse.
The exact pre-fix false-green controls are preserved in
`assurance/red-before/source-semantic-hash-collision.json` and
`assurance/red-before/compiler-directive-semantic-hash.json`; the normal manifest checker and
`test/source-semantic-hash.test.mjs` require return-ASI, postfix-ASI, regexp, template and compiler-directive
canaries to remain distinct while ordinary comments remain neutral. Mutation controls require both the old
trivia-stripping scanner and the AST-printer-only compiler-directive hash to be rejected, including a directive
moved from one target statement to another.

Formal model digests independently use the pinned `tla-lexical-string-safe-v2` schema. The lexical normalizer
removes real nested block/line comments and irrelevant token-separating whitespace while preserving
exact TLA string-literal bytes and operator token boundaries. The pre-fix normalizer globally
collapsed whitespace, including inside string literals: `assurance/red-before/formal-semantic-hash-collision.json`
preserves two digest-identical models where one passes TLC and the other violates its configured
invariant. The checker requires those models to remain distinguishable, keeps comment-only TLA edits
neutral, preserves comment-looking bytes inside strings, and reproduces the legacy collision as a
mutation control.

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
cross-adapter producer to go red. Additional route-specific compiled mutants remove the
`inspectId` fence, the `inspectMany` fence, the `history`/`requireRow` fence and reverse
`inspectMany` result order; each must fail the direct read contract for the intended reason.

These reads do not own durable partial-progress, cursor scheduling or restart state; those matrix
classes are N/A for this family rather than being fabricated as read-local claims. Concurrent
snapshot behavior and storage transaction semantics remain adapter/storage obligations where they
are not established directly by the read contract.

## Local managed-runner internal-state refinement

The local runner abstraction no longer collapses every defined JavaScript rejection into one
formal value. `WorkOnceRuntime.tla` carries a bounded representative failure identity and the
`FirstFatalValuePreserved` invariant remembers the first fatal value and forbids a later concurrent
failure from replacing it; `FatalValuePreserved` then requires the terminal rejection to return that
stored value exactly. Fresh compiled observations still use strict object/value identity in JavaScript;
the finite TLA values stand for representative equivalence classes rather than claiming an
exhaustive universe of arbitrary application error objects.

Two alternate-history pairs are checked explicitly: direct claim failure versus claim-observer
failure, and direct active-handler failure versus active-observer failure. Each pair uses the same
concrete rejection object and must converge to the same runner terminal projection and returned
identity. Separate local observations abort while the first claim reply is in flight and while an
active handler is draining; neither may admit new handler work after stop, and both abandoned
attempts are reclaimable after their durable lease expires.

The local managed-runner proof is now split from the generic local/external control-state quotient as
`formal/WorkOnceLocalRunner.tla`. Its bounded state carries capacity up to three active claims,
claim-request/reply, handled observer backoff, caller stop, fatal ownership loss, drain-before-return,
exact failure-presence tagging and a representative returned failure value. Six configured local
runner invariants cover typing, exact loss presence, no admission after stop, drain-before-return,
no fatal backoff and fatal-value preservation. Every invariant has a generated mutation witness and
`LocalRunnerSamplesConform` has an independently bad observed-sample mutant.

A red-before audit at base `b8ab8bd` found a real supported semantic defect: when a heartbeat
failed with a specific rejection, `processClaim()` aborted the handler but replaced the final
`RunAvailableResult.error` with a fresh generic `Error("Worker ownership lost")` if the handler
returned afterward. An explicit `undefined` heartbeat rejection was even less representable through
`AbortController.reason` alone. The fix tracks ownership-loss _presence_ separately from its unknown
payload and returns the exact heartbeat/expiry cause, while graceful caller abort preserves the
caller's `AbortSignal.reason`. The preserved counterexample lives in
`assurance/red-before/local-runner-heartbeat-cause.json`. The older bounded refinement corpus also
matched the generic error string; that false-green witness was tightened to exact renewal-error
identity, making this an assurance-framework defect as well as a runtime bug.

`scripts/local-runner-refinement.mjs` adds 23 fresh compiled cases: caller-stop and heartbeat-loss
reclaim on memory/SQLite/native-CAS; explicit `undefined` heartbeat failure; settle-delivery cause
precision; two competing managed runners per adapter; ten dynamically arriving jobs under capacity
three; repeated handled claim failures; opposite multi-active completion orders; handled-error versus
graceful-abort and backoff-before versus backoff-during future congruence; a held late claim reply
across stop; heartbeat/lease/huge-idle timer boundaries; and fatal wakeup from an active claim while
the outer runner is sleeping. Three real SQLite process tests additionally SIGKILL a runner with
three active claims, after a durable heartbeat commit before its reply, and after a durable success
commit before its reply. Restart proves reclaim fencing or exact receipt replay as appropriate.

The implementation mutation gate erases exact ownership-loss causes, removes both intentionally
redundant post-stop admission fences together, and disables the active-claim `wakePoll` signal; each
must make the focused compiled suite red. Removing only one stop fence is intentionally survivable,
which proves the two guards are redundant rather than pretending one line owns the safety property.
The compiler/formal manifest carries a symbol-level local-runner source digest and a dedicated
`WorkOnceLocalRunner` model digest; source-only runner drift fails closed independently of the broad
package binding.

The process-local active-promise set, fatal marker, wake callback and AbortSignal are not durable
checkpoint state. After process death, correctness comes from durable attempt leases/fences and
receipts, which are exercised here and owned comprehensively by lifecycle/storage families A/G.
The local runner makes only bounded finite-schedule safety/progress claims; it does not claim
unbounded fleet fairness or exactly-once application side effects.

## Retry/defer policy and settlement-receipt refinement

`formal/WorkOncePolicy.tla` makes the retry/defer policy seam first-class instead of treating every
settlement as one atomic `Retry`/`Defer` edge. The bounded machine records policy-in-flight state,
the revision captured before the callback, one competing cancel/reclaim, attempt fence, durable
settlement-receipt identity and the fence that published that receipt. It checks exact retry stop
precedence (denied, retry budget, attempt budget, deadline), defer stop precedence (attempt,
deadline, deferral), stale policy publication, callback-failure no-write behavior, replay identity,
receipt-to-attempt fencing and supersession of an older receipt by a newer attempt.

The hidden receipt state matters. Two legal defer histories can produce byte-identical public
waiting snapshots while one submitted explicit `{afterMs: 5}` and the other obtained the same
timing from the definition callback. Their durable receipt hashes differ, so replaying the original
submission succeeds while replaying the other form rejects `settlement_conflict`. The policy
abstraction therefore keeps receipt identity instead of claiming those public snapshots have the
same future. A second bounded history proves a waiting receipt from attempt 1 remains replayable
while attempt 2 is running, then becomes `stale_attempt` after attempt 2 publishes its own receipt.

`scripts/policy-refinement.mjs` currently contributes **45 fresh compiled observations**. They cover
all bounded retry/defer stop-precedence combinations, zero-delay and finite arithmetic saturation,
async cancel/reclaim races, exact callback failures with no write, duplicate settlement replay,
static-versus-async equivalent-policy histories, concurrent wake revision fencing, retry and defer
projection equality across memory/SQLite/native-CAS, native-CAS commit-with-lost-ACK recovery and
exact timing errors. `test/process/policy-process.test.mjs` adds real SQLite SIGKILL prefixes for
both retry and defer: death while the async policy is unresolved leaves no policy write and later
reclaim fences the old attempt; death after the waiting row commits but before the ACK returns
replays the exact receipt after restart without rerunning policy or double-incrementing counters.

The dedicated policy source/model binding hashes the exact retry/defer symbols listed in the
assurance manifest: outcome constructors, `exponentialBackoff`, settlement/replay/timing kernel
helpers, and the `WorkRun`/`WorkQueue` policy and wake methods. Unrelated methods in the same source
files therefore cannot mask another family's intended drift failure; the global lifecycle binding
still covers the remaining package semantic source. Separate executable mutants reintroduce the old
zero-delay overflow behavior, swap retry/defer stop precedence, and remove the wake revision guard;
the focused compiled policy suite must go red for the intended witness. Policy/receipt TLA
invariants and `PolicySamplesConform` each have their own mutation control. This family owns no
internal pagination or bounded multi-record scanner, so scheduler/cursor fairness is N/A here rather
than being fabricated. The numeric claim remains finite: JavaScript safe-integer durations, exact
deadline boundaries and the sampled multiplier/overflow classes are proved; arbitrary infinite
numeric domains are not claimed.

## Read-history and multi-id read boundary

`formal/WorkOnceReadHistory.tla` directly represents two distinct **128-event durable history
sequences** whose non-history work projection is identical. Its paired transition relation explores
three-step futures over claim, heartbeat, success, failure, retry, non-failure wait, cancellation,
wake, manual retry and rerun. The configured invariants require the same current projection, same
enabled operations, same result/error class for every operation, the same next projection, exact
128-event suffix-plus-append retention and preservation of the intentionally different historical
trace. Heartbeat is represented as a revision-changing operation that does not append a history
event, matching the implementation. The exact 128-element representation is deliberate; the
history limit is not quotiented to a smaller toy capacity.

Fresh compiled observations independently construct two real rows that differ only in an old
failure reason, then drive six materially different future traces through the public API. They
compare every operation result/error, every post-operation durable projection with `history`
removed, every appended future-history tail and the still-visible historical distinction. Another
compiled trace crosses the real retention boundary and requires exactly the latest 128 events in
order. Mutants changing the implementation to 127 retained events or reversing public history are
required to fail, and all configured read-history invariants have injected TLC witnesses.

`WorkStore.getMany()` guarantees exact caller order, detached valid per-id rows and one returned
storage-time observation. It intentionally does **not** require a cross-id transactional snapshot
while concurrent writers run. Memory and SQLite currently provide endpoint-consistent batches
(the SQLite adapter uses a bounded read transaction), while a conforming native-CAS port may
return a legitimate mixture of per-id revisions. Executable races cover reader-first and
writer-first memory/SQLite orderings plus a mixed native-CAS batch. WorkOnce therefore does not
reject a conforming adapter merely for lacking stronger cross-id snapshot isolation.

## Durable lifecycle hidden-state and claim-scan refinement

The base lifecycle model is supplemented by `formal/WorkOnceLifecycleTemporal.tla` and
`formal/WorkOnceClaimScan.tla`. The temporal model keeps revision, generation, fence and settlement
receipt identity as first-class state. This is necessary: two concrete histories that were equal in
the older quotient after revision/history were erased can accept different future `wake()` commands.
The compiled red-before witness in `scripts/lifecycle-refinement.mjs` demonstrates that split and the
refined model no longer treats those histories as future-congruent. Terminal settlement receipts are
also bound to generation/fence/submission identity, conflicting replay is `settlement_conflict`, and
manual retry/rerun clears prior-generation receipts before the next claim.

The bounded claim-scan model represents a candidate page separately from the requested claim limit.
It proves that terminalizing an exhausted front page does not erase healthy later work, a bounded
pass never returns more than the requested limit, and a subsequent invocation reaches work beyond a
fully consumed front page. Fresh compiled observations exercise exact due ordering, an entirely
stolen first candidate page, exhausted-front continuation and finite draining on memory, real SQLite
and the native compare-exchange adapter. Dedicated implementation mutants remove the four-times
candidate scan widening and introduce an off-by-one returned-claim limit; each must make the focused
lifecycle proof red for the intended reachability/limit witness.

The current compiled lifecycle observation set contains **26 observations**. In addition to the scan
cases it covers exact lease-expiry versus stale-fence causes, legal cancel-before-completion and
completion-before-cancel orderings, concurrent generation reset, async retry/rerun check races,
terminal receipt replay/conflict, generation/fence monotonicity, cross-adapter lifecycle projection
and safe-integer fence/revision/generation boundaries. `WorkOnceLifecycleTemporal.cfg` has eight
configured invariants and `WorkOnceClaimScan.cfg` has six; every configured invariant has a batched
mutation witness, and an invalid compiled-observation set is independently rejected.

`test/process/lifecycle-process.test.mjs` adds seven real SQLite process-death prefixes: durable
ensure before ACK, renewal before ACK, successful and failed terminal settlement before ACK,
mid-multi-record claim scan after the first durable claim, and retry/rerun generation reset before
ACK. Restart observes exactly the committed state: idempotent ensure remains one row, terminal
receipts replay without a second write, resets advance one generation and clear old receipts, and a
mid-scan death leaves later due rows immediately reachable by the next invocation. Existing
process-level lease-death/reclaim tests cover the crashed owning attempt. Native-CAS unknown-ACK
terminal settlement is separately replayed through the durable receipt. The memory adapter is the
reference transition model but is intentionally **not** claimed crash-durable.

`assurance/lifecycle-proof-binding.json` content-binds the lifecycle source set, both dedicated TLA
models/configs, the lifecycle contract, formal runner, compiled producer, mutation controls and real
process tests. A source-only lifecycle mutation with unchanged A model fails closed. The compiled
mutation suite additionally requires stale-fence rejection, settlement-receipt identity,
completion-before-cancel legality, claim-scan widening, exact claim limit and reset receipt clearing.
These are library-owned durable queue semantics only; application callback side effects and external
system exactly-once behavior remain outside this lifecycle proof.

## Outbox scheduler and continuation fairness

The continuation outbox has a dedicated bounded scheduler machine and fresh compiled observations from `scripts/outbox-refinement.mjs`. The model covers poison-item rotation, cross-parent ordering, restart/ack-loss behavior and adapter parity while retaining every original continuation intent. Its configured invariants are fail-closed: simple violations share a batched TLC mutation witness, while lost-child, lost-poison and skipped-wrap mutations exercise the semantic properties that need multi-step state.

Dispatch operations are mapped to explicit `OutboxDispatch` / budget-dispatch actions and outbox cursor/state fields have reviewed abstraction concepts rather than being treated as generic observations. A second budget model covers bounded work across three parents, exact call prefixes and mid-parent reachability. The compiled corpus also includes concurrent/faulted adapters, finite/dynamic arrivals, multiple poison rows, limit boundaries, stale parents, rotation failures, history congruence/splits and real SQLite crash-prefix restart cases. Source/model and compiled-cursor mutation guards fail closed on lost scheduler advancement. This is bounded scheduler safety/fairness evidence; it does not turn application callbacks or external effects into exactly-once operations.

## External transport fencing and effect boundary

External execution now has a dedicated `WorkOnceExternal` machine plus compiled transport observations. The proof binds exported lease/fence identity, successful receipt identity, stale-fence rejection and durable unknown-ack handling to the public handoff/external-runner implementation. Source/model mutation controls cover the external runner, queue handoff/serve paths and shared poll wake behavior.

The managed external runner also preserves the actual abort or heartbeat failure as the interrupted result instead of replacing it with a generic ownership-loss error. Process-level fault tests exercise the effect boundary across real child-process death/reclaim. Deliberate TLC witnesses demonstrate that duplicate external effects remain reachable across crash/reclaim and that an older exported attempt may still perform an external effect after a newer fence is claimed when the external system does not participate in idempotency/fencing; WorkOnce therefore continues to make no exactly-once external-effect claim.

## Storage and adapter temporal refinement

The shared adapter suite is supplemented by a dedicated storage state machine and fresh compiled observations from `scripts/storage-refinement.mjs`. `formal/WorkOnceStorage.tla` models the library-owned compare-exchange loop, known versus unknown commit acknowledgement, revision progression, deadline expiry and the detached/order-preserving read boundary. Its configured invariants and observation conformance are mutation-witnessed so a configured storage property cannot remain present only as a vacuous label.

The executable matrix compares memory, real SQLite and the native compare-exchange wrapper. It covers detached `getMany()`/`query()` values, caller order and cursor ordering, direct and contended histories, known false writes, unknown acknowledgements, exact revision rules, and deadline classification. Real OS-process tests additionally hold SQLite write locks and exercise retry-to-success and timeout/startup failure behavior.

This work exposed two supported storage defects. A false native compare-exchange at the exact write deadline could previously degrade into generic contention even when the expected revision was still current; WorkOnce now re-reads storage and reports `lease_expired` when the unchanged revision is observed at or beyond `validUntil`. SQLite startup/busy handling now also recognizes native primary result codes `SQLITE_BUSY` (5) and `SQLITE_LOCKED` (6), retaining the message fallback for runtimes that expose only text.

Storage proof is independently source/model bound across storage, validation, memory, SQLite, CAS and conformance code. Source-only drift with unchanged `WorkOnceStorage` semantics fails closed. The storage proof files, process tests, packaging/source-freshness guards and mutation controls are also included in the global assurance-infrastructure digest.

## Fast complete gate

`npm run assurance` runs the complete local gate with one source-bound build, ES2018/WebWorker compatibility, the compiler-discovered public map, compiled refinement/unit tests, real-process fault tests, bounded-domain auditing, the lifecycle/runtime/read/policy formal machines, the storage/conformance formal machine, mutation witnesses for configured invariants, and packed ESM/CommonJS/types consumer smoke. Independent checks are parallelized where their artifacts do not race; TLC families stay isolated from one another, and invariant mutations are batched rather than spawning one model-checker process per invariant.

The HPSERVER gate has a hard 60-second wall-clock budget. Timing is machine/version evidence rather than a portable performance promise; the structural rule is that adding assurance must not reintroduce per-trace or per-invariant process explosion or weaken semantic coverage to recover speed.

## Explicit limits

No distributed-global capacity limiter, arbitrary workflow replay, automatic database migration, ID reuse/garbage collection or exactly-once external-effect claim is made. The old per-domain embedded adapter helper was removed; supply one proven store shared by all work kinds. Production deployment additionally needs authentication, an appropriate storage clock, coordinated backup/restore, correct external idempotency and the application's own domain guards.

## Aliases and storage representation

Readable and conventional technical names are supported aliases to the same operations and
configuration. They do not introduce separate queues, states, record formats or conversion paths.
The 600-case lifecycle matrix retains its alias coverage. SQLite initializes one current schema;
obsolete development layouts are rejected rather than adopted or migrated. Current-schema
initialization, reopen, claim competition and crash recovery remain tested.
