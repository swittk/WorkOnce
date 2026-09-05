# WorkOnce

A small TypeScript durable-work kernel: typed jobs, current-attempt fencing, dynamic retries,
manual retry gates, deferred checks, cancellation and durable follow-up work. Bring your own
storage. There is no WorkOnce server to deploy.

This is the first reviewable implementation, not a claim that a finite test suite proves every
possible deployment. See [assurance](docs/assurance.md) and [storage](docs/storage.md).

## Define once, decide dynamically

```ts
import { createWorkOnce } from '@workonce/core';
import { createSqliteStore } from '@workonce/core/sqlite';

const work = createWorkOnce({
  store: createSqliteStore('./work.sqlite'),
  scope: 'my-installation',
});

type Input = { assetId: string; urgent: boolean };
type Output = { derivativeId: string };
type Reason = 'provider_busy' | 'provider_pending' | 'invalid_source';

const convert = work.define<Input, Output, Reason>('asset.convert', {
  limits: {
    leaseMs: 60_000,
    maxAttempts: 100,
    maxElapsedMs: 3_600_000,
    maxDeferrals: 80,
  },
  retry: ({ input, reason, retries }) => {
    if (reason === 'invalid_source') {
      return { retry: false, manualRetry: false };
    }
    return {
      retry: true,
      afterMs: input.urgent ? 1000 : Math.min(5000 * 2 ** retries, 60_000),
      maxRetries: input.urgent ? 20 : 8,
      manualRetry: true,
    };
  },
});

await convert.enqueue(
  { assetId: 'asset-123', urgent: true },
  {
    key: 'asset-123:source-revision-2',
  },
);
```

Callbacks stay in application code. Only their accepted decisions and resolved per-item limits
are stored. A retry callback may be async and fetch current policy; it must not perform side
effects. Ownership is checked again after it returns. Static policy objects work too.

## Four readable outcomes

`run` is the current attempt, not a global or React context. Outcome helpers return data;
the runner performs the guarded commit.

```ts
await convert.process({ workerId: 'worker-1', concurrency: 4 }, async (run, input) => {
  // Application/provider-specific code. Start-or-find must itself be retry safe.
  const remote = await provider.inspect(input.assetId, { signal: run.signal });

  if (remote.state === 'pending') {
    return run.defer('provider_pending', { afterMs: 10_000 });
  }
  if (remote.state === 'busy') {
    return run.retry('provider_busy', { afterMs: remote.retryAfterMs });
  }
  if (remote.state === 'invalid') {
    return run.fail('invalid_source', { manualRetry: false });
  }
  return run.succeed({ derivativeId: remote.derivativeId });
});
```

`provider` above is your application service, not a WorkOnce API. For a continuously running
worker, use `convert.run({ workerId, concurrency, signal }, handler)`. Each local slot is
refilled independently. Run more worker processes against the **same durable store** without
changing handler code. `concurrency` is per runner, not a global fleet quota.

A lease loss aborts `run.signal` conservatively. Cancellation cannot forcibly stop an arbitrary
function or unsend an HTTP request. CPU-heavy work must not block the runtime responsible for
heartbeats. A thrown handler error is reported as an interruption; it is not silently guessed
to be retryable. Lease recovery still consumes the total claim budget.

## Manual retry, cancellation and inspection

```ts
const current = await convert.inspect('asset-123:source-revision-2');
if (current?.phase.state === 'failed' && current.phase.manualRetry) {
  await convert.retry({
    key: current.key,
    generation: current.generation,
    check: async (snapshot) => canCurrentStaffRetry(snapshot.input.assetId),
  });
}

const page = await convert.inspectMany(keys); // preserves order and missing entries
const recentHistory = await convert.history(key); // last 128 transitions
```

The manual retry gate is re-evaluated at action time, and its observed revision/generation is
checked again at commit. A second click for the same failed generation cannot restart a later
generation. A stored `manualRetry: false` is not bypassed by a callback returning true.
Application authorization and checks involving other domain rows still need their own atomic
boundary; this check does not lock another database.

`cancel({ key, generation, reason })` revokes an unfinished attempt. Already succeeded, failed
or cancelled items stay terminal; the returned snapshot says what actually happened.
`wake({ key, generation, revision })` advances queued/deferred work after an application-owned
prerequisite is revalidated. It is not a generic `force` override.

