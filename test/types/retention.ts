import {
  createWorkOnce,
  type WorkRetention,
  type PruneOptions,
  type PrunerOptions,
  type AttemptRef,
} from '../../src/index.js';
import { createMemoryStore } from '../../src/memory.js';
import type { StoreChange, WorkRecord } from '../../src/storage.js';
import type { CompareDelete, CompareExchangePort } from '../../src/cas.js';

const finite: WorkRetention = { afterTerminalMs: 0 };
const forever: WorkRetention = 'forever';
// @ts-expect-error Retention is a named policy, not an untyped TTL number.
const invalid: WorkRetention = 100;
void invalid;
const work = createWorkOnce({ store: createMemoryStore(), scope: 'type-check' });
const queue = work.define<{ id: string }>('temporary', {
  key: (input) => input.id,
  retention: finite,
  perform: (run) => run.succeed(),
});
void queue.ensure({ id: 'short' });
void queue.enqueue({ id: 'permanent' }, { retention: forever });
const pass: PruneOptions = { limit: 20 };
const removed: Promise<number> = queue.prune(pass);
void removed;
const pump: PrunerOptions = { signal: new AbortController().signal, ...pass, intervalMs: 1000 };
void work.runPruner(pump);

async function carryIdentity(): Promise<void> {
  const saved = await queue.ensure({ id: 'guarded' });
  await queue.cancel({
    key: saved.key,
    generation: saved.generation,
    incarnation: saved.incarnation,
  });
  await queue.restart({
    key: saved.key,
    expectedGeneration: saved.generation,
    expectedIncarnation: saved.incarnation,
  });
  const [run] = await queue.claim({ workerId: 'external' });
  if (!run) return;
  const attempt: AttemptRef = run.ref;
  const serialized = JSON.stringify(attempt);
  void serialized;
}
void carryIdentity;

const deletion: StoreChange<number> = { delete: true, value: 1 };
void deletion;
declare const row: WorkRecord;
// @ts-expect-error A delete and a replacement must not be emitted together.
const invalidWrite: StoreChange<number> = { delete: true, next: row, value: 1 };
void invalidWrite;
// @ts-expect-error A delete does not use a worker lease's exclusive write deadline.
const invalidExpiry: StoreChange<number> = { delete: true, validUntil: 9, value: 1 };
void invalidExpiry;
declare const port: CompareExchangePort;
const conditional: CompareDelete = {
  id: 'job',
  expectedRevision: 3,
  expectedIncarnation: 'creation',
  expiredAt: 123,
};
void port.deleteExchange?.(conditional);
