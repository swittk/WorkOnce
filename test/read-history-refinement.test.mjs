import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertReadHistorySamples,
  runReadHistorySamples,
} from '../scripts/read-history-refinement.mjs';

const samplesOnce = runReadHistorySamples();
samplesOnce.catch(() => {});

test('history-only state and concurrent inspectMany obey the supported read contract', async () => {
  const samples = await samplesOnce;
  assertReadHistorySamples(samples);
});

test('read-history refinement rejects count-preserving adapter/mode substitution', async () => {
  const samples = await samplesOnce;
  const sqliteWriter = samples.findIndex(
    (sample) =>
      sample.kind === 'inspectManyRace' &&
      sample.adapter === 'sqlite' &&
      sample.mode === 'writerFirst',
  );
  const memoryWriter = samples.find(
    (sample) =>
      sample.kind === 'inspectManyRace' &&
      sample.adapter === 'memory' &&
      sample.mode === 'writerFirst',
  );
  assert.notEqual(sqliteWriter, -1);
  assert.ok(memoryWriter);
  const mutant = samples.map((sample, index) =>
    index === sqliteWriter ? { ...memoryWriter } : sample,
  );
  assert.throws(() => assertReadHistorySamples(mutant), /read-history sample coverage drifted/u);
});
