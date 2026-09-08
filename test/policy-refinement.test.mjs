import test from 'node:test';
import {
  assertPolicyRefinementSamples,
  runPolicyRefinementSamples,
} from '../scripts/policy-refinement.mjs';

test('compiled retry/defer policy observations cover temporal races, receipt identity, adapters and boundaries', async () => {
  const samples = await runPolicyRefinementSamples();
  assertPolicyRefinementSamples(samples);
});
