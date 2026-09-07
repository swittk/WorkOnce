import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRemoteWorkService, createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
import { processRemoteWork, runRemoteWorker } from '../dist/remote.js';

function fixture(options = {}) {
  const work = createWorkOnce({ store: createMemoryStore(), scope: options.scope ?? 'remote' });
  const queue = work.define('job', { limits: { leaseMs: options.leaseMs ?? 300 } });
  const transport = createRemoteWorkService(
    queue,
    (run) => run.handoff(run.input),
    (run) => run.fail('prepare_failed'),
  );
  return { work, queue, transport };
}

test('remote worker runner hides claim heartbeat and settlement plumbing from handlers', async () => {
  const { queue, transport } = fixture({ leaseMs: 180 });
  for (let index = 0; index < 3; index++) {
    await transport.ensure({ index }, { key: String(index) });
    await transport.ensure({ index }, { key: String(index) });
  }
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

test('remote worker options reject invalid heartbeat before any lease is claimed', async () => {
  const { transport: base } = fixture();
  let claims = 0;
  const transport = {
    ...base,
    claim(request) {
      claims++;
      return base.claim(request);
    },
  };
  const signal = new AbortController().signal;
  await assert.rejects(
    processRemoteWork(transport, { workerId: 'relay', heartbeatMs: 0, signal }, async (run) =>
      run.succeed(),
    ),
    /heartbeatMs/,
  );
  await assert.rejects(
    runRemoteWorker(transport, { workerId: 'relay', heartbeatMs: 1.5, signal }, async (run) =>
      run.succeed(),
    ),
    /heartbeatMs/,
  );
  assert.equal(claims, 0);
});

test('authoritative remote service never returns more than the requested claim limit', async () => {
  const { transport } = fixture();
  for (let index = 0; index < 3; index++) await transport.ensure({ index }, { key: String(index) });
  const first = await transport.claim({ workerId: 'relay', limit: 2 });
  assert.equal(first.length, 2);
  const second = await transport.claim({ workerId: 'relay', limit: 2 });
  assert.equal(second.length, 1);
});

test('managed remote runner rethrows the original claim failure when no observer exists', async () => {
  const { transport: base } = fixture();
  const failure = new Error('original claim failure');
  const transport = {
    ...base,
    async claim() {
      throw failure;
    },
  };
  await assert.rejects(
    runRemoteWorker(
      transport,
      { workerId: 'relay', signal: new AbortController().signal },
      async (run) => run.succeed(),
    ),
    (error) => error === failure,
  );
});

test('managed remote runner passes shutdown signal into an in-flight claim', async () => {
  const { transport: base } = fixture();
  const stop = new AbortController();
  let receivedSignal;
  const transport = {
    ...base,
    claim(request) {
      receivedSignal = request.signal;
      return new Promise((resolve, reject) => {
        if (request.signal?.aborted) return reject(request.signal.reason);
        request.signal?.addEventListener('abort', () => reject(request.signal.reason), {
          once: true,
        });
      });
    },
  };
  const running = runRemoteWorker(
    transport,
    { workerId: 'relay', signal: stop.signal },
    async (run) => run.succeed(),
  );
  await sleep(10);
  stop.abort(new Error('shutdown'));
  await running;
  assert.equal(receivedSignal, stop.signal);
});

test('caller abort stops new remote claims and drains an already-active handler', async () => {
  const { queue, transport: base } = fixture({ leaseMs: 1000 });
  await queue.enqueue({ id: 'slow' }, { key: 'slow' });
  const stop = new AbortController();
  let claims = 0;
  const transport = {
    ...base,
    claim(request) {
      claims++;
      return base.claim(request);
    },
  };
  let finished = false;
  const running = runRemoteWorker(
    transport,
    { workerId: 'relay', concurrency: 1, signal: stop.signal },
    async (run) => {
      await sleep(60);
      finished = true;
      return run.succeed();
    },
  );
  await sleep(15);
  stop.abort(new Error('shutdown'));
  await running;
  assert.equal(finished, true);
  assert.equal(claims, 1);
  assert.equal((await queue.inspect('slow')).phase.state, 'running');
});
