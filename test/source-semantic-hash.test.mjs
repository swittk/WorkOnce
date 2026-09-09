import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { requireSuccessfulProcess } from '../scripts/subprocess-outcome.mjs';

test('source/model semantic hash preserves syntax that changes behavior', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/check-formal-implementation-conformance.mjs', '--self-test-source-hash'],
    { encoding: 'utf8', env: process.env, timeout: 30_000 },
  );
  const output = requireSuccessfulProcess(result, 'source semantic hash proof');
  assert.match(
    output,
    /preserve TypeScript ASI\/regexp\/template\/compiler directives and TLA string\/operator structure/u,
  );
  assert.match(output, /reject both legacy digest mutants/u);
  assert.match(output, /AST-printer-only compiler-directive mutant/u);
});
