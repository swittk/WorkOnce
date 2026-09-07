# WorkOnce

A small TypeScript durable-work kernel: typed jobs, crash-safe ownership, dynamic retry/wait
policies, cancellation and durable follow-up work. Bring your own storage. There is no WorkOnce
server to deploy.

This is the first reviewable implementation, not a claim that a finite test suite proves every
possible deployment. See [assurance](docs/assurance.md) and [storage](docs/storage.md).

## Define once, decide dynamically

```ts
import { createWorkOnce, exponentialBackoff } from '@workonce/core';
import { createSqliteStore } from '@workonce/core/sqlite';

const work = createWorkOnce({
  store: createSqliteStore('./work.sqlite'),
  scope: 'my-installation',
});

type Input = { assetId: string; urgent: boolean };
type Output = { derivativeId: string };
type Reason = 'provider_busy' | 'provider_pending' | 'invalid_source';

const normalBackoff = exponentialBackoff({
  initialDelayMs: 5_000,
  maxDelayMs: 60_000,
  maxRetries: 8,
});

const convert = work.define<Input, Output, Reason>('asset.convert', {
  executionLimits: (input) => ({
    leaseMs: input.urgent ? 30_000 : 60_000,
    maxAttempts: 100,
    maxElapsedMs: 3_600_000,
    maxDeferrals: 80,
  }),
  retry: (context) => {
    if (context.reason === 'invalid_source') {
      return { retry: false, manualRetry: false };
    }
    if (context.input.urgent) {
      return { retry: true, afterMs: 1_000, maxRetries: 20, manualRetry: true };
    }
    return normalBackoff(context);
  },
  perform: async (run, input) => {
    const status = await provider.inspect(input.assetId, { signal: run.signal });
    if (status.state === 'pending') return run.wait('provider_pending', { afterMs: 10_000 });
    if (status.state === 'busy')
      return run.retry('provider_busy', { afterMs: status.retryAfterMs });
    if (status.state === 'invalid') return run.fail('invalid_source', { manualRetry: false });
    return run.succeed({ derivativeId: status.derivativeId });
  },
});

await convert.ensure(
  { assetId: 'asset-123', urgent: true },
  {
    key: 'asset-123:source-revision-2',
  },
);
```

`executionLimits` accepts a static object or a synchronous per-input callback. It is resolved
when creating the request and its chosen values are persisted. These are execution safety budgets,
**not throughput throttles or rate limits**. `retry` and `wait` accept static policies or async
callbacks evaluated on the actual failure/wait. A result-level timing override changes scheduling,
not permission or the retry budget.

```ts
const checks = work.define<{ urgent: boolean }>('provider.check', {
  wait: async ({ input, deferrals }) => ({
    afterMs: input.urgent && deferrals < 3 ? 1000 : 30_000,
  }),
  retry: async ({ input, reason, retries }) =>
    reason === 'invalid'
      ? { retry: false, manualRetry: false }
      : {
          retry: true,
          afterMs: input.urgent ? 1000 : Math.min(5000 * 2 ** retries, 60_000),
          maxRetries: 10,
          manualRetry: true,
        },
});
// An actual handler may simply return run.wait('still_processing').
```

Callbacks stay in application code. Only their accepted decisions and resolved per-item limits
are stored. A retry callback may be async and fetch current policy; it must not perform side
effects. Ownership is checked again after it returns. Static policy objects work too.

## Vocabulary that says what it does

- `ensure(input)` = make sure this exact business work exists once; identical repeats return it.
- `runAvailable(options)` = run one bounded pass over work available now.
- `run(options)` = keep polling and running available work until its stop signal fires.
- `retry(reason)` = this attempt failed temporarily; count a retry and run it again later.
- `wait(reason)` = nothing failed; end this attempt, release the worker slot, and resume the work later.
- `fail(reason)` = terminal automatic failure; optional manual retry may still be allowed.
- `thenDo` = durable follow-up work created only after this terminal result is accepted.
- `heartbeat` = prove this worker still owns the attempt and extend its lease.
- `executionLimits` = per-work safety budgets such as lease duration, attempts, elapsed time and waits. It is **not** a throttle.

