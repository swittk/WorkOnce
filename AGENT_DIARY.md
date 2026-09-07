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
- Surface currently maps 119 callables, 21 callable policy/storage fields, 105 reachable package-owned types, and 329 fields; every field has a classification, abstraction concept, type hash, and executable evidence. Returned callable objects and type-only interface methods are included.
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
