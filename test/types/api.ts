import { createWorkOnce, type WorkSnapshot } from '../../src/index.js';
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
});
void queue.enqueue({ assetId: 'id', urgent: true }, { key: 'id' });
// @ts-expect-error Strongly typed input is not an arbitrary payload.
void queue.enqueue({ other: 3 }, { key: 'id' });
void queue.process({ workerId: 'w' }, (run) => {
  if (run.input.urgent) return run.retry('busy', { afterMs: 5 });
  return run.succeed({ checksum: 'hash' });
});
void queue.process({ workerId: 'w' }, (run) => {
  // @ts-expect-error A known result type requires a real result.
  run.succeed();
  // @ts-expect-error A failure reason is not any string.
  run.retry('typo');
  // @ts-expect-error Relative and absolute time cannot both be supplied.
  run.defer('busy', { afterMs: 5, at: 9 });
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
