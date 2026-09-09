import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTlcWorkspace } from '../scripts/tlc-workspace.mjs';

test('concurrent TLC invocations receive disjoint generated-module namespaces', () => {
  const first = createTlcWorkspace('isolation');
  const second = createTlcWorkspace('isolation');
  try {
    assert.notEqual(first, second);
    const sameName = 'WorkOnceExternalSamplesMutant.tla';
    writeFileSync(join(first, sameName), 'FIRST');
    writeFileSync(join(second, sameName), 'SECOND');
    assert.equal(readFileSync(join(first, sameName), 'utf8'), 'FIRST');
    assert.equal(readFileSync(join(second, sameName), 'utf8'), 'SECOND');
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});
