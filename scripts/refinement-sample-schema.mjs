import assert from 'node:assert/strict';

/** Require an exact observation shape and true values for every boolean proof field. */
export function assertExactBooleanSample(sample, booleanFields, metadataFields = []) {
  const expectedKeys = ['kind', ...metadataFields, ...booleanFields].sort();
  assert.deepEqual(
    Object.keys(sample).sort(),
    expectedKeys,
    `${sample.kind} evidence fields drifted`,
  );
  for (const field of booleanFields)
    assert.equal(sample[field], true, `${sample.kind}.${field}: ${JSON.stringify(sample)}`);
}