A `running` snapshot contains the saved lease. Compare `phase.attempt.leaseUntil` with
`observedAt` to show “lease expired; awaiting recovery” rather than an active spinner. A
snapshot is not a permission to write: mutations always recheck current ownership.

Failure `reason` keeps the application cause. `stoppedBy` separately explains policy denial,
retry exhaustion, total-attempt exhaustion or deadline expiry.

## Durable follow-ups, not lossy success hooks

```ts
const notify = work.define<{ derivativeId: string }>('asset.notify');

return run.succeed(
  { derivativeId },
  {
    next: [
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

Supervise `work.runDispatcher({ signal })` alongside your workers, or call
`work.dispatch({ limit: 100 })` from an existing periodic runner. Register a worker for the
child kind too. Delivery requires a running dispatcher and eventually available storage;
WorkOnce does not claim the child is emitted merely because the parent succeeded.

## Remote/Python workers

`queue.claim({ workerId, limit })` returns attempts with `.input`, `.ref`, `.attempt` and
`.observedAt`. `JSON.stringify(run)` exposes only input, attempt and observed store time.
Your authenticated endpoint can send that wire object without serializing adapter internals.

Use `queue.renew(ref)` and `queue.settle(ref, outcome)` in the authenticated backend. Static
outcome helpers `succeed`, `retry`, `defer`, `fail` are exported for these endpoints. Validate
untrusted wire payloads in your transport. An attempt reference is **not** an authentication
token, and client-supplied worker IDs do not grant authority.

There is deliberately **no** `settle(ref, async () => writeDomainRows())`. A lease precheck
cannot make subsequent arbitrary writes safe. Use a shared transaction/embedded commit or
application-owned idempotency and recovery instead.

## What is bounded

All times are integer Unix **milliseconds**, all durations are milliseconds. `afterMs` and `at`
are mutually exclusive. Result-level timing overrides do not bypass denied retries or budgets.

`maxAttempts` counts every claim, including crashed workers and deferred checks. `maxRetries`
counts accepted automatic retry decisions only. `maxDeferrals` counts accepted waits only.
`maxElapsedMs` starts at the generation's first claim and also caps lease renewal. Manual retry
starts a new generation; the fence never resets. Configure these bounds for long polling rather
than expecting waits to be unlimited.

Repeated enqueue with the same scope/kind/key and input/limits returns the existing item and
never restarts it. Changed payload or limits require a new business key. Definition `version`
(default `1`) prevents silently claiming work with a different deployed handler contract; retain
matching workers while draining an older version. No implicit migration is provided.

Only the latest settled attempt receipt is retained. An identical redelivery gets that exact
receipt without rerunning policy. Once a newer receipt or generation replaces it, the old
callback is rejected. Use application idempotency where longer receipt retention is required.

No DAG engine, cron interpreter, workflow replay, global rate limiter or built-in broker. No
“exactly once” external effects. No row deletion/ID reuse API: that would need a deliberate
fence/tombstone retention contract.

## Adapters and development

- `/memory`: reference implementation, not durable and not cross-process.
- `/sqlite`: real local-file SQLite, WAL and FULL synchronous commits; tested with independent
  OS processes and process death. It serializes SQLite writes; it is not a distributed database.
- `/embedded`: helper for storing work in an existing application row. The caller must supply
  and prove the serialization boundary. A process mutex supports **one backend process**, even
  when many remote workers call that backend. It is not multi-replica certification.
- `/storage`: the BYO storage contract; `/conformance`: reusable adversarial scenarios.
- `/kernel`: pure transition functions for specialized adapters and refinement tests.

There are no bundled MongoDB, PostgreSQL or Redis adapters in this first version. Do not infer
their guarantees from the SQLite tests.

```sh
npm ci
npm run check
npm test
npm run test:process
npm run test:consumer
TLA2TOOLS_JAR=/path/to/tla2tools.jar npm run formal
```

ESM and CommonJS are both built. Runtime core has no third-party dependencies. SQLite uses
Node's `node:sqlite`; the reference and embedded adapters do not import it.

The [initial benchmark](docs/performance.md) records measured SQLite control-plane cost, not a promised application speedup.
