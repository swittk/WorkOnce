import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

import { createMutationFileGuard } from './mutation-file-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutationFiles = createMutationFileGuard();
const target = path.join(root, 'src/external.ts');
const original = fs.readFileSync(target, 'utf8');
const needle = '    if (leases.length > limit)';
const replacement = '    if (leases.length >= limit)';
assert.equal(original.includes(needle), true, 'external source/model mutation anchor is stale');
try {
  mutationFiles.writeFileSync(target, original.replace(needle, replacement));
  const result = spawnSync(
    process.execPath,
    ['scripts/check-formal-implementation-conformance.mjs', '--check-external-binding-only'],
    { cwd: root, encoding: 'utf8', env: process.env, timeout: 15_000 },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  requireExpectedProcessFailure(result, 'external source/model drift mutant unexpectedly passed');
  assert.match(output, /Bound external transport semantics changed/u);
  console.log(
    'External source/model mutation guard rejects changed transport semantics with unchanged external model.',
  );
} finally {
  mutationFiles.restoreAll();
}
mutationFiles.dispose();