The low-level record still uses the distributed-systems term **fencing token** (`fence`). Treat the
attempt reference as opaque in normal application code. If worker A owns fence 17, its lease
expires, and worker B reclaims the work with fence 18, a late result from A still carries 17 and
is rejected because only 18 is current. Managed local/external runners carry this for you.

Conventional queue aliases remain available for compatibility: `enqueue` → `ensure`, `process` →
`runAvailable`, `defer` → `wait`, `renew` → `heartbeat`, `next` → `thenDo`, and `limits` →
`executionLimits`. Examples use the literal application-facing names above.

## Define the implementation once

`perform` is the canonical in-process implementation for this work kind. Define it once, then call
`runAvailable()` for one bounded pass over currently available work or `run()` for a continuous worker
without repeating the handler:

```ts
await convert.runAvailable({ workerId: 'worker-1', concurrency: 4 });

await convert.run({
  workerId: 'worker-1',
  concurrency: 4,
  signal: shutdown.signal,
});
```

Tests, migrations, or alternate deployments may still pass an explicit handler to `runAvailable()` or
`run()`; that handler overrides `perform` for that execution only. If neither a bound `perform` nor
an explicit handler exists, WorkOnce throws **before claiming any work**.

`run` inside `perform` is the current attempt, not a global or React context. Its four normal
outcomes are `succeed`, `retry`, `wait`, and `fail`.

A lost lease aborts `run.signal` conservatively. Pass that signal into HTTP/SDK calls when they
support `AbortSignal`. If a dependency does **not** support cancellation, you may ignore the signal:
WorkOnce safety does not depend on cooperative cancellation. The physical call may finish, but its
late outcome cannot settle after ownership moved to a newer attempt. External side effects still
need their own idempotency key or provider-side fencing because WorkOnce cannot unsend a request.
CPU-heavy synchronous work must not block the runtime responsible for heartbeats; put that work in
a Web Worker, worker thread, subprocess, or other executor. A thrown handler error is an
interruption, not a guessed retry policy.

## Manual retry, rerun, cancellation and inspection

Bind a business input once with `item()` when you do not want to repeat keys/generations at every
call site:

```ts
const item = convert.item({ assetId: 'asset-123', urgent: true }, 'asset-123:source-revision-2');
await item.ensure();
const current = await item.inspect();

if (current?.phase.state === 'failed' && current.phase.manualRetry) {
  await item.retry({
    check: async (snapshot) => canCurrentStaffRetry(snapshot.input.assetId),
  });
}

// Deliberately run an already-successful item again:
if (current?.phase.state === 'succeeded') {
  await item.rerun();
}

await item.cancel({ reason: 'source_withdrawn' });
```

`retry()` is for failed work; `rerun()` is for successful work. The generic `restart()` helper is
retained only for compatibility. Both commands are generation-checked internally, and neither may
erase undispatched durable follow-up work from the prior generation.

For bulk/operator views, `queue.inspectMany(keys)` preserves order and missing entries and
`queue.history(key)` returns recent durable transitions.

A `running` snapshot contains the saved lease. Compare `phase.attempt.leaseUntil` with
`observedAt` to show “lease expired; awaiting recovery” rather than an active spinner. A snapshot
is observational only; every mutation rechecks current ownership.

## Durable follow-ups, not lossy success hooks

```ts
const notify = work.define<{ derivativeId: string }>('asset.notify');

return run.succeed(
  { derivativeId },
  {
    thenDo: [
      notify.request(
        { derivativeId },
        {
          key: `converted:${run.ref.workId}:${run.ref.generation}`,
        },
      ),
    ],
  },
);
```

Success and the outbox intent commit together. The dispatcher inserts the child by its stable
key and then acknowledges the intent. A crash after child insertion does not create a second
logical child. A conflicting key is an error, not silent payload replacement.

Follow-up planning can also be declared once as an async callback on the work definition:

