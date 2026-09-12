import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertStorageRefinementSamples,
  runStorageRefinementSamples,
} from '../scripts/storage-refinement.mjs';

test('compiled storage observations cover adapters, contention, ordering, invalid writes and ambiguity', async () => {
  const samples = await runStorageRefinementSamples();
  assertStorageRefinementSamples(samples);
});

test('storage refinement rejects duplicate witness multiplicity', async () => {
  const samples = await runStorageRefinementSamples();
  const donor = samples.find((sample) => sample.kind === 'casBoundary');
  const victimIndex = samples.findIndex((sample) => sample.kind === 'casExhaustion');
  assert.ok(donor);
  assert.notEqual(victimIndex, -1);
  const mutant = samples.map((sample, index) => (index === victimIndex ? { ...donor } : sample));
  assert.throws(
    () => assertStorageRefinementSamples(mutant),
    /storage sample kind multiplicity drifted/u,
  );
});

test('storage refinement rejects count-preserving adapter substitution', async () => {
  const samples = await runStorageRefinementSamples();
  const sqliteIndex = samples.findIndex(
    (sample) => sample.kind === 'detached' && sample.adapter === 'sqlite',
  );
  const memory = samples.find(
    (sample) => sample.kind === 'detached' && sample.adapter === 'memory',
  );
  assert.notEqual(sqliteIndex, -1);
  assert.ok(memory);
  const mutant = samples.map((sample, index) => (index === sqliteIndex ? { ...memory } : sample));
  assert.throws(
    () => assertStorageRefinementSamples(mutant),
    /storage adapter sample coverage drifted/u,
  );
});
