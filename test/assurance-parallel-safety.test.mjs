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

for (const entry of [
  String.raw`C:\repo\scripts\check-policy-implementation-mutations.mjs`,
  String.raw`C:\repo\test\lifecycle-proof-controls.test.mjs`,
  '/repo/test/lifecycle-proof-controls.test.mjs',
  String.raw`scripts\check-policy-implementation-mutations.mjs`,
]) {
  test(`parallel guard rejects a native/absolute mutation path: ${entry}`, () => {
    assert.throws(
      () => assertParallelEntriesReadOnly([['native mutation', process.execPath, [entry]]]),
      /Source\/dist-mutating assurance guards must not run in runParallel/u,
    );
  });
}
test('parallel guard preserves native absolute read-only paths', () => {
  assert.doesNotThrow(() =>
    assertParallelEntriesReadOnly([
      [
        'native read',
        process.execPath,
        [String.raw`C:\repo\scripts\check-formal-implementation-conformance.mjs`],
      ],
    ]),
  );
});