```ts
const convert = work.define<Input, Output>('asset.convert', {
  thenDo: async ({ result, attempt }) => [
    notify.request(
      { derivativeId: result.derivativeId },
      {
        key: JSON.stringify([attempt.workId, attempt.generation]),
      },
    ),
  ],
});
```

`thenDo` returns durable request data; it is **not** an effectful `onSuccess` callback. Identical
accepted outcome redelivery returns the saved receipt without re-running the planner. Losing
ownership while a planner awaits prevents the success/continuation commit.

Supervise `work.runDispatcher({ signal })` alongside your workers, or call
`work.dispatch({ limit: 100 })` from an existing periodic runner. Register a worker for the
child kind too. Delivery requires a running dispatcher and eventually available storage;
WorkOnce does not claim the child is emitted merely because the parent succeeded. Failed children remain pending; healthy siblings are still attempted, and bounded dispatch scans rotate past failed entries rather than permanently starving other work.

## Execute outside this runtime

External execution is **not a different kind of WorkOnce work**. It is another executor topology
over the same claim/heartbeat/settlement authority. A local worker and an external executor racing
the same item still compete for one current attempt.

The authoritative process calls `serveExternal()` on the ordinary work definition:

```ts
const service = convert.serveExternal({
  prepare: async (run) => {
    const source = await prepareSource(run.input.assetId);
    if (!source.ready) return run.wait('provider_pending', { afterMs: 10_000 });
    return run.handoff({ assetId: run.input.assetId, sourceUrl: source.url });
  },
  onPrepareError: (run) => run.retry('provider_busy'),
});

// Authenticated HTTP/RPC/IPC handlers forward only:
// service.ensure(...)
// service.claim(...)
// service.heartbeat(...)
// service.settle(...)
```

`prepare` does **not** mean the work succeeded. `wait`, `retry`, and `fail` are settled by the
authoritative process and never returned as external leases. Only `run.handoff(payload)` exports a
still-live attempt. That external executor must heartbeat and settle the exact attempt it received.
A stale external result is rejected by the same ownership token rules as a stale local result.

The executor side is transport-neutral. `runExternalAvailable()` performs one bounded claim pass;
`runExternal()` continuously refills capacity until its stop signal fires:

```ts
import { runExternal, runExternalAvailable } from '@workonce/core';

const transport = {
  claim: (request) => api.claim(request),
  heartbeat: (attempt) => api.heartbeat(attempt),
  settle: (attempt, outcome) => api.settle(attempt, outcome),
};
const performExternal = async (run, input) => {
  const result = await doExternalWork(input, { signal: run.signal });
  return run.succeed(result);
};

await runExternalAvailable(
  transport,
  { workerId: 'gpu-once', concurrency: 4, signal: shutdown.signal },
  performExternal,
);

await runExternal(
  transport,
  { workerId: 'gpu-1', concurrency: 4, signal: shutdown.signal },
  performExternal,
);
```

Python or another language implements the same tiny `claim / heartbeat / settle` wire contract.
WorkOnce owns no HTTP framework, authentication mechanism, serialization format, or process
launcher. The attempt reference is opaque transport data, **not** an authentication credential.

There is deliberately **no** `settle(ref, async () => writeDomainRows())`. Checking ownership
before an unrelated write cannot make that later write fenced. Use a shared transaction where the
storage system truly supports it, or make application/external effects idempotent and recoverable.

## What is bounded

All times are integer Unix **milliseconds**, all durations are milliseconds. `afterMs` and `at`
are mutually exclusive. Result-level timing overrides do not bypass denied retries or budgets.

`maxAttempts` counts every claim, including crashed workers and deferred checks. `maxRetries`
counts accepted automatic retry decisions only. `maxDeferrals` counts accepted non-failure waits only.
`maxElapsedMs` starts at the generation's first claim and also caps heartbeat lease extension. Manual retry
starts a new generation; the fence never resets. Configure these bounds for long polling rather
than expecting waits to be unlimited.

Repeated `ensure()` with the same scope/kind/key and input/limits returns the existing item and
never restarts it. Changed payload or limits require a new business key. Definition `version`
(default `1`) prevents silently claiming work with a different deployed handler contract; retain
matching workers while draining an older version. No implicit migration is provided.

