import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runRuntimeBoundarySamples,
  assertRuntimeBoundarySamples,
} from '../scripts/runtime-boundary-refinement.mjs';

test('real local/external runners, typed reads, policy delays and race results refine runtime boundaries', async () => {
  const samples = await runRuntimeBoundarySamples();
  assert.equal(assertRuntimeBoundarySamples(samples), 235);
});
