import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertLifecycleRefinementSamples,
  runLifecycleRefinementSamples,
} from '../scripts/lifecycle-refinement.mjs';

test('compiled lifecycle observations cover hidden revisions, receipts, scan fairness, adapter parity and boundaries', async () => {
  const samples = await runLifecycleRefinementSamples();
  assertLifecycleRefinementSamples(samples);
});

test('lifecycle refinement rejects loss of one adapter matrix lane', async () => {
  const samples = await runLifecycleRefinementSamples();
  assert.throws(
    () =>
      assertLifecycleRefinementSamples(
        samples.filter((sample) => !(sample.kind === 'claimLimit' && sample.adapter === 'sqlite')),
      ),
    /lifecycle refinement sample family unexpectedly changed|claimLimit adapter coverage drifted/u,
  );
});
