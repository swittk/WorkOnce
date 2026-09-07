# WorkOnce

Keep the root API small and documented. No domain, framework, credentials, private fixtures, or provider internals here.
Durations and timestamps are milliseconds. No arbitrary lifecycle update API.
Use strong TypeScript types; validate numeric invariants and external wire data, not redundant developer-only string types.
Never pretend an arbitrary callback is protected after a lease precheck. Store commits own fencing; external effects need their own idempotency or transaction.
Run npm run assurance and npm run test:consumer before calling the core verified; these match the CI assurance and packed-consumer gates. Record bounded-model limits honestly.
Only swittk/WorkOnce governs code review. Do not publish to npm or merge without owner instruction.
When requesting CodeRabbit full review, the GitHub comment must contain exactly `@coderabbitai full review` and nothing else; put context in separate comments only after the full review finishes.
Public/exported contracts and their direct public members require meaningful purpose JSDoc; `test/documentation.test.mjs` enforces this and rejects tautological filler.
