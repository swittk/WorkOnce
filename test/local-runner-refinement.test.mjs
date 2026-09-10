import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertLocalRunnerRefinementSamples,
  runLocalRunnerRefinementSamples,
} from '../scripts/local-runner-refinement.mjs';

const samplesOnce = runLocalRunnerRefinementSamples();
samplesOnce.catch(() => {});

test('compiled local managed-runner observations cover causes, fairness, contention and boundaries', async () => {
  const samples = await samplesOnce;
  assertLocalRunnerRefinementSamples(samples);
});

test('local runner refinement rejects adapter substitution without a count change', async () => {
  const samples = await samplesOnce;
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

test('local runner refinement rejects stopReclaim adapter/mode substitution without a count change', async () => {
  const samples = await samplesOnce;
  const targetIndex = samples.findIndex(
    (sample) =>
      sample.kind === 'stopReclaim' && sample.adapter === 'sqlite' && sample.mode === 'heartbeat',
  );
  const donor = samples.find(
    (sample) =>
      sample.kind === 'stopReclaim' && sample.adapter === 'memory' && sample.mode === 'heartbeat',
  );
  assert.notEqual(targetIndex, -1);
  assert.ok(donor);
  const mutant = samples.map((sample, index) => (index === targetIndex ? { ...donor } : sample));
  assert.throws(
    () => assertLocalRunnerRefinementSamples(mutant),
    /stopReclaim adapter\/mode coverage drifted/u,
  );
});

test('local runner refinement rejects standalone kind substitution without a count change', async () => {
  const samples = await samplesOnce;
  const dynamicIndex = samples.findIndex((sample) => sample.kind === 'dynamicArrival');
  const wakePoll = samples.find((sample) => sample.kind === 'wakePoll');
  assert.notEqual(dynamicIndex, -1);
  assert.ok(wakePoll);
  const mutant = samples.map((sample, index) =>
    index === dynamicIndex ? { ...wakePoll } : sample,
  );
  assert.throws(
    () => assertLocalRunnerRefinementSamples(mutant),
    /local runner refinement kind coverage drifted/u,
  );
});

test('local runner refinement rejects an unclassified observation field', async () => {
  const samples = await samplesOnce;
  const targetIndex = samples.findIndex((sample) => sample.kind === 'wakePoll');
  assert.notEqual(targetIndex, -1);
  const mutant = samples.map((sample, index) =>
    index === targetIndex ? { ...sample, unclassifiedObservation: true } : sample,
  );
  assert.throws(
    () => assertLocalRunnerRefinementSamples(mutant),
    /wakePoll evidence fields drifted/u,
  );
});
