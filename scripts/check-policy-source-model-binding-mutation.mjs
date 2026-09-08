import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src/retry-policy.ts');
const original = fs.readFileSync(target, 'utf8');
const needle = 'const scaled = initialDelayMs === 0 ? 0 : initialDelayMs * multiplier ** retries;';
const replacement =
  'const scaled = initialDelayMs === 0 ? 0 : initialDelayMs * multiplier ** retries + 0;';
assert.equal(original.includes(needle), true, 'policy source/model mutation anchor is stale');
try {
  fs.writeFileSync(target, original.replace(needle, replacement));
  const result = spawnSync(
    process.execPath,
    ['scripts/check-formal-implementation-conformance.mjs', '--write'],
    { cwd: root, encoding: 'utf8', env: process.env, timeout: 15_000 },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.notEqual(result.status, 0, 'policy source/model drift mutant unexpectedly passed');
  assert.match(output, /Bound retry\/defer policy semantics changed/u);
  console.log(
    'Policy source/model mutation guard rejects a changed retry-policy source with unchanged policy model.',
  );
} finally {
  fs.writeFileSync(target, original);
}
