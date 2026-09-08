import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stampPath = path.join(root, '.artifacts/build-source-binding.json');
const original = fs.readFileSync(stampPath, 'utf8');
try {
  const mutant = JSON.parse(original);
  mutant.sourceDigest = '0'.repeat(64);
  fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\n`);
  const result = spawnSync(process.execPath, ['scripts/formal.mjs', '--binding-check-only'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.notEqual(result.status, 0, 'source-binding mutant unexpectedly passed');
  assert.match(output, /Stale compiled WorkOnce build does not match current TypeScript sources/u);
  console.log('Build/source binding mutation guard rejects a stale compiled artifact stamp.');
} finally {
  fs.writeFileSync(stampPath, original);
}
