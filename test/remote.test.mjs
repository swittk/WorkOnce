import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
import { processRemoteWork, runRemoteWorker } from '../dist/remote.js';

function fixture(options = {}) {
  const work = createWorkOnce({ store: createMemoryStore(), scope: options.scope ?? 'remote' });
  const queue = work.define('job', { limits: { leaseMs: options.leaseMs ?? 300 } });
  const transport = {
    claim: (request) =>
      queue.handoff(
        request,
        (run) => run.handoff(run.input),
        (run) => run.fail('prepare_failed'),
      ),
    renew: async (attempt) => {
      const renewed = await queue.renew(attempt);
      return { leaseUntil: renewed.attempt.leaseUntil, observedAt: renewed.observedAt };
    },
    settle: (attempt, outcome) => queue.settle(attempt, outcome),
  };
  return { work, queue, transport };
}

test('remote worker runner hides claim heartbeat and settlement plumbing from handlers', async () => {
  const { queue, transport } = fixture({ leaseMs: 180 });
  for (let index = 0; index < 3; index++) await queue.enqueue({ index }, { key: String(index) });
  let active = 0;
  let peak = 0;
  const results = await processRemoteWork(
    transport,
    { workerId: 'relay', concurrency: 3, heartbeatMs: 40, signal: new AbortController().signal },
    async (run, input) => {
      active++;
      peak = Math.max(peak, active);
      await sleep(260);
      run.signal.throwIfAborted();
      active--;
      return run.succeed({ handled: input.index });
    },
  );
  assert.equal(peak, 3);
  assert.ok(results.every((result) => result.status === 'settled'));
  for (let index = 0; index < 3; index++)
    assert.equal((await queue.inspect(String(index))).phase.state, 'succeeded');
});

test('remote renewal failure aborts the handler before it can report success', async () => {
  const { queue, transport: base } = fixture({ leaseMs: 250 });
  await queue.enqueue(null, { key: 'x' });
  let renewCalls = 0;
  const transport = {
    ...base,
    async renew(attempt) {
      renewCalls++;
      if (renewCalls === 1) throw new Error('network unavailable');
      return base.renew(attempt);
    },
  };
  let sawAbort = false;
  const [result] = await processRemoteWork(
    transport,
    { workerId: 'relay', heartbeatMs: 25, signal: new AbortController().signal },
    async (run) => {
      await sleep(80);
      sawAbort = run.signal.aborted;
      return run.succeed();
    },
  );
  assert.equal(sawAbort, true);
  assert.equal(result.status, 'interrupted');
  assert.equal((await queue.inspect('x')).phase.state, 'running');
});

test('managed remote runner refills freed slots and drains active work before observer failure escapes', async () => {
  const { queue, transport: base } = fixture({ leaseMs: 1000 });
  await queue.enqueue({ id: 'slow' }, { key: 'slow' });
  let claimCalls = 0;
  const transport = {
    ...base,
    async claim(request) {
      claimCalls++;
      if (claimCalls > 1) throw new Error('poll failed');
      return base.claim(request);
    },
  };
  const stop = new AbortController();
  let finished = false;
  await assert.rejects(
    runRemoteWorker(
      transport,
      {
        workerId: 'relay',
        concurrency: 2,
        signal: stop.signal,
        onError: async () => {
          throw new Error('observer failed');
        },
      },
      async (run) => {
        await sleep(60);
        finished = true;
        return run.succeed();
      },
    ),
    /observer failed/,
  );
  assert.equal(finished, true);
  assert.equal((await queue.inspect('slow')).phase.state, 'succeeded');
  stop.abort();
});
