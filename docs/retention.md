# Finite terminal retention

Finite retention is a normal opt-in work policy, not an unsafe escape hatch. Execution durability
and how long the queue remembers completed work are separate choices. The default remains
permanent retention for existing definitions and rows.

## Public contract

Set `retention: { afterTerminalMs: duration }` on a definition or an individual `ensure`/`enqueue`
request. Durations are nonnegative safe-integer milliseconds. Zero is permitted. Use `'forever'`
to override a finite definition for one item. The normalized policy is persisted with the request
and participates in request equality; changing defaults never silently changes old work.

`work.prune({ limit })` or `queue.prune({ limit })` performs one bounded pass and returns the number
of physical deletions. `work.runPruner({ signal, intervalMs, limit, onError })` supervises periodic
passes until aborted; it installs no global timer, and errors propagate unless an error handler
is supplied. Maintenance must run often enough to keep up with completed work. Live queued work
still requires workers, cancellation or application policy; retention does not discard it.

A terminal item becomes eligible at its completion timestamp plus its finite duration, and only
when its outbox is empty. Reads/replays do not move that deadline. An outbox acknowledgement can
make an already-expired terminal item eligible immediately. Eligibility is checked using storage
time again at deletion, so an indexed candidate is not deletion authority. An extreme duration is
saturated to the maximum safe timestamp instead of causing a valid settlement to fail.

Before physical deletion, ordinary inspect/deduplication/replay behavior remains. Afterwards the
item is absent and the key can be reused. There is no hidden tombstone and no claim of unlimited
receipt retention. A later producer or durable follow-up redelivery may legitimately create new
work after the deduplication horizon ends. Pending follow-ups protect their parent from deletion,
not all downstream work from every future producer indefinitely.

## Creation identity and races

Finite records get a random 128-bit `incarnation` allocated once outside the retryable atomic
callback. Inert follow-up descriptions remain deterministic and contain no creation nonce.
Incarnation stays fixed through retries and reruns. Worker references carry incarnation alongside
work ID, generation and fence. Missing or mismatched incarnation cannot renew, settle or replay a
finite item, even if a different creation repeats those numeric counters.

A stale prune candidate checks incarnation plus revision before deletion. CAS-capable stores check
the same creation identity on replacements as well as deletes; revision alone is insufficient.
Async manual approval callbacks bind both the observed revision and incarnation. Explicit
`retry`, `rerun`, `cancel` and `wake` commands supply `incarnation` from their snapshot. Current-key
commands may intentionally act on the current item; when `expectedGeneration` is supplied for
finite work, also supply `expectedIncarnation`. Item-level convenience methods forward the identity
from their own read and reject a recreation racing that read.

Old dispatcher acknowledgements and stale claim candidates cannot mutate a new incarnation. The
queue still cannot stop an external HTTP request already sent by an old worker: external effects
retain the same domain/provider idempotency requirements as permanent work.

## Storage support and bounded growth

A store explicitly advertises `retention: true`. Unsupported stores reject finite requests and
prune calls. There is no implicit scan-and-delete fallback. Native expiry discovery uses bounded
indexed queries. Deletion goes through the store's serialized or native conditional write path,
not a background database TTL racing live state changes. Retention-capable CAS ports need both
incarnation-aware replacement and conditional physical deletion.

The memory store removes entries; SQLite removes rows/index entries. SQLite may retain freed
pages in its database file for reuse, so file length need not immediately shrink. Reusing freed
pages bounds steady-state growth under a stable workload without vacuuming after each job.
Database vacuum/checkpoint policy remains application-owned. Domain data, logs, backups and
external files are outside queue record retention and have their own lifecycle.

Third-party adapters must remove their auxiliary per-job records too and recover interrupted
cleanup safely. A permanent synchronization anchor per retired key would still accumulate without
bound and is not an adequate implementation of this contract. The core does not claim that an
adapter supports deletion merely because it can remove its visible job payload.
