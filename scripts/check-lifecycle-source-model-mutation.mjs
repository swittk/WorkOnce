import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const result = spawnSync(process.execPath, ['scripts/check-lifecycle-proof-binding.mjs'], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, WORKONCE_LIFECYCLE_BINDING_MUTANT: 'src/work.ts' },
  timeout: 15_000,
});
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
requireExpectedProcessFailure(result, 'lifecycle source/model drift mutant unexpectedly passed');
assert.match(output, /Lifecycle source\/model binding drifted/u);
console.log(
  'Lifecycle source/model mutation guard rejects changed claim scanning with unchanged A model.',
);
