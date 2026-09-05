# Initial measured baseline

Measured 2026-09-05T11:38:09.103Z on Node v22.22.1, Linux x64, using a real local SQLite
file with WAL and `synchronous=FULL`. The machine was shared with other development work.

Each of three trials enqueued 1,000 small JSON jobs, claimed them in batches of 32, and
persisted successful settlement for every job. No handler IO, retry failures, or lease
heartbeats were included. This measures control-plane overhead, not application throughput.

| Median across three trials           |      Result |
| ------------------------------------ | ----------: |
| Enqueue 1,000 jobs                   |    375.1 ms |
| Claim and settle those jobs          |    614.1 ms |
| Complete enqueue/claim/settle cycles | 1011 jobs/s |

Observed complete-cycle rates ranged from 864 to
1112 jobs/s. Reproduce with `npm run bench`.
Results depend on disk, durability settings, payload/history size and contention. This is
**not** evidence that a particular application's existing queue became faster, or that
all BYO adapters have the same performance. Native bulk claim/renew optimization remains
possible behind conformance; this first facade uses a bounded query and per-item atomic
operations.
