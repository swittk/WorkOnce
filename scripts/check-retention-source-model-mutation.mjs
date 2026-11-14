import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure, requireSuccessfulProcess } from './subprocess-outcome.mjs';
import { createMutationFileGuard } from './mutation-file-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutationFiles = createMutationFileGuard();
const target = path.join(root, 'src/kernel.ts');
const original = fs.readFileSync(target, 'utf8');
const needle =
  "if (row.retention === undefined || row.retention === 'forever' || row.outbox.length > 0)";
const replacement = "if (row.retention === undefined || row.retention === 'forever')";
assert.equal(
  original.split(needle).length,
  2,
  'retention source/model mutation anchor is stale or not unique',
);

function bindingCheck() {
  return spawnSync(
    process.execPath,
    ['scripts/check-formal-implementation-conformance.mjs', '--check-retention-binding-only'],
    { cwd: root, encoding: 'utf8', env: process.env, timeout: 15_000 },
  );
}

requireSuccessfulProcess(bindingCheck(), 'baseline retention source/model binding');
try {
  mutationFiles.writeFileSync(target, original.replace(needle, replacement));
  const result = bindingCheck();
  requireExpectedProcessFailure(
    result,
    'retention source/model mutant unexpectedly passed',
    /Bound finite-retention semantics changed/u,
  );
  console.log(
    'Retention source/model mutation guard rejects removal of pending-outbox protection with unchanged retention formal semantics.',
  );
} finally {
  mutationFiles.restoreAll();
}
mutationFiles.dispose();
