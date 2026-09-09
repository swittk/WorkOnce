# Formal implementation coverage

- Public callables: **142**
- Callable policy/storage fields: **21**
- Reachable package-owned types: **109**
- Reachable package-owned fields: **337**
- Maximum recursive type depth: **8**
- Truncated public types: **0**

## Model actions

- `Claim`: `external.ExternalWorkService.claim`, `external.ExternalWorkTransport.claim`, `external.processExternal`, `external.runExternal`, `external.runExternalAvailable`, `kernel.claimRecord`, `root.ExternalWorkService.claim`, `root.ExternalWorkTransport.claim`, `root.WorkQueue.claim`, `root.WorkQueue.handoff`, `root.WorkQueue.process`, `root.WorkQueue.run`, `root.WorkQueue.runAvailable`, `root.WorkQueue.serveExternal`, `root.processExternal`, `root.runExternal`, `root.runExternalAvailable`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#perform`
- `Renew`: `external.ExternalWorkService.heartbeat`, `external.ExternalWorkTransport.heartbeat`, `external.processExternal`, `external.runExternal`, `external.runExternalAvailable`, `kernel.renewRecord`, `root.ExternalWorkService.heartbeat`, `root.ExternalWorkTransport.heartbeat`, `root.WorkQueue.handoff`, `root.WorkQueue.heartbeat`, `root.WorkQueue.process`, `root.WorkQueue.renew`, `root.WorkQueue.run`, `root.WorkQueue.runAvailable`, `root.WorkQueue.serveExternal`, `root.WorkRun.heartbeat`, `root.WorkRun.renew`, `root.processExternal`, `root.runExternal`, `root.runExternalAvailable`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#perform`
- `Success`: `external.ExternalWorkRun.succeed`, `external.ExternalWorkService.settle`, `external.ExternalWorkTransport.settle`, `external.processExternal`, `external.runExternal`, `external.runExternalAvailable`, `kernel.settleRecord`, `root.ExternalWorkRun.succeed`, `root.ExternalWorkService.settle`, `root.ExternalWorkTransport.settle`, `root.WorkQueue.handoff`, `root.WorkQueue.process`, `root.WorkQueue.run`, `root.WorkQueue.runAvailable`, `root.WorkQueue.serveExternal`, `root.WorkQueue.settle`, `root.WorkRun.settle`, `root.WorkRun.succeed`, `root.processExternal`, `root.runExternal`, `root.runExternalAvailable`, `root.succeed`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#perform`
- `Fail`: `external.ExternalWorkRun.fail`, `external.ExternalWorkService.settle`, `external.ExternalWorkTransport.settle`, `external.processExternal`, `external.runExternal`, `external.runExternalAvailable`, `kernel.settleRecord`, `root.ExternalWorkRun.fail`, `root.ExternalWorkService.settle`, `root.ExternalWorkTransport.settle`, `root.WorkQueue.handoff`, `root.WorkQueue.process`, `root.WorkQueue.run`, `root.WorkQueue.runAvailable`, `root.WorkQueue.serveExternal`, `root.WorkQueue.settle`, `root.WorkRun.fail`, `root.WorkRun.settle`, `root.fail`, `root.processExternal`, `root.runExternal`, `root.runExternalAvailable`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#perform`
- `Retry`: `external.ExternalWorkRun.retry`, `external.ExternalWorkService.settle`, `external.ExternalWorkTransport.settle`, `external.processExternal`, `external.runExternal`, `external.runExternalAvailable`, `kernel.settleRecord`, `root.ExternalWorkRun.retry`, `root.ExternalWorkService.settle`, `root.ExternalWorkTransport.settle`, `root.WorkQueue.handoff`, `root.WorkQueue.process`, `root.WorkQueue.run`, `root.WorkQueue.runAvailable`, `root.WorkQueue.serveExternal`, `root.WorkQueue.settle`, `root.WorkRun.retry`, `root.WorkRun.settle`, `root.exponentialBackoff`, `root.processExternal`, `root.retry`, `root.runExternal`, `root.runExternalAvailable`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#perform`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#retry`
- `Defer`: `external.ExternalWorkRun.defer`, `external.ExternalWorkRun.wait`, `external.ExternalWorkService.settle`, `external.ExternalWorkTransport.settle`, `external.processExternal`, `external.runExternal`, `external.runExternalAvailable`, `kernel.settleRecord`, `root.ExternalWorkRun.defer`, `root.ExternalWorkRun.wait`, `root.ExternalWorkService.settle`, `root.ExternalWorkTransport.settle`, `root.WorkQueue.handoff`, `root.WorkQueue.process`, `root.WorkQueue.run`, `root.WorkQueue.runAvailable`, `root.WorkQueue.serveExternal`, `root.WorkQueue.settle`, `root.WorkRun.defer`, `root.WorkRun.settle`, `root.WorkRun.wait`, `root.defer`, `root.processExternal`, `root.runExternal`, `root.runExternalAvailable`, `root.wait`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#defer`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#perform`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#wait`
- `Cancel`: `kernel.cancelRecord`, `root.WorkItem.cancel`, `root.WorkQueue.cancel`, `root.WorkQueue.cancelCurrent`
- `Wake`: `root.WorkItem.wake`, `root.WorkQueue.wake`, `root.WorkQueue.wakeCurrent`
- `ManualRetry`: `kernel.retryRecord`, `root.WorkItem.restart`, `root.WorkItem.retry`, `root.WorkQueue.restart`, `root.WorkQueue.retry`
- `Rerun`: `kernel.rerunRecord`, `root.WorkItem.rerun`, `root.WorkItem.restart`, `root.WorkQueue.rerun`, `root.WorkQueue.restart`
- `ExhaustAttempts`: `external.ExternalWorkService.claim`, `external.ExternalWorkTransport.claim`, `kernel.claimRecord`, `root.ExternalWorkService.claim`, `root.ExternalWorkTransport.claim`, `root.WorkQueue.claim`
- `ExhaustDeadline`: `external.ExternalWorkService.claim`, `external.ExternalWorkTransport.claim`, `kernel.claimRecord`, `root.ExternalWorkService.claim`, `root.ExternalWorkTransport.claim`, `root.WorkQueue.claim`
- `CreateChild`: `root.createWorkOnce.dispatch`, `root.createWorkOnce.runDispatcher`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#next`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#thenDo`
- `AckChild`: `root.createWorkOnce.dispatch`, `root.createWorkOnce.runDispatcher`
- `OutboxDispatch`: `root.createWorkOnce.dispatch`, `root.createWorkOnce.runDispatcher`
- `OutboxBudgetDispatch`: `root.createWorkOnce.dispatch`, `root.createWorkOnce.runDispatcher`
- `Tick`: **internal/time-only action**