Only the latest settled attempt receipt is retained. An identical redelivery gets that exact
receipt without rerunning policy. Once a newer receipt or generation replaces it, the old
callback is rejected. Use application idempotency where longer receipt retention is required.

No DAG engine, cron interpreter, workflow replay, global rate limiter or built-in broker. No
“exactly once” external effects. No row deletion/ID reuse API: that would need a deliberate
fence/tombstone retention contract.

## Exhaustive formal implementation mapping

WorkOnce's assurance is not limited to a hand-written TLA diagram. The compiler-generated manifest maps every public callable and every reachable package-owned input/output/callback field to reviewed semantic classifications, model concepts and executable evidence. A current full run maps 124 callables, 21 callable policy/storage fields and 333 fields, then executes 31 deterministic refinement scenarios plus 96 seeded ten-step traces before one 135,366-state TLC graph check. See [assurance](docs/assurance.md).

## ES2018 and Web Workers

The whole package is emitted at an **ES2018** syntax target. The default `@workonce/core` import graph
is additionally compiled in CI with only `ES2018 + WebWorker` libraries and **no Node ambient
types**. It may not import Node builtins or third-party runtime packages, and assurance enforces a
96 KiB raw / 24 KiB gzip root-runtime budget. The current graph is comfortably below that budget.

The default runtime uses standard worker/browser primitives: Promises, timers, `performance.now()`,
`TextEncoder`, Web Crypto `crypto.subtle`, and `AbortController`. ES2018 output does not polyfill a
missing Web API; polyfill `AbortController` in an older WebKit build if that specific environment
lacks it. The optional `/sqlite` subpath is intentionally **Node-only (Node >= 22.16)** because it imports
`node:sqlite`; importing the default package does not pull it into a browser or Web Worker bundle.

## One adapter per backing store, not per job

The application supplies its store **once**, and every work kind shares it. Job definitions do
not explain how to load their domain rows or persist queue fields. WorkOnce has no Parse types,
ORM dependency, HTTP framework or bundled database driver.

- `/memory`: non-durable reference implementation.
- `/sqlite`: local-file SQLite with WAL/FULL commits and independent-process tests.
- `/cas`: framework-free adapter builder over native read/query/compare-and-swap operations.
- `/storage`: the full atomic contract; `/conformance`: shared adversarial adapter scenarios.
- `/kernel`: pure transitions for adapter and refinement work.

```ts
import { createCompareExchangeStore } from '@workonce/core/cas';

const store = createCompareExchangeStore({
  getMany: nativeStore.readManyWithStorageTime,
  query: nativeStore.queryIndexedWork,
  compareExchange: nativeStore.replaceIfRevisionAndDeadlineMatch,
});
const work = createWorkOnce({ store, scope: 'my-installation' });
const mail = work.define<MailInput>('mail');
const cleanup = work.define<CleanupInput>('cleanup');
```

`nativeStore` is your application's implementation of the documented port, not a bundled helper.
Its compare-and-swap must check both the expected revision and `validUntil` **at the actual
storage write**. No process-local mutex, expiring-lock fallback or unconditional ORM save can
substitute for that contract. Unknown write acknowledgements propagate as errors; they are not
blindly retried as though no write occurred. See [storage](docs/storage.md).

The old `/embedded` API has been removed. Keeping a separate queue machine in each feature's
domain row was the wrong default topology. An application may share a transaction with its
own domain data, but it should not rewrite a storage adapter for each job.

```sh
npm ci
TLA2TOOLS_JAR=/path/to/tla2tools.jar npm run assurance

# Individual gates remain available:
npm run assurance:manifest
npm run assurance:traces
npm run formal
```

ESM and CommonJS are built from clean output directories at the ES2018 target. Runtime core has no
third-party dependencies. Only the optional `/sqlite` entry imports Node's `node:sqlite`.
The [benchmark](docs/performance.md) records a measured SQLite control-plane baseline, not a
promise that every application or BYO adapter became faster.
