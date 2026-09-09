import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure, requireSuccessfulProcess } from './subprocess-outcome.mjs';

import { createMutationFileGuard } from './mutation-file-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutationFiles = createMutationFileGuard();
const baseConfigPath = path.join(root, 'formal/WorkOnce.cfg');
const extraConfigPath = path.join(root, 'formal/WorkOnceUnregisteredMutation.cfg');
const baseConfig = fs.readFileSync(baseConfigPath, 'utf8');

function runCoveragePlan() {
  return spawnSync(process.execPath, ['scripts/formal.mjs', '--config-coverage-only'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 15_000,
  });
}
function output(result) {
  return `${result.stdout ?? ''}
${result.stderr ?? ''}`;
}

const baseline = runCoveragePlan();
requireSuccessfulProcess(baseline, 'baseline formal mutation coverage plan');

try {
  mutationFiles.writeFileSync(extraConfigPath, baseConfig);
  const result = runCoveragePlan();
  requireExpectedProcessFailure(result, 'unregistered formal config unexpectedly passed');
  assert.match(output(result), /Formal config mutation coverage inventory drifted/u);
  assert.match(output(result), /WorkOnceUnregisteredMutation\.cfg/u);
} finally {
  mutationFiles.restoreAll();
}

try {
  const mutant = baseConfig.replace(
    'CHECK_DEADLOCK FALSE',
    '  UncoveredInvariant\nCHECK_DEADLOCK FALSE',
  );
  assert.notEqual(mutant, baseConfig, 'WorkOnce.cfg mutation anchor is missing');
  mutationFiles.writeFileSync(baseConfigPath, mutant);
  const result = runCoveragePlan();
  requireExpectedProcessFailure(result, 'uncovered configured invariant unexpectedly passed');
  assert.match(output(result), /Formal mutation coverage drifted for formal\/WorkOnce\.cfg/u);
  assert.match(output(result), /UncoveredInvariant/u);
} finally {
  mutationFiles.restoreAll();
}

console.log(
  'Formal config coverage rejects unregistered configs and unguarded configured invariants.',
);
mutationFiles.dispose();
