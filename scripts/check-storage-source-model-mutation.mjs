import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

import { createMutationFileGuard } from './mutation-file-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutationFiles = createMutationFileGuard();
const target = path.join(root, 'src/cas.ts');
const original = fs.readFileSync(target, 'utf8');
const needle = 'for (let conflicts = 0; conflicts < maxConflicts; conflicts++)';
const replacement = 'for (let conflicts = 0; conflicts <= maxConflicts; conflicts++)';
assert.equal(original.includes(needle), true, 'storage source semantic mutation anchor is stale');
try {
  mutationFiles.writeFileSync(target, original.replace(needle, replacement));
  const result = spawnSync(
    process.execPath,
    ['scripts/check-formal-implementation-conformance.mjs', '--check-storage-binding-only'],
    { cwd: root, encoding: 'utf8', env: process.env, timeout: 15_000 },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  requireExpectedProcessFailure(result, 'storage source/model mutant unexpectedly passed');
  assert.match(output, /Bound storage\/conformance semantics changed/u);
  console.log(
    'Storage source/model mutation guard rejects a semantic CAS retry-bound change with unchanged storage formal semantics.',
  );
} finally {
  mutationFiles.restoreAll();
}
mutationFiles.dispose();
