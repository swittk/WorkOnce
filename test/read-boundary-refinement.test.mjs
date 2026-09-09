import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertTypedReadBoundarySamples,
  runTypedReadBoundarySamples,
} from '../scripts/read-boundary-refinement.mjs';

test('typed reads preserve definition fences, exact missing semantics and adapter parity', async () => {
  const samples = await runTypedReadBoundarySamples();
  assertTypedReadBoundarySamples(samples);
});

test('typed-read refinement rejects a missing required evidence field', async () => {
  const samples = await runTypedReadBoundarySamples();
  const mutant = samples.map((sample, index) => {
    if (index !== 0) return sample;
    const { wrongScopeNotFound: _missing, ...rest } = sample;
    return rest;
  });
  assert.throws(
    () => assertTypedReadBoundarySamples(mutant),
    /Typed read refinement failed: .*\.wrongScopeNotFound/u,
  );
});
