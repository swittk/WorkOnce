import test from 'node:test';
import {
  assertLocalRunnerRefinementSamples,
  runLocalRunnerRefinementSamples,
} from '../scripts/local-runner-refinement.mjs';

test('compiled local managed-runner observations cover causes, fairness, contention and boundaries', async () => {
  const samples = await runLocalRunnerRefinementSamples();
  assertLocalRunnerRefinementSamples(samples);
});
