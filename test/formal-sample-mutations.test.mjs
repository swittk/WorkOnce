import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBooleanSampleMutationChecks } from '../scripts/formal-sample-mutations.mjs';
import { assertExactBooleanSample } from '../scripts/refinement-sample-schema.mjs';

const serialize = (sample) => `[kind |-> "${sample.kind}", first |-> TRUE, second |-> TRUE]`;
const validate = (samples) => {
  for (const sample of samples) assertExactBooleanSample(sample, ['first', 'second']);
};
test('formal negative controls flip each independent boolean rather than one combined invalid record', () => {
  const samples = [{ kind: 'proof', first: true, second: true }];
  const seen = [];
  const result = renderBooleanSampleMutationChecks(
    samples,
    (candidate) => {
      seen.push({ ...candidate[0] });
      validate(candidate);
    },
    serialize,
    'SampleOK',
  );
  assert.deepEqual(seen, [
    samples[0],
    { kind: 'proof', first: false, second: true },
    { kind: 'proof', first: true, second: false },
  ]);
  assert.match(result, /<<1, "first">>, <<1, "second">>/u);
  assert.match(result, /ASSUME/u);
  assert.ok(result.includes('IN SampleOK(mutant)'));
  assert.ok(result.includes('Assert(BooleanProbeFailures = {}'));
  assert.equal(samples[0].first, true);
  assert.equal(samples[0].second, true);
});
test('a missing executable assertion cannot silently erase its formal mutation witness', () => {
  assert.throws(
    () =>
      renderBooleanSampleMutationChecks(
        [{ kind: 'proof', first: true, second: true }],
        (samples) => {
          assert.equal(samples[0].first, true);
        },
        serialize,
        'SampleOK',
      ),
    /proof.second is not an asserted boolean observation/u,
  );
});
test('only explicit scenario inputs are excluded, and an empty mutation plan fails closed', () => {
  const result = renderBooleanSampleMutationChecks(
    [{ kind: 'proof', scenario: true, first: true }],
    (samples) => {
      assert.equal(samples[0].first, true);
    },
    () => '[kind |-> "proof", scenario |-> TRUE, first |-> TRUE]',
    'SampleOK',
    (_sample, field) => field === 'scenario',
  );
  assert.match(result, /BooleanProbeTargets == \{<<1, "first">>\}/u);
  assert.throws(
    () =>
      renderBooleanSampleMutationChecks(
        [{ kind: 'proof', first: true, second: true }],
        validate,
        serialize,
        'SampleOK',
        () => true,
      ),
    /boolean mutation coverage is empty/u,
  );
});
