import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPolicyRefinementSamples,
  runPolicyRefinementSamples,
} from '../scripts/policy-refinement.mjs';

test('compiled retry/defer policy observations cover temporal races, receipt identity, adapters and boundaries', async () => {
  const samples = await runPolicyRefinementSamples();
  assertPolicyRefinementSamples(samples);
});

test('policy refinement rejects loss of one wake-competition adapter lane', async () => {
  const samples = await runPolicyRefinementSamples();
  assert.throws(
    () =>
      assertPolicyRefinementSamples(
        samples.filter(
          (sample) => !(sample.kind === 'wakeCompetition' && sample.adapter === 'sqlite'),
        ),
      ),
    /policy refinement sample family unexpectedly changed|wakeCompetition adapter coverage drifted/u,
  );
});
