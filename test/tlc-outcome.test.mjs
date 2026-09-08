import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTlcOutcome, requireExpectedInvariantViolation } from '../scripts/tlc-outcome.mjs';

function result(overrides = {}) {
  return { status: 1, signal: null, error: undefined, stdout: '', stderr: '', ...overrides };
}

test('successful TLC exit is success', () => {
  assert.equal(classifyTlcOutcome(result({ status: 0 })).kind, 'success');
});

test('explicit invariant violation is the only invariant semantic counterexample', () => {
  const outcome = classifyTlcOutcome(
    result({ stdout: 'Error: Invariant NoLostContinuation is violated.\n' }),
  );
  assert.equal(outcome.kind, 'semantic_counterexample');
  assert.equal(outcome.reason, 'invariant_violation');
  assert.deepEqual(outcome.invariants, ['NoLostContinuation']);
  assert.equal(
    requireExpectedInvariantViolation(
      result({ stderr: 'The invariant of NoLostContinuation is equal to FALSE' }),
      'NoLostContinuation',
    ).kind,
    'semantic_counterexample',
  );
});

test('wrong invariant cannot satisfy a named mutation witness', () => {
  assert.throws(
    () =>
      requireExpectedInvariantViolation(
        result({ stdout: 'Invariant TypeOK is violated.' }),
        'NoLostContinuation',
      ),
    /wrong semantic property.*NoLostContinuation.*TypeOK/u,
  );
});

test('temporal-property and deadlock diagnostics are semantic counterexamples', () => {
  assert.equal(
    classifyTlcOutcome(result({ stdout: 'Error: Temporal properties were violated.' })).kind,
    'semantic_counterexample',
  );
  assert.equal(
    classifyTlcOutcome(result({ stdout: 'Error: Deadlock reached.' })).reason,
    'deadlock',
  );
});

test('timeout, signal, OOM, classpath, parser and unknown exits are infrastructure failures', () => {
  const cases = [
    [result({ error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }), 'timeout'],
    [result({ signal: 'SIGKILL' }), 'signal'],
    [result({ stderr: 'java.lang.OutOfMemoryError: Java heap space' }), 'jvm_out_of_memory'],
    [result({ stderr: 'Error: Could not find or load main class tlc2.TLC' }), 'jvm_or_classpath'],
    [result({ stderr: 'TLC encountered an error while parsing module' }), 'model_or_tool_error'],
    [result({ stderr: 'mysterious nonzero failure' }), 'unclassified_nonzero_exit'],
  ];
  for (const [child, reason] of cases) {
    const outcome = classifyTlcOutcome(child);
    assert.equal(outcome.kind, 'infrastructure_failure');
    assert.equal(outcome.reason, reason);
  }
});

test('infrastructure failure cannot masquerade as a mutation kill', () => {
  assert.throws(
    () =>
      requireExpectedInvariantViolation(
        result({ stderr: 'Error: Could not find or load main class tlc2.TLC' }),
        'TypeOK',
      ),
    /TLC infrastructure failure.*TypeOK.*jvm_or_classpath/u,
  );
});
