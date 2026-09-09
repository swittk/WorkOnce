import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stampPath = path.join(root, '.artifacts/build-source-binding.json');

function bindingCheck() {
  return spawnSync(process.execPath, ['scripts/formal.mjs', '--binding-check-only'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 15_000,
  });
}

function outputOf(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

const originalStamp = fs.readFileSync(stampPath, 'utf8');
try {
  const mutant = JSON.parse(originalStamp);
  assert.equal(typeof mutant.sourceDigest, 'string', 'build/source binding stamp anchor is stale');
  mutant.sourceDigest = '0'.repeat(64);
  fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\n`);
  const result = bindingCheck();
  const output = outputOf(result);
  requireExpectedProcessFailure(result, 'source-binding mutant unexpectedly passed');
  assert.match(output, /Stale compiled WorkOnce build does not match current TypeScript sources/u);
  console.log('Build/source binding mutation guard rejects a stale compiled artifact stamp.');
} finally {
  fs.writeFileSync(stampPath, originalStamp);
}

for (const relative of ['dist/index.js', 'dist-cjs/index.js', 'dist/index.d.ts']) {
  const target = path.join(root, relative);
  const original = fs.readFileSync(target);
  try {
    fs.appendFileSync(target, '\n// emitted-artifact-binding-mutant\n');
    const result = bindingCheck();
    const output = outputOf(result);
    requireExpectedProcessFailure(result, `${relative} artifact mutant unexpectedly passed`);
    assert.match(output, /Compiled WorkOnce artifacts changed after the bound build/u);
    console.log(
      `Build/artifact binding mutation guard rejects post-build mutation of ${relative}.`,
    );
  } finally {
    fs.writeFileSync(target, original);
  }
}
