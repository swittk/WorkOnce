import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';
import { createMutationFileGuard } from './mutation-file-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutationFiles = createMutationFileGuard();

function bindingCheck() {
  return spawnSync(process.execPath, ['scripts/formal.mjs', '--binding-check-only'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 15_000,
  });
}

try {
  for (const relative of ['package.json', 'scripts/cjs-package.mjs']) {
    const target = path.join(root, relative);
    const original = fs.readFileSync(target, 'utf8');
    mutationFiles.writeFileSync(
      target,
      `${original}
`,
    );
    const result = bindingCheck();
    const output = `${result.stdout ?? ''}
${result.stderr ?? ''}`;
    requireExpectedProcessFailure(result, `${relative} build-input mutant unexpectedly passed`);
    assert.match(
      output,
      /Stale compiled WorkOnce build does not match current TypeScript sources/u,
    );
    mutationFiles.restoreAll();
    console.log(`Build/source binding rejects post-build mutation of ${relative}.`);
  }
} finally {
  mutationFiles.restoreAll();
}
mutationFiles.dispose();
