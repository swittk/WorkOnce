# WorkOnce development notes

2026-09-05

- Owner requested WorkOnce, dynamic policies, manual retry gates, defer/poll, durable next work, parallel workers, BYO storage and conformance.
- Clean implementation; no Conveyor code copied and no private application source belongs in this public repository.
- Avoid the earlier unsafe settle(callback) sketch. Resolve decisions outside storage; commit pure transitions inside the adapter's atomic per-item operation. Domain writes are not made safe by a prior queue check.
- First adapters: reference memory and real SQLite. The adapter contract is the authority boundary; process-local locking is not a multi-replica guarantee.

- Implemented pure outcome settlement (no arbitrary protected-callback promise), dynamic retry policy, deferred checks, separate total/retry/defer budgets, expected-generation manual retries, cancellation, wake and recent history.
- Added atomic success plus outbox, idempotent dispatcher and supervised delivery loop. Strong queue-state fencing does not imply exactly-once external effects.
- ESM/CommonJS, memory reference, real SQLite and caller-supplied embedded-row port. Embedded port is only as strong as the provided serialization boundary.
- Checks passed on Node 22.22.1 and Node 24.14.1: 18 shared conformance cases per memory/SQLite/embedded setup, 12 top-level unit/runtime tests, and real 8-process plus SIGKILL/reclaim tests on Node 22.22.1.
- Bounded TLA checked with official v1.7.4 tool (SHA-256 936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88), 6262 distinct states. This is not a complete implementation refinement proof; see docs/assurance.md.

2026-09-05 second pass

- Removed the per-feature embedded-row helper from the public API. Applications provide one native compare-and-swap port for all work kinds; no framework dependency or object model enters this package.
- Retry and defer policies can be async callbacks. Limits can be a per-input callback resolved at request creation; only the chosen data is stored.
- Compare-and-swap writes carry a storage-checked exclusive lease deadline. A read-time guard alone is not sufficient after a slow or uncertain write.

- Removed second copies of terminal work truth from the integration design rather than adding a domain callback projection engine. The generic next callback remains a durable request planner.
- Added native write deadlines, definition filtering, consistent ASCII identity ordering, cached SQLite queries, arithmetic preflight, poison-child fairness, async observer handling and clean distribution builds.
- Bounded formal model now preserves all issued claim tokens, including repeated claims by one worker: 8310 distinct states, not the old 6262-state worker-token overwrite abstraction.
- Runtime remains framework/driver-free except the explicit built-in SQLite entry. BYO storage is supplied once, not per feature.
  2026-09-06 hardened pass
- Re-ran the complete core gate after the second-pass redesign: 36 Node tests, 2 real OS-process/crash tests, packed ESM/CJS/types consumer, format check and bounded TLC all pass. TLC explored 13,782 states / 8,310 distinct states at depth 15.
- Current claim discovery filters definition before the limit; old-definition rows cannot poison a current worker pass. Dispatch retains poison follow-ups and continues healthy siblings/pages. SQLite preserves the original failure if rollback itself fails.
- Public tree was scanned for private application names/fixtures before commit; tracked source/docs are clean. Local ignored `.chatgpt` state may describe private dogfood and must remain untracked.
- A private Parse-only dogfood adapter now passes the shared contract on two Parse backends, but it stays out of this public package until its capability surface stabilizes. Do not add framework-specific code merely to move application LOC.

2026-09-07 exhaustive formal implementation pass

