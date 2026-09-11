import assert from 'node:assert/strict';
import test from 'node:test';
import { assertParallelEntriesReadOnly } from '../scripts/assurance-parallel-safety.mjs';

test('resolved parallel guard rejects computed aliases of mutating entry points', () => {
  const aliasedMutation = ['scripts', 'check-policy-implementation-mutations.mjs'].join('/');
  assert.throws(
    () =>
      assertParallelEntriesReadOnly([['aliased mutation', process.execPath, [aliasedMutation]]]),
    /Source\/dist-mutating assurance guards must not run in runParallel/u,
  );
});

test('resolved parallel guard accepts read-only assurance entries', () => {
  assert.doesNotThrow(() =>
    assertParallelEntriesReadOnly([
      ['public mapping', process.execPath, ['scripts/check-formal-implementation-conformance.mjs']],
    ]),
  );
});
