import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(root, 'package.json');
const original = fs.readFileSync(packagePath, 'utf8');
const assurancePath = path.join(root, 'scripts/run-assurance.mjs');
const assuranceOriginal = fs.readFileSync(assurancePath, 'utf8');
try {
  const pkg = JSON.parse(original);
  pkg.scripts['test:process'] = 'node --test test/process/*.test.mjs';
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  const result = spawnSync(process.execPath, ['scripts/check-emitted-artifact-entrypoints.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.notEqual(result.status, 0, 'unguarded test:process entrypoint unexpectedly passed');
  assert.match(output, /test:process.*lost its required build\/binding guard/u);
  console.log(
    'Emitted-artifact entrypoint mutation guard rejects removal of test:process freshness.',
  );

  fs.writeFileSync(packagePath, original);
  const preparePath = path.join(root, 'scripts/prepare-package.mjs');
  const prepareOriginal = fs.readFileSync(preparePath, 'utf8');
  try {
    fs.writeFileSync(
      preparePath,
      prepareOriginal.replace('assertBuildSourceBinding();', 'void 0;'),
    );
    const unboundPrepare = spawnSync(
      process.execPath,
      ['scripts/check-emitted-artifact-entrypoints.mjs'],
      { cwd: root, encoding: 'utf8', env: process.env },
    );
    const unboundOutput = `${unboundPrepare.stdout ?? ''}\n${unboundPrepare.stderr ?? ''}`;
    assert.notEqual(unboundPrepare.status, 0, 'unbound prepare reuse unexpectedly passed');
    assert.match(unboundOutput, /prepare-package\.mjs may reuse dist only after verifying/u);
    console.log(
      'Emitted-artifact entrypoint mutation guard rejects unbound package prepare reuse.',
    );
  } finally {
    fs.writeFileSync(preparePath, prepareOriginal);
  }

  const buildAnchor = "runNpm('single build'";
  assert.equal(assuranceOriginal.includes(buildAnchor), true, 'single-build anchor is stale');
  fs.writeFileSync(
    assurancePath,
    assuranceOriginal.replace(
      buildAnchor,
      "run('packed consumer', process.execPath, ['scripts/consumer-smoke.mjs']);\n" + buildAnchor,
    ),
  );
  const earlyConsumer = spawnSync(
    process.execPath,
    ['scripts/check-emitted-artifact-entrypoints.mjs'],
    {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
    },
  );
  const earlyOutput = `${earlyConsumer.stdout ?? ''}\n${earlyConsumer.stderr ?? ''}`;
  assert.notEqual(earlyConsumer.status, 0, 'pre-build assurance consumer unexpectedly passed');
  assert.match(
    earlyOutput,
    /packed consumer.*exactly once|packed consumer.*before the single build/u,
  );
  console.log('Emitted-artifact entrypoint ordering rejects a consumer before the single build.');
} finally {
  fs.writeFileSync(packagePath, original);
  fs.writeFileSync(assurancePath, assuranceOriginal);
}
