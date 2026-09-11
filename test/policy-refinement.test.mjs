import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPolicyRefinementSamples,
  runPolicyRefinementSamples,
} from '../scripts/policy-refinement.mjs';

const policyRefinementSamplesPromise = runPolicyRefinementSamples();
void policyRefinementSamplesPromise.catch(() => {});

test('compiled retry/defer policy observations cover temporal races, receipt identity, adapters and boundaries', async () => {
  const samples = await policyRefinementSamplesPromise;
  assertPolicyRefinementSamples(samples);
});

test('policy refinement rejects wake adapter substitution without a count change', async () => {
  const samples = await policyRefinementSamplesPromise;
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

test('policy refinement rejects count-preserving sample-kind substitution', async () => {
  const samples = await policyRefinementSamplesPromise;
  const historyIndex = samples.findIndex((sample) => sample.kind === 'historyCongruence');
  const receipt = samples.find((sample) => sample.kind === 'receiptSplit');
  assert.notEqual(historyIndex, -1);
  assert.ok(receipt);
  const mutant = samples.map((sample, index) => (index === historyIndex ? { ...receipt } : sample));
  assert.throws(
    () => assertPolicyRefinementSamples(mutant),
    /policy sample kind coverage drifted/u,
  );
});

test('policy refinement rejects count-preserving backoff category substitution', async () => {
  const samples = await policyRefinementSamplesPromise;
  const maxFiniteIndex = samples.findIndex(
    (sample) => sample.kind === 'backoffFinite' && sample.category === 'maxFiniteCap',
  );
  assert.notEqual(maxFiniteIndex, -1);
  const mutant = samples.map((sample, index) =>
    index === maxFiniteIndex ? { ...sample, category: 'capped' } : sample,
  );
  assert.throws(
    () => assertPolicyRefinementSamples(mutant),
    /backoffFinite category coverage drifted/u,
  );
});

test('policy refinement rejects collapsed adapter-equivalence coverage', async () => {
  const samples = await policyRefinementSamplesPromise;
  assert.ok(samples.some((sample) => sample.kind === 'adapterEquivalence'));
  const mutant = samples.map((sample) =>
    sample.kind === 'adapterEquivalence' ? { ...sample, adapters: 'memory' } : sample,
  );
  assert.throws(
    () => assertPolicyRefinementSamples(mutant),
    /adapterEquivalence adapter coverage drifted/u,
  );
});

test('policy refinement rejects count-preserving outcome and race lane substitutions', async () => {
  const samples = await policyRefinementSamplesPromise;
  const outcomeMutant = samples.map((sample) =>
    sample.kind === 'adapterEquivalence' ? { ...sample, outcomeKind: 'retry' } : sample,
  );
  assert.throws(
    () => assertPolicyRefinementSamples(outcomeMutant),
    /adapterEquivalence outcome coverage drifted/u,
  );
  const raceMutant = samples.map((sample) =>
    sample.kind === 'policyRace' && sample.race === 'reclaim'
      ? { ...sample, race: 'cancel' }
      : sample,
  );
  assert.throws(
    () => assertPolicyRefinementSamples(raceMutant),
    /policyRace lane coverage drifted/u,
  );
});
