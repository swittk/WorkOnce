# Supported surface and transition audit — 2026-09-08

Audit baseline: `e0bcf157486fd5f9b62c2485f35864d0cb2e6739`.

## Scope

The independent audit followed all 124 compiler-discovered public callables, 21 callable
policy/storage fields and 333 reachable contract fields across root, external, kernel, storage,
memory, SQLite, CAS and conformance entrypoints. Aliases were traced to their governing
implementation rather than treated as independent state machines.

The review covered request identity and JSON isolation; definition-bound reads; due discovery;
claim/reclaim/renewal and storage-side expiry; success/failure/retry/non-failure waiting;
manual retry/rerun/restart; cancel/wake and generation/revision guards; receipt replay and
conflicts; dynamic retry/wait/continuation policy races; durable outbox insertion/acknowledgement
and poison-child fairness; local and external handler supervision; adapter commit ambiguity;
SQLite startup/migration/process death; ES2018/Web Worker compatibility and packed exports.
Compiler mapping, bounded corpus, model configuration, process tests and consumer gates were
also reviewed. Out-of-band database corruption was not used to manufacture supported defects.

## Verified defects and disposition

1. **Failure presence was conflated with `undefined`.** Both managed runners used the error
   payload itself as the no-error sentinel. A supported `Promise.reject()` in claim transport
   made `run()` fulfill; active/observer failures could continue polling. A tagged internal
   failure container now preserves every rejection payload without losing failure presence.
   Cases include all error sites, handled failures, healthy-neighbor draining, both claim-error
   backoff interleavings, and replies arriving after an active handler has already failed.

2. **Typed reads skipped the definition fence.** `inspectId()` and mutations rejected a v1
   row through a v2 facade, but `inspect()` / `inspectMany()` / item reads returned v1 input and
   result under v2 TypeScript types. Present rows now pass the same definition check before
   snapshot construction. Missing rows, duplicate-key ordering and same-version behavior stay
   unchanged. Every supported phase is covered.

3. **Conformance rejected a correct race ordering.** Cancellation after accepted completion
   is a successful no-op that returns the terminal snapshot. The suite incorrectly required
   cancellation to reject when success won the race. Assertions now require the exact coherent
   result in either ordering, including stale-attempt rejection when cancellation wins. The
   full shared suite passes on an adapter that legitimately reorders entry into atomic storage.

4. **Zero-delay exponential backoff became a positive delay.** All inputs were ordinary
   supported numbers: initial delay zero, multiplier two and at least 1,024 retries. Internal
   exponent overflow produced `0 * Infinity`, and the fallback selected the maximum delay.
   Zero remains zero before exponentiation. The regression goes through 1,025 actual public
   claim/settle retries rather than only asserting the helper output.

## Formal assurance corrections

The old durable TLA `Defer` branch prioritized deferral exhaustion before attempt/deadline
exhaustion, unlike the actual runtime. A reachable two-attempt/one-deferral counterexample
fails the old model's required precedence and passes the corrected model. Zero-delay choices
are now represented in both retry and defer transitions.

Runner failure presence, polling and typed-read rejection were not expressible in the old
single-item durable machine. The new bounded runtime machine and fresh compiled observation
bridge distinguish the pre-fix failures. Running the new bridge against the exact baseline
TypeScript build produced 40 failing observations in the original 202-case batch: 14 runner,
24 typed-read and two zero-delay cases. TLC rejected that baseline with
`RuntimeSamplesConform`; the patched implementation passed. Four additional in-flight admission
cases complete the final 206-case observation set.

Conformance source is now included in source/model drift binding. Item-level explicit retry and
rerun wrappers no longer have empty lifecycle mappings. Timer and backoff fields are classified
as runtime/policy semantics instead of observation-only metadata.

## Evidence and limits

Committed regression evidence is in `test/runtime-boundary-refinement.test.mjs`,
`test/lifecycle-transition-matrix.test.mjs`, `test/conformance.test.mjs` and the source-bound
producers/models named by the assurance manifest. They add 600 phase/command/adapter cases,
206 runtime-boundary observations and the long zero-delay retry regression without dropping
existing conformance, fuzz, process-fault or consumer gates.

No API was added, no storage schema was changed, and the package version was not advanced.
An audit and finite model checks do not establish absence of every possible defect. External
side effects still require application idempotency/fencing; third-party storage needs its own
real-process proof. Full CodeRabbit reviews remain a separate, current-head convergence gate.
