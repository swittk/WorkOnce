import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('lifecycle temporal and bounded claim-scan formal gate is green', () => {
  const result = spawnSync(process.execPath, ['scripts/lifecycle-formal.mjs'], {
    encoding: 'utf8',
    env: process.env,
    timeout: 30000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.status, 0, output.slice(-4000));
  assert.match(output, /proves 7 configured invariants.*WorkOnceLifecycleTemporal/u);
  assert.match(output, /proves 6 configured invariants.*WorkOnceClaimScan/u);
  assert.match(output, /24 fresh compiled implementation observations/u);
  assert.match(output, /Lifecycle sample mutation guard/u);
});
