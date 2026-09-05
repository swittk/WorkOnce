2026-09-05
- Owner requested WorkOnce, dynamic policies, manual retry gates, defer/poll, durable next work, parallel workers, BYO storage and conformance.
- Clean implementation; no Conveyor code copied and no private application source belongs in this public repository.
- Avoid the earlier unsafe settle(callback) sketch. Resolve decisions outside storage; commit pure transitions inside the adapter's atomic per-item operation. Domain writes are not made safe by a prior queue check.
- First adapters: reference memory and real SQLite. The adapter contract is the authority boundary; process-local locking is not a multi-replica guarantee.

- Implemented pure outcome settlement (no arbitrary protected-callback promise), dynamic retry policy, deferred checks, separate total/retry/defer budgets, expected-generation manual retries, cancellation, wake and recent history.
- Added atomic success plus outbox, idempotent dispatcher and supervised delivery loop. Strong queue-state fencing does not imply exactly-once external effects.
- ESM/CommonJS, memory reference, real SQLite and caller-supplied embedded-row port. Embedded port is only as strong as the provided serialization boundary.
- Checks passed on Node 22.22.1 and Node 24.14.1: 17 shared conformance cases per memory/SQLite/embedded setup, 12 top-level unit/runtime tests, and real 8-process plus SIGKILL/reclaim tests on Node 22.22.1.
- Bounded TLA checked with official v1.7.4 tool (SHA-256 936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88), 6262 distinct states. This is not a complete implementation refinement proof; see docs/assurance.md.
