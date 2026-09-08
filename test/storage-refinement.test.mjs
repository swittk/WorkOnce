import test from 'node:test';
import {
  assertStorageRefinementSamples,
  runStorageRefinementSamples,
} from '../scripts/storage-refinement.mjs';

test('compiled storage observations cover adapters, contention, ordering, invalid writes and ambiguity', async () => {
  const samples = await runStorageRefinementSamples();
  assertStorageRefinementSamples(samples);
});
