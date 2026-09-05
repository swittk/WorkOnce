# WorkOnce
Keep the root API small and documented. No domain, framework, credentials, private fixtures, or provider internals here.
Durations and timestamps are milliseconds. No arbitrary lifecycle update API.
Use strong TypeScript types; validate numeric invariants and external wire data, not redundant developer-only string types.
Never pretend an arbitrary callback is protected after a lease precheck. Store commits own fencing; external effects need their own idempotency or transaction.
Run npm test, npm run check, npm run test:process, and npm run formal before calling the core verified. Record bounded-model limits honestly.
Only swittk/WorkOnce governs code review. Do not publish to npm or merge without owner instruction.
