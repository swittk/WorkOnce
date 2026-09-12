import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure, requireSuccessfulProcess } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bindingCheck(env = process.env) {
  return spawnSync(process.execPath, ['scripts/check-lifecycle-proof-binding.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env,
    timeout: 15_000,
  });
}
requireSuccessfulProcess(bindingCheck(), 'baseline lifecycle source/model binding');

const result = bindingCheck({ ...process.env, WORKONCE_LIFECYCLE_BINDING_MUTANT: 'src/work.ts' });
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
requireExpectedProcessFailure(result, 'lifecycle source/model drift mutant unexpectedly passed');
assert.match(output, /Lifecycle source\/model binding drifted/u);
console.log(
  'Lifecycle source/model mutation guard rejects changed claim scanning with unchanged A model.',
);