- Copied the owner's current hardened-kernel assurance mechanics, not their domain model: compiler-discovered callable/type surface, fail-closed manifest, source/model semantic pairing, one batched implementation refinement corpus, and one TLC graph run.
- Surface currently maps 124 callables, 21 callable policy/storage fields, 107 reachable package-owned types, and 333 fields; every field has a classification, abstraction concept, type hash, and executable evidence. Returned callable objects and type-only interface methods are included.
- Bounded implementation corpus currently runs 28 deliberate scenarios plus 96 deterministic 10-step fuzz traces and requires 42 semantic coverage dimensions. No per-trace TLC process spawning.
- TLA now covers retry denial/budget, defer/wake/deferral budget, manual retry permission, rerun, attempt/deadline exhaustion, follow-up obligations and reset blocking in addition to fenced claim/renew/success/failure/cancel. Current checked graph after resetting generation-local continuation evidence: 203641 generated / 135366 distinct states, depth 19. Ownership checks now require the current fence token to be unique and the running owner token to have actually been issued; the old tautological OneOwner check is gone.
- Complete `npm run assurance` measured about 20 seconds wall on HPSERVER. TLC itself fell to about 2.3 seconds with bounded host parallelism + parallel GC. Keep this gate cheap enough for every review loop.
- Ordinary `assurance:update` refuses source-only lifecycle drift; use `assurance:update:ack` only after an explicit review that the abstract machine intentionally remains unchanged.
- Email-relay dogfood exposed repeated foreign-worker heartbeat/poll/settle glue. Added framework-neutral `runRemoteWorker` plus `createRemoteWorkService`; transport/auth/Parse stay application-owned. Remote runtime maps to the same existing fenced lifecycle rather than adding TLA states, and its public surface/evidence is included in the exhaustive manifest.
- Readability hardening: added preferred application-facing aliases `wait`, `heartbeat`, `executionLimits`, and `thenDo`, plus explicit `WorkItem.retry()`/`rerun()` and first-party deterministic `exponentialBackoff()`. Standard/internal terms remain compatibility aliases where safe.
- Added compiler-AST purpose-JSDoc enforcement for exported contracts/direct public members and recorded that CodeRabbit full-review comments must contain exactly `@coderabbitai full review` with no appended scope text.
  2026-09-07 executor/readability compatibility pass
- Bound `perform` lets one definition own its canonical in-process handler; `process()`/`run()` may still take an explicit override but fail before claim when neither exists.
- External execution is now `queue.serveExternal(...)` on the authority side and `runExternal(...)`/`processExternal(...)` on the executor side. Only a handoff exports a live attempt; preparation wait/retry/fail outcomes settle locally. A dedicated real-code refinement scenario races local and external execution for one item and requires one owner.
- The complete package now emits ES2018 syntax. The default/root graph has an assurance gate compiling with only ES2018 + WebWorker libs/no Node ambient types, rejects Node/external runtime imports, and enforces 96 KiB raw / 24 KiB gzip budgets. `/sqlite` remains an explicit Node-only subpath.


2026-11-14 finite terminal retention

- Added opt-in per-definition/per-request terminal retention and actual physical deletion. Permanent retention stays the default; zero is valid for disposable work. There are no permanent per-job tombstones.
- Creation incarnation is allocated outside atomic decisions and carried in worker/manual references, CAS comparisons, async gates and dispatcher acknowledgements. Inert follow-up requests remain deterministic. Deleted keys can be reused intentionally without accepting an old attempt whose counters happen to repeat.
- Eligible terminal records have no pending outbox. Maintenance uses indexed bounded discovery plus an atomic incarnation/revision/deadline recheck; explicit prune and supervised runPruner APIs expose the lifecycle without a hidden timer.
- Memory, SQLite and capability-negotiated CAS adapters implement physical deletion. Permanent-only CAS ports reject finite writes even when another deployment already created the row. The exact published 0.3.0 SQLite schema receives an additive nullable expiry projection without rewriting existing permanent records.
- Complete assurance passed uninterrupted: 235 implementation tests, 30 process-fault tests, compiler/type/format/consumer checks, source/model and implementation mutation guards, and bounded TLC families including the retention model. Separate packed consumer check passed ESM, CommonJS and TypeScript declarations. Earlier interrupted/failed runs were not counted.
- Independent SQLite steady-state probe completed six batches of 80 jobs: all six retained-row counts were zero, page count remained 40, and no tombstone table was created. Scope and definition expiry discovery use their covering indexes; the ordinary due-work index remains unchanged.
- Retention deliberately ends deduplication/replay when work is removed. External effects still need application/provider idempotency. Third-party adapters must retire auxiliary synchronization/version records as well, and may use recoverable bounded cleanup only if its temporary markers are eventually removed.


2026-11-14 — Finite-retention formal proof strengthening (same branch)

