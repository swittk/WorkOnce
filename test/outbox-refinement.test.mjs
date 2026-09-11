import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertOutboxRefinementSamples,
  outboxSampleKinds,
  runOutboxRefinementSamples,
} from '../scripts/outbox-refinement.mjs';

const samplesOnce = runOutboxRefinementSamples();
void samplesOnce.catch(() => {});

test('compiled outbox observations cover cursor rotation, faults, restart and adapters', async () => {
  const samples = await samplesOnce;
  assertOutboxRefinementSamples(samples);
});

test('outbox refinement rejects count-preserving adapter substitution', async () => {
  const samples = await samplesOnce;
  const sqliteIndex = samples.findIndex(
    (sample) => sample.kind === 'adapter' && sample.adapter === 'sqlite',
  );
  const memory = samples.find((sample) => sample.kind === 'adapter' && sample.adapter === 'memory');
  assert.notEqual(sqliteIndex, -1);
  assert.ok(memory);
  const mutant = samples.map((sample, index) => (index === sqliteIndex ? { ...memory } : sample));
  assert.throws(() => assertOutboxRefinementSamples(mutant), /Unexpected outbox adapter set/u);
});

const requiredOutboxSampleKinds = [
  'ackLoss',
  'adapter',
  'adapterBudget',
  'adapterConcurrent',
  'adapterFaults',
  'budget',
  'casAckLoss',
  'concurrent',
  'dynamic',
  'finiteArrivals',
  'grid',
  'historyCongruence',
  'historySplit',
  'limitBoundary',
  'multiError',
  'multiPoison',
  'poison',
  'restart',
  'rotation',
  'rotationFailure',
  'runDispatcher',
  'staleParent',
];

test('outbox refinement rejects count-preserving kind multiplicity substitution', async () => {
  const samples = await samplesOnce;
  const sourceIndex = samples.findIndex(
    (sample) => sample.kind === 'adapter' && sample.adapter === 'memory',
  );
  const donor = samples.find(
    (sample) => sample.kind === 'adapterBudget' && sample.adapter === 'memory',
  );
  assert.notEqual(sourceIndex, -1);
  assert.ok(donor);
  const mutant = samples.map((sample, index) => (index === sourceIndex ? { ...donor } : sample));
  assert.throws(
    () => assertOutboxRefinementSamples(mutant),
    /outbox sample kind multiplicity drifted/u,
  );
});

test('outbox refinement kind inventory cannot silently narrow', async () => {
  const samples = await samplesOnce;
  assert.deepEqual([...outboxSampleKinds].sort(), requiredOutboxSampleKinds);
  for (const kind of requiredOutboxSampleKinds) {
    const mutant = samples.filter((sample) => sample.kind !== kind);
    assert.throws(
      () => assertOutboxRefinementSamples(mutant),
      /Unexpected outbox sample kinds/u,
      `missing ${kind} must invalidate the outbox refinement corpus`,
    );
  }
});
