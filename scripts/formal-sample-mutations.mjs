import assert from 'node:assert/strict';

/**
 * Mutate each asserted boolean independently while preserving every other field.
 * The executable validator must reject each candidate before the actual TLA
 * predicate is required to reject it. Pure scenario inputs and conditional
 * observations are excluded explicitly by their owning formal boundary.
 * Constant assumptions reuse the existing TLC invocation, not one JVM per field.
 */
export function renderBooleanSampleMutationChecks(
  samples,
  validate,
  tlaValue,
  predicate,
  exclude = () => false,
) {
  validate(samples);
  const targets = [];
  const candidate = [...samples];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    for (const [field, value] of Object.entries(sample)) {
      if (typeof value !== 'boolean' || exclude(sample, field)) continue;
      candidate[index] = { ...sample, [field]: !value };
      assert.throws(
        () => validate(candidate),
        undefined,
        `${predicate}: ${sample.kind}.${field} is not an asserted boolean observation`,
      );
      candidate[index] = sample;
      targets.push(`<<${index + 1}, ${JSON.stringify(field)}>>`);
    }
  }
  assert.ok(targets.length > 0, `${predicate}: boolean mutation coverage is empty`);
  console.log(
    `TLC ${predicate} independently checks ${targets.length} boolean observation mutations.`,
  );
  return [
    `BooleanProbeSamples == <<\n${samples.map(tlaValue).join(',\n')}\n>>`,
    `BooleanProbeTargets == {${targets.join(', ')}}`,
    String.raw`BooleanProbeFailures ==
  {target \in BooleanProbeTargets :
    LET original == BooleanProbeSamples[target[1]]
        field == target[2]
        mutant == [original EXCEPT ![field] = ~@]
    IN ${predicate}(mutant)}
ASSUME Assert(BooleanProbeFailures = {},
  "Boolean semantic clauses not enforced: " \o
  ToString({BooleanProbeSamples[target[1]].kind \o "." \o target[2] : target \in BooleanProbeFailures}))`,
  ].join('\n');
}
