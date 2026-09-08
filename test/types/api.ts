import { createWorkOnce, runExternalAvailable, type WorkSnapshot } from '../../src/index.js';
import { createMemoryStore } from '../../src/memory.js';
const work = createWorkOnce({ store: createMemoryStore(), scope: 'example' });
interface Input {
  assetId: string;
  urgent: boolean;
}
interface Output {
  checksum: string;
}
type Reason = 'busy' | 'invalid';
const queue = work.define<Input, Output, Reason>('convert', {
  retry: ({ input, reason, retries }) =>
    reason === 'invalid'
      ? { retry: false, manualRetry: false }
      : {
          retry: true,
          afterMs: input.urgent ? 100 : 1000 * (retries + 1),
          maxRetries: 5,
          manualRetry: true,
        },
  perform: async (run) =>
    run.input.urgent ? run.retry('busy') : run.succeed({ checksum: 'bound' }),
});
void queue.ensure({ assetId: 'id', urgent: true }, { key: 'id' });
// @ts-expect-error Strongly typed input is not an arbitrary payload.
void queue.ensure({ other: 3 }, { key: 'id' });
void queue.runAvailable({ workerId: 'w' });
void queue.runAvailable({ workerId: 'typed-result' }).then((results) => {
  const first = results[0];
  if (first?.status === 'settled' && first.phase.state === 'succeeded') {
    const checksum: string = first.phase.result.checksum;
    void checksum;
    // @ts-expect-error The settled result remains the queue's declared Output type.
    const wrong: number = first.phase.result.checksum;
    void wrong;
  }
});
void queue.runAvailable({ workerId: 'override' }, (run) => {
  if (run.input.urgent) return run.retry('busy', { afterMs: 5 });
  return run.succeed({ checksum: 'hash' });
});
void queue.runAvailable({ workerId: 'w' }, (run) => {
  // @ts-expect-error A known result type requires a real result.
  run.succeed();
  // @ts-expect-error A failure reason is not any string.
  run.retry('typo');
  // @ts-expect-error Relative and absolute time cannot both be supplied.
  run.wait('busy', { afterMs: 5, at: 9 });
  return run.fail('invalid');
});
// @ts-expect-error Manual retry must identify the failed generation.
void queue.retry({ key: 'id' });
function show(snapshot: WorkSnapshot<Input, Output, Reason>) {
  if (snapshot.phase.state === 'running') return snapshot.phase.attempt.fence;
  // @ts-expect-error A non-running item has no current attempt.
  return snapshot.phase.attempt.fence;
}
void show;

const noResult = work.define<Input>('no-result');
void noResult.runAvailable({ workerId: 'null-result' }, (run) => {
  run.succeed();
  run.succeed(null);
  // @ts-expect-error The no-result facade accepts omission or explicit null, never undefined.
  run.succeed(undefined);
  return run.succeed();
});
const noResultExternal = noResult.serveExternal({
  prepare: (run) => run.handoff(run.input),
  onPrepareError: (run) => run.fail('prepare_failed'),
});
void runExternalAvailable(
  noResultExternal,
  { workerId: 'null-result-external', signal: new AbortController().signal },
  async (run) => {
    run.succeed();
    run.succeed(null);
    // @ts-expect-error External no-result facade has the same omission-or-null contract.
    run.succeed(undefined);
    return run.succeed();
  },
);

const dynamic = work.define<Input, Output, Reason>('dynamic', {
  executionLimits: (input) => ({ maxAttempts: input.urgent ? 10 : 3 }),
  wait: async (context) => ({ afterMs: context.deferrals ? 30_000 : 1000 }),
});
void dynamic.runAvailable({ workerId: 'typed' }, (run) => run.wait('busy'));

const external = queue.serveExternal({
  prepare: (run) => run.handoff({ assetId: run.input.assetId }),
  onPrepareError: (run) => run.retry('busy'),
});
void external.claim({ workerId: 'outside', limit: 1 });
const externalFollowup = queue.request(
  { assetId: 'follow', urgent: false },
  { key: 'external-followup' },
);
void runExternalAvailable(
  external,
  { workerId: 'outside', signal: new AbortController().signal },
  async (run) => run.succeed({ checksum: 'external' }, { thenDo: [externalFollowup] }),
);
void runExternalAvailable(
  external,
  { workerId: 'outside-fail', signal: new AbortController().signal },
  async (run) =>
    run.fail('invalid', {
      result: { checksum: 'partial' },
      thenDo: [externalFollowup],
    }),
);
