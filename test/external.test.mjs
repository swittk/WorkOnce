import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createWorkOnce } from '../dist/index.js';
import { createMemoryStore } from '../dist/memory.js';
import { processExternal, runExternal } from '../dist/external.js';

function fixture(options = {}) {
  const work = createWorkOnce({ store: createMemoryStore(), scope: options.scope ?? 'external' });
  const queue = work.define('job', { executionLimits: { leaseMs: options.leaseMs ?? 300 } });
  const transport = queue.serveExternal({
    prepare: (run) => run.handoff(run.input),
    onPrepareError: (run) => run.fail('prepare_failed'),
  });
  return { work, queue, transport };
}

test('external worker runner hides claim heartbeat and settlement plumbing from handlers', async () => {
  const { queue, transport } = fixture({ leaseMs: 180 });
  for (let index = 0; index < 3; index++) {
    await transport.ensure({ index }, { key: String(index) });
    await transport.ensure({ index }, { key: String(index) });
  }
  let active = 0;
  let peak = 0;
  const results = await processExternal(
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

test('external claim response latency cannot extend authoritative ownership', async () => {
  const { queue, transport: base } = fixture({ leaseMs: 80 });
  await queue.enqueue(null, { key: 'x' });
  const transport = {
    ...base,
    async claim(request) {
      const leases = await base.claim(request);
      await sleep(120);
      return leases;
    },
  };
  let effects = 0;
  const [result] = await processExternal(
    transport,
    { workerId: 'relay', heartbeatMs: 20, signal: new AbortController().signal },
    async (run) => {
      effects++;
      return run.succeed();
    },
  );
  assert.equal(effects, 0);
  assert.equal(result.status, 'interrupted');
  assert.equal((await queue.inspect('x')).phase.state, 'running');
});

test('external heartbeat failure aborts the handler before it can report success', async () => {
  const { queue, transport: base } = fixture({ leaseMs: 250 });
  await queue.enqueue(null, { key: 'x' });
  let heartbeatCalls = 0;
  const transport = {
    ...base,
    async heartbeat(attempt) {
      heartbeatCalls++;
      if (heartbeatCalls === 1) throw new Error('network unavailable');
      return base.heartbeat(attempt);
    },
  };
  let sawAbort = false;
  const [result] = await processExternal(
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

test('managed external runner refills freed slots and drains active work before observer failure escapes', async () => {
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
    runExternal(
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

test('external worker options reject invalid heartbeat before any lease is claimed', async () => {
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
    processExternal(transport, { workerId: 'relay', heartbeatMs: 0, signal }, async (run) =>
      run.succeed(),
    ),
    /heartbeatMs/,
  );
  await assert.rejects(
    runExternal(transport, { workerId: 'relay', heartbeatMs: 1.5, signal }, async (run) =>
      run.succeed(),
    ),
    /heartbeatMs/,
  );
  assert.equal(claims, 0);
});

test('authoritative external service never returns more than the requested claim limit', async () => {
  const { transport } = fixture();
  for (let index = 0; index < 3; index++) await transport.ensure({ index }, { key: String(index) });
  const first = await transport.claim({ workerId: 'relay', limit: 2 });
  assert.equal(first.length, 2);
  const second = await transport.claim({ workerId: 'relay', limit: 2 });
  assert.equal(second.length, 1);
});

test('external workers reject oversized claim responses before starting handlers', async () => {
  async function oversizedTransport() {
    const { transport: base } = fixture({ leaseMs: 1000 });
    await base.ensure({ id: 'a' }, { key: 'a' });
    await base.ensure({ id: 'b' }, { key: 'b' });
    return {
      ...base,
      claim(request) {
        return base.claim({ ...request, limit: 2 });
      },
    };
  }

  let processStarted = 0;
  await assert.rejects(
    processExternal(
      await oversizedTransport(),
      { workerId: 'relay', concurrency: 1, signal: new AbortController().signal },
      async (run) => {
        processStarted++;
        return run.succeed();
      },
    ),
    /more leases than requested/,
  );
  assert.equal(processStarted, 0);

  let runStarted = 0;
  await assert.rejects(
    runExternal(
      await oversizedTransport(),
      { workerId: 'relay', concurrency: 1, signal: new AbortController().signal },
      async (run) => {
        runStarted++;
        return run.succeed();
      },
    ),
    /more leases than requested/,
  );
  assert.equal(runStarted, 0);
});

test('managed external runner rethrows the original claim failure when no observer exists', async () => {
  const { transport: base } = fixture();
  const failure = new Error('original claim failure');
  const transport = {
    ...base,
    async claim() {
      throw failure;
    },
  };
  await assert.rejects(
    runExternal(
      transport,
      { workerId: 'relay', signal: new AbortController().signal },
      async (run) => run.succeed(),
    ),
    (error) => error === failure,
  );
});

test('managed external runner passes shutdown signal into an in-flight claim', async () => {
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
  const running = runExternal(transport, { workerId: 'relay', signal: stop.signal }, async (run) =>
    run.succeed(),
  );
  await sleep(10);
  stop.abort(new Error('shutdown'));
  await running;
  assert.equal(receivedSignal, stop.signal);
});

test('caller abort stops new external claims and drains an already-active handler', async () => {
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
  const running = runExternal(
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

test('serveExternal exports only a live handoff and settles local wait outcomes before returning', async () => {
  const work = createWorkOnce({ store: createMemoryStore(), scope: 'external-preparation' });
  const queue = work.define('job', { key: (input) => input.id });
  const service = queue.serveExternal({
    prepare: (run) =>
      run.input.ready ? run.handoff({ id: run.input.id }) : run.wait('not_ready', { afterMs: 100 }),
    onPrepareError: (run) => run.fail('prepare_failed'),
  });
  await service.ensure({ id: 'wait', ready: false });
  await service.ensure({ id: 'go', ready: true });
  const leases = await service.claim({ workerId: 'outside', limit: 2 });
  assert.equal(leases.length, 1);
  assert.equal(leases[0].input.id, 'go');
  assert.equal((await queue.item({ id: 'wait', ready: false }).inspect()).phase.state, 'waiting');
  assert.equal((await queue.item({ id: 'go', ready: true }).inspect()).phase.state, 'running');
});

test('local run and external service compete through one claim/fence authority', async () => {
  const work = createWorkOnce({ store: createMemoryStore(), scope: 'dual-topology' });
  let localExecutions = 0;
  const queue = work.define('job', {
    key: (input) => input.id,
    perform: async (run) => {
      localExecutions++;
      return run.succeed('local');
    },
  });
  const service = queue.serveExternal({
    prepare: (run) => run.handoff({ id: run.input.id }),
    onPrepareError: (run) => run.fail('prepare_failed'),
  });
  await queue.enqueue({ id: 'one' });
  const [local, external] = await Promise.all([
    queue.process({ workerId: 'local' }),
    service.claim({ workerId: 'outside', limit: 1 }),
  ]);
  assert.equal(local.length + external.length, 1);
  assert.ok(localExecutions === 0 || localExecutions === 1);
  if (external.length) {
    await service.settle(external[0].attempt, { type: 'succeed', result: 'external', next: [] });
  }
  assert.equal((await queue.item({ id: 'one' }).inspect()).phase.state, 'succeeded');
});
