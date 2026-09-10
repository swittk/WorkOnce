import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { requireSuccessfulProcess } from '../scripts/subprocess-outcome.mjs';
import { createMutationFileGuard } from '../scripts/mutation-file-guard.mjs';

function run(script) {
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: process.env,
    timeout: 300000,
  });
  return requireSuccessfulProcess(result, `${script} child`);
}

test('lifecycle proof is source/model bound and critical compiled mutants are killed', () => {
  assert.match(run('scripts/check-lifecycle-proof-binding.mjs'), /binding matches/u);
  assert.match(
    run('scripts/check-lifecycle-source-model-mutation.mjs'),
    /source\/model mutation guard/u,
  );
  const mutations = run('scripts/check-lifecycle-implementation-mutations.mjs');
  assert.match(mutations, /stale-fence acceptance/u);
  assert.match(mutations, /receipt identity collapse/u);
  assert.match(mutations, /wrong completion-before-cancel rule/u);
  assert.match(mutations, /claim-scan widening removal/u);
  assert.match(mutations, /claim limit off-by-one/u);
  assert.match(mutations, /retry reset retaining old receipt/u);
});

test('lifecycle binding write mode ignores mutation-only digest injection', () => {
  const target = 'assurance/lifecycle-proof-binding.json';
  const original = fs.readFileSync(target, 'utf8');
  const guard = createMutationFileGuard();
  guard.writeFileSync(target, original);
  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/check-lifecycle-proof-binding.mjs', '--write'],
      {
        encoding: 'utf8',
        env: { ...process.env, WORKONCE_LIFECYCLE_BINDING_MUTANT: 'src/work.ts' },
        timeout: 300000,
      },
    );
    requireSuccessfulProcess(result, 'lifecycle binding write child');
    assert.equal(fs.readFileSync(target, 'utf8'), original);
  } finally {
    guard.dispose();
  }
});
