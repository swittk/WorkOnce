import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

function run(script) {
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: process.env,
    timeout: 30000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.status, 0, output.slice(-4000));
  return output;
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
