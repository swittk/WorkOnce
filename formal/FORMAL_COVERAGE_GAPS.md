# Formal implementation coverage

- Public callables: **119**
- Callable policy/storage fields: **13**
- Reachable package-owned types: **99**
- Reachable package-owned fields: **309**
- Maximum recursive type depth: **7**
- Truncated public types: **0**

## Model actions

- `Claim`: `kernel.claimRecord`, `remote.RemoteWorkService.claim`, `remote.RemoteWorkTransport.claim`, `remote.createRemoteWorkService.claim`, `remote.processRemoteWork`, `remote.runRemoteWorker`, `root.WorkQueue.claim`, `root.WorkQueue.handoff`, `root.WorkQueue.process`, `root.WorkQueue.run`, `root.createRemoteWorkService.claim`, `root.processRemoteWork`, `root.runRemoteWorker`
- `Renew`: `kernel.renewRecord`, `remote.RemoteWorkService.renew`, `remote.RemoteWorkTransport.renew`, `remote.createRemoteWorkService.renew`, `remote.processRemoteWork`, `remote.runRemoteWorker`, `root.WorkQueue.handoff`, `root.WorkQueue.process`, `root.WorkQueue.renew`, `root.WorkQueue.run`, `root.WorkRun.renew`, `root.createRemoteWorkService.renew`, `root.processRemoteWork`, `root.runRemoteWorker`
- `Success`: `kernel.settleRecord`, `remote.RemoteWorkRun.succeed`, `remote.RemoteWorkService.settle`, `remote.RemoteWorkTransport.settle`, `remote.createRemoteWorkService.settle`, `remote.processRemoteWork`, `remote.runRemoteWorker`, `root.RemoteWorkRun.succeed`, `root.WorkQueue.handoff`, `root.WorkQueue.process`, `root.WorkQueue.run`, `root.WorkQueue.settle`, `root.WorkRun.settle`, `root.WorkRun.succeed`, `root.createRemoteWorkService.settle`, `root.processRemoteWork`, `root.runRemoteWorker`, `root.succeed`
- `Fail`: `kernel.settleRecord`, `remote.RemoteWorkRun.fail`, `remote.RemoteWorkService.settle`, `remote.RemoteWorkTransport.settle`, `remote.createRemoteWorkService.settle`, `remote.processRemoteWork`, `remote.runRemoteWorker`, `root.RemoteWorkRun.fail`, `root.WorkQueue.handoff`, `root.WorkQueue.process`, `root.WorkQueue.run`, `root.WorkQueue.settle`, `root.WorkRun.fail`, `root.WorkRun.settle`, `root.createRemoteWorkService.settle`, `root.fail`, `root.processRemoteWork`, `root.runRemoteWorker`
- `Retry`: `kernel.settleRecord`, `remote.RemoteWorkRun.retry`, `remote.RemoteWorkService.settle`, `remote.RemoteWorkTransport.settle`, `remote.createRemoteWorkService.settle`, `remote.processRemoteWork`, `remote.runRemoteWorker`, `root.RemoteWorkRun.retry`, `root.WorkQueue.handoff`, `root.WorkQueue.process`, `root.WorkQueue.run`, `root.WorkQueue.settle`, `root.WorkRun.retry`, `root.WorkRun.settle`, `root.createRemoteWorkService.settle`, `root.processRemoteWork`, `root.retry`, `root.runRemoteWorker`, `WorkDefinition<df9ebd876c09>|src/work.ts|1147|df9ebd876c09#retry`
- `Defer`: `kernel.settleRecord`, `remote.RemoteWorkRun.defer`, `remote.RemoteWorkService.settle`, `remote.RemoteWorkTransport.settle`, `remote.createRemoteWorkService.settle`, `remote.processRemoteWork`, `remote.runRemoteWorker`, `root.RemoteWorkRun.defer`, `root.WorkQueue.handoff`, `root.WorkQueue.process`, `root.WorkQueue.run`, `root.WorkQueue.settle`, `root.WorkRun.defer`, `root.WorkRun.settle`, `root.createRemoteWorkService.settle`, `root.defer`, `root.processRemoteWork`, `root.runRemoteWorker`, `WorkDefinition<df9ebd876c09>|src/work.ts|1147|df9ebd876c09#defer`
- `Cancel`: `kernel.cancelRecord`, `root.WorkItem.cancel`, `root.WorkQueue.cancel`, `root.WorkQueue.cancelCurrent`
- `Wake`: `root.WorkItem.wake`, `root.WorkQueue.wake`, `root.WorkQueue.wakeCurrent`
- `ManualRetry`: `kernel.retryRecord`, `root.WorkItem.restart`, `root.WorkQueue.restart`, `root.WorkQueue.retry`
- `Rerun`: `kernel.rerunRecord`, `root.WorkItem.restart`, `root.WorkQueue.rerun`, `root.WorkQueue.restart`
- `ExhaustAttempts`: `kernel.claimRecord`, `remote.RemoteWorkService.claim`, `remote.RemoteWorkTransport.claim`, `remote.createRemoteWorkService.claim`, `root.WorkQueue.claim`, `root.createRemoteWorkService.claim`
- `ExhaustDeadline`: `kernel.claimRecord`, `remote.RemoteWorkService.claim`, `remote.RemoteWorkTransport.claim`, `remote.createRemoteWorkService.claim`, `root.WorkQueue.claim`, `root.createRemoteWorkService.claim`
- `CreateChild`: `root.createWorkOnce.dispatch`, `root.createWorkOnce.runDispatcher`, `WorkDefinition<df9ebd876c09>|src/work.ts|1147|df9ebd876c09#next`
- `AckChild`: `root.createWorkOnce.dispatch`, `root.createWorkOnce.runDispatcher`
- `Tick`: **internal/time-only action**

## Coverage rule

The manifest is compiler-discovered. Any new public callable, reachable package-owned input/output/callback field, signature/type change, configured TLA invariant, or bound source/model semantic change fails assurance until this file and the machine-reviewed manifest are deliberately updated.
