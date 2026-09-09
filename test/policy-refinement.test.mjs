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

test('policy refinement rejects wake adapter substitution without a count change', async () => {
  const samples = await runPolicyRefinementSamples();
  const sqliteIndex = samples.findIndex(
    (sample) => sample.kind === 'wakeCompetition' && sample.adapter === 'sqlite',
  );
  const memory = samples.find(
    (sample) => sample.kind === 'wakeCompetition' && sample.adapter === 'memory',
  );
  assert.notEqual(sqliteIndex, -1);
  assert.ok(memory);
  const mutant = samples.map((sample, index) => (index === sqliteIndex ? { ...memory } : sample));
  assert.throws(
    () => assertPolicyRefinementSamples(mutant),
    /wakeCompetition adapter coverage drifted/u,
  );
});

test('policy refinement rejects collapsed adapter-equivalence coverage', async () => {
  const samples = await runPolicyRefinementSamples();
  const mutant = samples.map((sample) =>
    sample.kind === 'adapterEquivalence' ? { ...sample, adapters: 'memory' } : sample,
  );
  assert.throws(
    () => assertPolicyRefinementSamples(mutant),
    /adapterEquivalence adapter coverage drifted/u,
  );
});
