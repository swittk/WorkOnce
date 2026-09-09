import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertStorageRefinementSamples,
  runStorageRefinementSamples,
} from '../scripts/storage-refinement.mjs';

test('compiled storage observations cover adapters, contention, ordering, invalid writes and ambiguity', async () => {
  const samples = await runStorageRefinementSamples();
  assertStorageRefinementSamples(samples);
});

test('storage refinement rejects loss of one adapter family', async () => {
  const samples = await runStorageRefinementSamples();
  assert.throws(
    () => assertStorageRefinementSamples(samples.filter((sample) => sample.adapter !== 'sqlite')),
    /storage adapter sample coverage drifted/u,
  );
});
