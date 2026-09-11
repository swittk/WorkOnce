import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure, requireSuccessfulProcess } from './subprocess-outcome.mjs';

import { createMutationFileGuard } from './mutation-file-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutationFiles = createMutationFileGuard();
const target = path.join(root, 'src/cas.ts');
const original = fs.readFileSync(target, 'utf8');
const needle = 'for (let conflicts = 0; conflicts < maxConflicts; conflicts++)';
const replacement = 'for (let conflicts = 0; conflicts <= maxConflicts; conflicts++)';
assert.equal(
  original.split(needle).length,
  2,
  'storage source semantic mutation anchor is stale or not unique',
);
function bindingCheck() {
  return spawnSync(
    process.execPath,
    ['scripts/check-formal-implementation-conformance.mjs', '--check-storage-binding-only'],
    { cwd: root, encoding: 'utf8', env: process.env, timeout: 15_000 },
  );
}
requireSuccessfulProcess(bindingCheck(), 'baseline storage source/model binding');
try {
  mutationFiles.writeFileSync(target, original.replace(needle, replacement));
  const result = bindingCheck();
  requireExpectedProcessFailure(
    result,
    'storage source/model mutant unexpectedly passed',
    /Bound storage\/conformance semantics changed/u,
  );
  console.log(
    'Storage source/model mutation guard rejects a semantic CAS retry-bound change with unchanged storage formal semantics.',
  );
} finally {
  mutationFiles.restoreAll();
}
mutationFiles.dispose();
