import test from 'node:test';
import {
  assertLifecycleRefinementSamples,
  runLifecycleRefinementSamples,
} from '../scripts/lifecycle-refinement.mjs';

test('compiled lifecycle observations cover hidden revisions, receipts, scan fairness, adapter parity and boundaries', async () => {
  const samples = await runLifecycleRefinementSamples();
  assertLifecycleRefinementSamples(samples);
});