## Runtime boundary model

- Spec: `formal/WorkOnceRuntime.tla`
- Fresh compiled observations: `scripts/runtime-boundary-refinement.mjs` via `scripts/formal.mjs`
- Checked invariants: `DrainedBeforeReturn`, `FailurePresenceIndependent`, `FatalReturnRejects`, `FatalValuePreserved`, `NoAdmissionAfterStop`, `NoFatalBackoff`, `RuntimeSamplesConform`, `RuntimeTypeOK`
- Bound runner source: `src/worker.ts`, `src/work.ts`

- `conformance.runConformance`: `BoundarySampleOK`
- `external.runExternal`: `RunnerRejects`, `ClaimReply`, `ObserveHandled`, `ObserveFatal`, `ActiveDone`, `Finish`
- `root.WorkItem.inspect`: `ReadAllowed`
- `root.WorkQueue.history`: `ReadAllowed`
- `root.WorkQueue.inspect`: `ReadAllowed`
- `root.WorkQueue.inspectId`: `ReadAllowed`
- `root.WorkQueue.inspectMany`: `ReadAllowed`
- `root.WorkQueue.run`: `RunnerRejects`, `ClaimReply`, `ObserveHandled`, `ObserveFatal`, `ActiveDone`, `Finish`
- `root.exponentialBackoff`: `BackoffDelay`
- `root.runExternal`: `RunnerRejects`, `ClaimReply`, `ObserveHandled`, `ObserveFatal`, `ActiveDone`, `Finish`

## Local managed-runner boundary

- Spec: `formal/WorkOnceLocalRunner.tla`
- Fresh compiled observations: `scripts/local-runner-refinement.mjs` via `scripts/formal.mjs`
- Checked invariants: `LocalDrainedBeforeReturn`, `LocalFatalReturnPreserves`, `LocalNoAdmissionAfterStop`, `LocalNoFatalBackoff`, `LocalTypeOK`, `LossPresenceExact`
- Bound local-runner source symbols: `src/work.ts:WorkQueue.claim`, `src/work.ts:WorkQueue.runAvailable`, `src/work.ts:WorkQueue.process`, `src/work.ts:WorkQueue.run`, `src/worker.ts:markLocalClaimStartedAt`, `src/worker.ts:validateWorkerOptions`, `src/worker.ts:waitForPoll`, `src/worker.ts:processClaim`, `src/worker.ts:processClaims`, `src/worker.ts:runWorker`

## Typed-read boundary

- Contract: `formal/WorkOnceContract.tla`
- Cross-adapter producer: `scripts/read-boundary-refinement.mjs`
- Bound source methods: `WorkItem.inspect`, `WorkQueue.key`, `WorkQueue.item`, `WorkQueue.inspect`, `WorkQueue.inspectId`, `WorkQueue.inspectMany`, `WorkQueue.history`, `WorkQueue.requireRow`, `WorkQueue.assertDefinition`, `WorkQueue.snapshot`
- History spec: `formal/WorkOnceReadHistory.tla` via `scripts/read-history-refinement.mjs`
- History invariants: `CurrentProjectionCongruent`, `EnabledFutureCongruent`, `HistoryBounded`, `HistoryDifferenceVisible`, `HistoryRetentionOrder`, `OutcomeFutureCongruent`, `ReadHistoryTypeOK`

## Retry/defer policy boundary

