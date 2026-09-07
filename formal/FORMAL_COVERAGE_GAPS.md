# Formal implementation coverage

- Public callables: **119**
- Callable policy/storage fields: **21**
- Reachable package-owned types: **105**
- Reachable package-owned fields: **329**
- Maximum recursive type depth: **7**
- Truncated public types: **0**

## Model actions

- `Claim`: `external.ExternalWorkService.claim`, `external.ExternalWorkTransport.claim`, `external.processExternal`, `external.runExternal`, `kernel.claimRecord`, `root.WorkQueue.claim`, `root.WorkQueue.handoff`, `root.WorkQueue.process`, `root.WorkQueue.run`, `root.WorkQueue.serveExternal`, `root.processExternal`, `root.runExternal`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#perform`
- `Renew`: `external.ExternalWorkService.heartbeat`, `external.ExternalWorkTransport.heartbeat`, `external.processExternal`, `external.runExternal`, `kernel.renewRecord`, `root.WorkQueue.handoff`, `root.WorkQueue.heartbeat`, `root.WorkQueue.process`, `root.WorkQueue.renew`, `root.WorkQueue.run`, `root.WorkQueue.serveExternal`, `root.WorkRun.heartbeat`, `root.WorkRun.renew`, `root.processExternal`, `root.runExternal`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#perform`
- `Success`: `external.ExternalWorkRun.succeed`, `external.ExternalWorkService.settle`, `external.ExternalWorkTransport.settle`, `external.processExternal`, `external.runExternal`, `kernel.settleRecord`, `root.ExternalWorkRun.succeed`, `root.WorkQueue.handoff`, `root.WorkQueue.process`, `root.WorkQueue.run`, `root.WorkQueue.serveExternal`, `root.WorkQueue.settle`, `root.WorkRun.settle`, `root.WorkRun.succeed`, `root.processExternal`, `root.runExternal`, `root.succeed`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#perform`
- `Fail`: `external.ExternalWorkRun.fail`, `external.ExternalWorkService.settle`, `external.ExternalWorkTransport.settle`, `external.processExternal`, `external.runExternal`, `kernel.settleRecord`, `root.ExternalWorkRun.fail`, `root.WorkQueue.handoff`, `root.WorkQueue.process`, `root.WorkQueue.run`, `root.WorkQueue.serveExternal`, `root.WorkQueue.settle`, `root.WorkRun.fail`, `root.WorkRun.settle`, `root.fail`, `root.processExternal`, `root.runExternal`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#perform`
- `Retry`: `external.ExternalWorkRun.retry`, `external.ExternalWorkService.settle`, `external.ExternalWorkTransport.settle`, `external.processExternal`, `external.runExternal`, `kernel.settleRecord`, `root.ExternalWorkRun.retry`, `root.WorkQueue.handoff`, `root.WorkQueue.process`, `root.WorkQueue.run`, `root.WorkQueue.serveExternal`, `root.WorkQueue.settle`, `root.WorkRun.retry`, `root.WorkRun.settle`, `root.exponentialBackoff`, `root.processExternal`, `root.retry`, `root.runExternal`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#perform`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#retry`
- `Defer`: `external.ExternalWorkRun.defer`, `external.ExternalWorkRun.wait`, `external.ExternalWorkService.settle`, `external.ExternalWorkTransport.settle`, `external.processExternal`, `external.runExternal`, `kernel.settleRecord`, `root.ExternalWorkRun.defer`, `root.ExternalWorkRun.wait`, `root.WorkQueue.handoff`, `root.WorkQueue.process`, `root.WorkQueue.run`, `root.WorkQueue.serveExternal`, `root.WorkQueue.settle`, `root.WorkRun.defer`, `root.WorkRun.settle`, `root.WorkRun.wait`, `root.defer`, `root.processExternal`, `root.runExternal`, `root.wait`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#defer`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#perform`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#wait`
- `Cancel`: `kernel.cancelRecord`, `root.WorkItem.cancel`, `root.WorkQueue.cancel`, `root.WorkQueue.cancelCurrent`
- `Wake`: `root.WorkItem.wake`, `root.WorkQueue.wake`, `root.WorkQueue.wakeCurrent`
- `ManualRetry`: `kernel.retryRecord`, `root.WorkItem.restart`, `root.WorkQueue.restart`, `root.WorkQueue.retry`
- `Rerun`: `kernel.rerunRecord`, `root.WorkItem.restart`, `root.WorkQueue.rerun`, `root.WorkQueue.restart`
- `ExhaustAttempts`: `external.ExternalWorkService.claim`, `external.ExternalWorkTransport.claim`, `kernel.claimRecord`, `root.WorkQueue.claim`
- `ExhaustDeadline`: `external.ExternalWorkService.claim`, `external.ExternalWorkTransport.claim`, `kernel.claimRecord`, `root.WorkQueue.claim`
- `CreateChild`: `root.createWorkOnce.dispatch`, `root.createWorkOnce.runDispatcher`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#next`, `WorkDefinition<df9ebd876c09>|src/work.ts|0|df9ebd876c09#thenDo`
- `AckChild`: `root.createWorkOnce.dispatch`, `root.createWorkOnce.runDispatcher`
- `Tick`: **internal/time-only action**

## Coverage rule

The manifest is compiler-discovered. Any new public callable, reachable package-owned input/output/callback field, signature/type change, configured TLA invariant, or bound source/model semantic change fails assurance until this file and the machine-reviewed manifest are deliberately updated.
