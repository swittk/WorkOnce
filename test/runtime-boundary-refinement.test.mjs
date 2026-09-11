import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runRuntimeBoundarySamples,
  assertRuntimeBoundarySamples,
} from '../scripts/runtime-boundary-refinement.mjs';

test('real local/external runners, typed reads, policy delays and race results refine runtime boundaries', async () => {
  const samples = await runRuntimeBoundarySamples();
  assert.equal(assertRuntimeBoundarySamples(samples), 235);

  const duplicateSite = samples.map((sample) => ({ ...sample }));
  const replacedSite = duplicateSite.find(
    (sample) =>
      sample.kind === 'runner' &&
      sample.mode === 'local' &&
      sample.site === 'activeObserver' &&
      sample.failureValue === 'errorA',
  );
  assert.ok(replacedSite);
  replacedSite.site = 'active';
  assert.throws(
    () => assertRuntimeBoundarySamples(duplicateSite),
    /runner mode\/site coverage drifted/u,
  );

  const unknownMetadata = samples.map((sample) => ({ ...sample }));
  const unknown = unknownMetadata.find(
    (sample) =>
      sample.kind === 'runner' &&
      sample.mode === 'local' &&
      sample.site === 'activeObserver' &&
      sample.failureValue === 'errorA',
  );
  assert.ok(unknown);
  unknown.site = 'unknown';
  assert.throws(
    () => assertRuntimeBoundarySamples(unknownMetadata),
    /runner mode\/site coverage drifted/u,
  );
});
