import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertLocalRunnerRefinementSamples,
  runLocalRunnerRefinementSamples,
} from '../scripts/local-runner-refinement.mjs';

test('compiled local managed-runner observations cover causes, fairness, contention and boundaries', async () => {
  const samples = await runLocalRunnerRefinementSamples();
  assertLocalRunnerRefinementSamples(samples);
});

test('local runner refinement rejects adapter substitution without a count change', async () => {
  const samples = await runLocalRunnerRefinementSamples();
  const sqliteIndex = samples.findIndex(
    (sample) => sample.kind === 'settleCause' && sample.adapter === 'sqlite',
  );
  const memory = samples.find(
    (sample) => sample.kind === 'settleCause' && sample.adapter === 'memory',
  );
  assert.notEqual(sqliteIndex, -1);
  assert.ok(memory);
  const mutant = samples.map((sample, index) => (index === sqliteIndex ? { ...memory } : sample));
  assert.throws(
    () => assertLocalRunnerRefinementSamples(mutant),
    /settleCause adapter coverage drifted/u,
  );
});
