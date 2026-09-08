import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'scripts/formal.mjs');
const original = fs.readFileSync(target, 'utf8');
const runnerTarget = path.join(root, 'scripts/run-assurance.mjs');
const runnerOriginal = fs.readFileSync(runnerTarget, 'utf8');
const configTarget = path.join(root, 'tsconfig.json');
const configOriginal = fs.readFileSync(configTarget, 'utf8');

function run(script, ...args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
}
function output(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

try {
  fs.writeFileSync(target, `${original}\n// assurance-infrastructure-binding-mutant\n`);

  const manifest = run(
    'scripts/check-formal-implementation-conformance.mjs',
    '--check-infrastructure-binding-only',
  );
  assert.notEqual(manifest.status, 0, 'formal manifest accepted a changed proof runner');
  assert.match(output(manifest), /Assurance infrastructure digest drifted/u);

  const bounded = run('scripts/check-bounded-trace-domain.mjs', '--check-evidence-binding-only');
  assert.notEqual(bounded.status, 0, 'bounded trace report accepted a changed proof runner');
  assert.match(output(bounded), /Bounded trace evidence digest drifted/u);

  fs.writeFileSync(target, original);
  const runnerMutant = runnerOriginal.replace(
    "'scripts/check-assurance-scheduling.mjs'",
    "'scripts/check-unbound-assurance-mutant.mjs'",
  );
  assert.notEqual(runnerMutant, runnerOriginal, 'assurance runner mutation anchor is missing');
  fs.writeFileSync(runnerTarget, runnerMutant);
  const runnerBinding = run(
    'scripts/check-formal-implementation-conformance.mjs',
    '--check-infrastructure-binding-only',
  );
  assert.notEqual(runnerBinding.status, 0, 'formal manifest accepted an unbound assurance runner');
  assert.match(output(runnerBinding), /Full assurance invokes unbound proof\/checker scripts/u);

  fs.writeFileSync(runnerTarget, runnerOriginal);
  const configMutant = configOriginal.replace('\"target\": \"ES2018\"', '\"target\": \"ES2020\"');
  assert.notEqual(configMutant, configOriginal, 'compiler target mutation anchor is missing');
  fs.writeFileSync(configTarget, configMutant);
  const configBinding = run('scripts/check-formal-implementation-conformance.mjs', '--write');
  assert.notEqual(
    configBinding.status,
    0,
    'ordinary manifest update accepted compiler-config drift',
  );
  assert.match(
    output(configBinding),
    /Bound compiler\/toolchain semantics changed without explicit source\/model review/u,
  );

  console.log(
    'Assurance infrastructure binding rejects proof-runner mutation, unbound full-gate checkers, and unacknowledged compiler/toolchain drift.',
  );
} finally {
  fs.writeFileSync(target, original);
  fs.writeFileSync(runnerTarget, runnerOriginal);
  fs.writeFileSync(configTarget, configOriginal);
}
