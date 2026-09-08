import test from 'node:test';
import {
  runRuntimeBoundarySamples,
  assertRuntimeBoundarySamples,
} from '../scripts/runtime-boundary-refinement.mjs';

test('real local/external runners, typed reads, policy delays and race results refine runtime boundaries', async () => {
  const samples = await runRuntimeBoundarySamples();
  assertRuntimeBoundarySamples(samples);
});
