import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requireCompletedProcess,
  requireExpectedProcessFailure,
  requireSuccessfulProcess,
} from '../scripts/subprocess-outcome.mjs';

function result(overrides = {}) {
  return { status: 0, signal: null, stdout: '', stderr: '', ...overrides };
}

test('mutation kills require a completed numeric nonzero exit with the intended witness', () => {
  const output = requireExpectedProcessFailure(
    result({ status: 1, stderr: 'exact semantic witness' }),
    'semantic mutant',
    /exact semantic witness/u,
  );
  assert.match(output, /exact semantic witness/u);
  assert.throws(
    () => requireExpectedProcessFailure(result(), 'semantic mutant', /witness/u),
    /unexpectedly passed/u,
  );
  assert.throws(
    () =>
      requireExpectedProcessFailure(
        result({ status: 1, stderr: 'wrong cause' }),
        'semantic mutant',
        /witness/u,
      ),
    /unrelated reason/u,
  );
});

test('timeout, signal, spawn error and status-null can never masquerade as mutation kills', () => {
  const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  assert.throws(
    () => requireExpectedProcessFailure(result({ status: null, error: timeout }), 'timeout mutant'),
    /failed to execute \(ETIMEDOUT\)/u,
  );
  assert.throws(
    () =>
      requireExpectedProcessFailure(result({ status: null, signal: 'SIGKILL' }), 'signal mutant'),
    /terminated by signal SIGKILL/u,
  );
  assert.throws(
    () => requireExpectedProcessFailure(result({ status: null }), 'missing-status mutant'),
    /did not produce a numeric exit status/u,
  );
});

test('successful child checks preserve infrastructure causes before semantic exit status', () => {
  assert.equal(requireSuccessfulProcess(result({ stdout: 'green' }), 'green child'), 'green\n');
  assert.throws(
    () => requireSuccessfulProcess(result({ status: 2 }), 'red child'),
    /exited with status 2/u,
  );
  assert.throws(
    () => requireCompletedProcess(result({ status: null, signal: 'SIGTERM' }), 'killed child'),
    /terminated by signal SIGTERM/u,
  );
});
