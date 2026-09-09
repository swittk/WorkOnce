import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

import { createMutationFileGuard } from './mutation-file-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutationFiles = createMutationFileGuard();
const target = path.join(root, 'src/worker.ts');
const original = fs.readFileSync(target, 'utf8');
const needle = 'const stop = () => controller.abort(options.signal?.reason);';
const replacement = 'const stop = () => controller.abort();';
assert.equal(
  original.split(needle).length,
  2,
  'local-runner source/model mutation anchor is stale or not unique',
);
try {
  mutationFiles.writeFileSync(target, original.replace(needle, replacement));
  const result = spawnSync(
    process.execPath,
    ['scripts/check-formal-implementation-conformance.mjs', '--check-local-runner-binding-only'],
    { cwd: root, encoding: 'utf8', env: process.env, timeout: 15_000 },
  );
  requireExpectedProcessFailure(
    result,
    'local-runner source/model drift mutant',
    /Bound local managed-runner semantics changed/u,
  );
  console.log(
    'Local-runner source/model mutation guard rejects changed worker semantics with an unchanged local-runner model.',
  );
} finally {
  mutationFiles.restoreAll();
}
mutationFiles.dispose();