- Audited the initial dedicated `formal/WorkOnceRetention.tla` instead of relying only on its 9 passing invariants. Found `staleWrites` and `wrongDeletes` were fixed at zero by the ordinary transition graph; artificial invariant mutation witnesses alone did not demonstrate the real stale-worker/reused-key race.
- Strengthened `TryOldAuthority` to evaluate old-versus-current incarnation and derive rejected/accepted stale attempts from that guard. Prune now derives wrong-deletion evidence from BOTH candidate incarnation and revision comparisons; disabling either yields a reachable bad delete. The runtime implementation `src/` remains unchanged.
- Added seven individual reachable guard-removal TLC probes: active-state pruning, pending outbox, storage deadline, forever retention, stale prune incarnation, stale prune revision, and old-worker incarnation. Each deliberately weakened actual TLA transition produces the expected property-specific counterexample, rather than an arbitrary initial-state counter injection.
- Added conditional temporal progress model `FairMaintenanceSpec` with weak fairness of Scan/Prune and `EligibleEventuallyClears`. An unfair scheduler produces an expected infinite-stuttering TLC counterexample. This assumes the caller actually runs the maintenance loop; it does not claim automatic time passage, eventual completion of running work, or global exactly-once external effects.
- Native TLC bounded safety run explored 1,056,144 distinct states and depth 20; separate fair-maintenance temporal check with MaxTime 1 explored 149,372 distinct states and depth 18. Source/model/lifecycle/trace proof digests updated with explicit review. Full `npm run assurance` passed: 235 implementation, 30 process-fault, 1 lifecycle formal wrapper (266 total), 7 real guard counterexamples and fair/unfair liveness witness. The strengthened complete gate measured 106 s under host load, above the earlier 60 s documentation target; model depth/coverage was not reduced to hide that.


2026-11-14 — CodeRabbit PR #3 finite-follow-up review

- Two inline comments: existing TLA stale-candidate vacuity had already been fixed in 741e638 (thread resolved); new still-open substantive bug was unsupported finite-retention follow-ups saved to a terminal permanent parent on an unsupported adapter. Dispatch then rejected forever and prevented parent reset/retirement.
- Fixed terminal settlement's pure atomic decision to reject unsupported finite follow-ups, including those produced by `thenDo` dynamic planning, before terminal commit. Receipt replay is intentionally checked first; a previously persisted result can still replay on a downgraded adapter. The hot path with no follow-ups does not query retention capability or iterate requests.
- Added memory and real SQLite regressions: no state/outbox/receipt commit on rejection, worker can resubmit a supported child, dynamically planned failure children are rejected, and an old stranded finite-child outbox can be repaired by upgrading its backing adapter then running dispatch. No silent finite-to-forever conversion or dropped child.
- Added a small separate `WorkOnceRetentionFollowups.tla` abstraction with a legacy invalid-outbox initial state, capability upgrades/downgrades, explicit accept/reject, receipt replay and guarded dispatch. TLC checks the finite-child commit/dispatch/rejected-lease/old-intent invariants, four reachable guard-removal mutants, and conditional legacy-outbox drain under fair upgrade and dispatch, plus a negative unfair-upgrade temporal witness. This is a core protocol model, not a proof of application-specific Parse multi-object atomicity.
\n\n2026-11-14 — PR #3 new CodeRabbit loop: actual incarnation-fencing ABA evidence\n\n- New CodeRabbit major comment at scripts/retention-refinement.mjs and trivial comment at test/retention.test.mjs correctly identified test vacuity: old stale heartbeats/settlements were attempted against queued recreated work, so phase rejection alone masked an absent incarnation check. Both findings share one semantic cause; no runtime bug observed.\n- Changed memory/SQLite ABA refinement and direct regression to CLAIM the new creation first with the *same worker label, work ID, generation, and fence* as the old owner; verified fresh incarnation differs, running snapshot stays exactly unchanged after old heartbeat and settlement rejection. Extended TLA retention observed-sample schema with matchingAttemptFence/freshRunningPreserved, requiring these real adapter checks for model certification.\n- Ran a targeted real source mutation: temporarily removed *only* the \`assertCurrent\` incarnation comparison, rebuilt, and verified \`same-key recreation is fresh\` test failed specifically at \`oldRun.heartbeat()\` with \`Missing expected rejection\`. Restored original kernel source and rebuilt. No production source changes.\n