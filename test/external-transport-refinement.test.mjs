import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertExternalTransportSamples,
  runExternalTransportSamples,
} from '../scripts/external-transport-refinement.mjs';

const externalTransportSamplesPromise = runExternalTransportSamples();
void externalTransportSamplesPromise.catch(() => {});

test('compiled external transport observations cover handoff, fencing, ACK ambiguity, capacity and boundaries', async () => {
  const samples = await externalTransportSamplesPromise;
  assertExternalTransportSamples(samples);
});

test('external transport refinement rejects count-preserving adapter-domain substitution', async () => {
  const samples = await externalTransportSamplesPromise;
  const index = samples.findIndex((sample) => sample.kind === 'externalAdapterEquivalence');
  assert.notEqual(index, -1);
  const mutant = samples.map((sample, sampleIndex) =>
    sampleIndex === index ? { ...sample, adapters: 'memory,sqlite' } : sample,
  );
  assert.throws(() => assertExternalTransportSamples(mutant), /external adapter coverage drifted/u);
});