- Spec: `formal/WorkOncePolicy.tla`
- Fresh compiled observations: `scripts/policy-refinement.mjs` via `scripts/formal.mjs`
- Checked invariants: `PolicyFailureNoWrite`, `PolicyTypeOK`, `ReceiptFenceTracksPublishedAttempt`, `ReceiptIdentityControlsReplay`, `StalePolicyCannotPublish`, `SupersededReceiptRejectsOld`
- Bound policy source symbols: `src/kernel.ts:integer`, `src/kernel.ts:add`, `src/kernel.ts:addTimeCapped`, `src/kernel.ts:effectiveNow`, `src/kernel.ts:assertCurrent`, `src/kernel.ts:changed`, `src/kernel.ts:replayReceipt`, `src/kernel.ts:settleRecord`, `src/outcomes.ts:retry`, `src/outcomes.ts:wait`, `src/outcomes.ts:defer`, `src/retry-policy.ts:exponentialBackoff`, `src/work.ts:WorkRun.retry`, `src/work.ts:WorkRun.wait`, `src/work.ts:WorkRun.defer`, `src/work.ts:WorkRun.settle`, `src/work.ts:WorkQueue.waitPolicy`, `src/work.ts:WorkQueue.settle`, `src/work.ts:WorkQueue.wake`, `src/work.ts:WorkQueue.wakeCurrent`

## Outbox scheduler model

- Spec: `formal/WorkOnceOutbox.tla`
- Fresh compiled observations: `scripts/outbox-refinement.mjs` via `scripts/formal.mjs`
- Checked invariants: `AllOriginalIntentAccounted`, `CrossParentOrder`, `FirstPassRotatesPoison`, `HealthyReachedByThirdPass`, `OutboxTypeOK`, `PoisonIntentRetained`
- Mutation guard: `HealthyReachedByThirdPass`
- Bound scheduler source: `src/work.ts`, `src/kernel.ts`, `src/storage.ts`, `src/memory.ts`, `src/sqlite.ts`, `src/cas.ts`
- Budget spec: `formal/WorkOnceOutboxBudget.tla`
- Budget checked invariants: `AllBudgetIntentAccounted`, `AllReachedByFourth`, `BudgetTypeOK`, `ExactBudgetPrefixes`, `MidParentRemainsReachable`
- Budget mutation guard: `AllReachedByFourth`

## External transport boundary

- Spec: `formal/WorkOnceExternal.tla`
- Fresh compiled observations: `scripts/external-transport-refinement.mjs` via `scripts/formal.mjs`
- Checked invariants: `CurrentRunningExported`, `EffectsRequireExport`, `ExternalTypeOK`, `RejectedFenceIsStale`, `SuccessReceiptCurrent`, `UnknownAckIsDurable`
- Bound external source symbols: `src/external.ts:ExternalWorkRun.succeed`, `src/external.ts:ExternalWorkRun.retry`, `src/external.ts:ExternalWorkRun.wait`, `src/external.ts:ExternalWorkRun.defer`, `src/external.ts:ExternalWorkRun.fail`, `src/external.ts:validateExternalWorkerOptions`, `src/external.ts:processLease`, `src/external.ts:runExternalAvailable`, `src/external.ts:processExternal`, `src/external.ts:runExternal`, `src/kernel.ts:integer`, `src/work.ts:WorkRun.handoff`, `src/work.ts:WorkQueue.handoff`, `src/work.ts:WorkQueue.serveExternal`, `src/worker.ts:waitForPoll`

## Storage/conformance model

- Spec: `formal/WorkOnceStorage.tla`
- Fresh compiled observations: `scripts/storage-refinement.mjs` via `scripts/storage-formal.mjs`
- Checked invariants: `AtMostOneCallerCommit`, `BoundedCompareMisses`, `DeadlineExpiryStopsRetry`, `DecisionFaultCannotCommit`, `FreshReadBeforeCommit`, `MissCannotCommit`, `ReachedDeadlineCannotCommit`, `StorageSamplesConform`, `StorageTypeOK`, `UnknownOutcomeStopsRetry`
- Bound storage source: `src/storage.ts`, `src/storage-validation.ts`, `src/memory.ts`, `src/sqlite.ts`, `src/cas.ts`, `src/conformance.ts`

## Assurance infrastructure binding

- Source semantic digest schema: `typescript-ast-printer-directives-v3`
- TLA semantic digest schema: `tla-lexical-string-safe-v2`
- Bound proof/checker files: **113**
- Content digest: `b11781d6dc00a13a3dead6e762895b2038ebf402e79f017bb04ecfa8bd101024`
- Semantic compiler/toolchain inputs: **6**
- Semantic compiler/toolchain digest: `c4f8d798a420c8d9a93a0f31edeef39800aa89337bcd4a113804dc50348605bb`

## Coverage rule

The manifest is compiler-discovered. Any new public callable, reachable package-owned input/output/callback field, signature/type change, configured TLA invariant, or bound source/model semantic change fails assurance until this file and the machine-reviewed manifest are deliberately updated.
