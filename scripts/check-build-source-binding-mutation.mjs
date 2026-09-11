import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure, requireSuccessfulProcess } from './subprocess-outcome.mjs';
import { createMutationFileGuard } from './mutation-file-guard.mjs';

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

requireSuccessfulProcess(bindingCheck(), 'baseline build/source binding');
const mutationFiles = createMutationFileGuard();
try {
  const originalStamp = fs.readFileSync(stampPath, 'utf8');
  const mutant = JSON.parse(originalStamp);
  assert.equal(typeof mutant.sourceDigest, 'string', 'build/source binding stamp anchor is stale');
  mutant.sourceDigest = '0'.repeat(64);
  mutationFiles.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\n`);
  let result = bindingCheck();
  let output = outputOf(result);
  requireExpectedProcessFailure(result, 'source-binding mutant unexpectedly passed');
  assert.match(output, /Stale compiled WorkOnce build does not match current TypeScript sources/u);
  console.log('Build/source binding mutation guard rejects a stale compiled artifact stamp.');
  mutationFiles.restoreAll();

  for (const relative of ['dist/index.js', 'dist-cjs/index.js', 'dist/index.d.ts']) {
    const target = path.join(root, relative);
    mutationFiles.appendFileSync(target, '\n// emitted-artifact-binding-mutant\n');
    result = bindingCheck();
    output = outputOf(result);
    requireExpectedProcessFailure(result, `${relative} artifact mutant unexpectedly passed`);
    assert.match(output, /Compiled WorkOnce artifacts changed after the bound build/u);
    console.log(
      `Build/artifact binding mutation guard rejects post-build mutation of ${relative}.`,
    );
    mutationFiles.restoreAll();
  }
} finally {
  mutationFiles.dispose();
}
