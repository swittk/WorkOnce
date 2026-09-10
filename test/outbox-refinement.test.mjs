import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertOutboxRefinementSamples,
  runOutboxRefinementSamples,
} from '../scripts/outbox-refinement.mjs';

const samplesOnce = runOutboxRefinementSamples();

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
