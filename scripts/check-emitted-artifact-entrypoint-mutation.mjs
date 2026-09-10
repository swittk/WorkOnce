import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

import { createMutationFileGuard } from './mutation-file-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutationFiles = createMutationFileGuard();
const packagePath = path.join(root, 'package.json');
const original = fs.readFileSync(packagePath, 'utf8');
const assurancePath = path.join(root, 'scripts/run-assurance.mjs');
const assuranceOriginal = fs.readFileSync(assurancePath, 'utf8');
try {
  const pkg = JSON.parse(original);
  assert.equal(
    pkg.scripts['test:process'],
    'node scripts/build-source-binding.mjs && node --test --test-concurrency=1 test/process/*.test.mjs',
    'test:process mutation anchor is stale',
  );
  pkg.scripts['test:process'] = 'node --test test/process/*.test.mjs';
  mutationFiles.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  const result = spawnSync(process.execPath, ['scripts/check-emitted-artifact-entrypoints.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 15_000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  requireExpectedProcessFailure(result, 'unguarded test:process entrypoint unexpectedly passed');
  assert.match(output, /test:process.*lost its required build\/binding guard/u);
  console.log(
    'Emitted-artifact entrypoint mutation guard rejects removal of test:process freshness.',
  );
  mutationFiles.restoreAll();
  const preparePath = path.join(root, 'scripts/prepare-package.mjs');
  const prepareOriginal = fs.readFileSync(preparePath, 'utf8');
  try {
    assert.equal(
      prepareOriginal.split('assertBuildSourceBinding();').length,
      2,
      'prepare-package binding anchor is stale or not unique',
    );
    mutationFiles.writeFileSync(
      preparePath,
      prepareOriginal.replace('assertBuildSourceBinding();', 'void 0;'),
    );
    const unboundPrepare = spawnSync(
      process.execPath,
      ['scripts/check-emitted-artifact-entrypoints.mjs'],
      { cwd: root, encoding: 'utf8', env: process.env, timeout: 15_000 },
    );
    const unboundOutput = `${unboundPrepare.stdout ?? ''}\n${unboundPrepare.stderr ?? ''}`;
    requireExpectedProcessFailure(unboundPrepare, 'unbound prepare reuse unexpectedly passed');
    assert.match(unboundOutput, /prepare-package\.mjs may reuse dist only after verifying/u);
    console.log(
      'Emitted-artifact entrypoint mutation guard rejects unbound package prepare reuse.',
    );
  } finally {
    mutationFiles.restoreAll();
  }

  try {
    const commentedGuard = prepareOriginal.replace(
      'assertBuildSourceBinding();',
      '// assertBuildSourceBinding();\n  void 0;',
    );
    assert.notEqual(
      commentedGuard,
      prepareOriginal,
      'comment-only prepare guard mutation anchor is stale',
    );
    mutationFiles.writeFileSync(preparePath, commentedGuard);
    const commentOnlyPrepare = spawnSync(
      process.execPath,
      ['scripts/check-emitted-artifact-entrypoints.mjs'],
      { cwd: root, encoding: 'utf8', env: process.env, timeout: 15_000 },
    );
    const commentOnlyOutput = `${commentOnlyPrepare.stdout ?? ''}\n${commentOnlyPrepare.stderr ?? ''}`;
    requireExpectedProcessFailure(
      commentOnlyPrepare,
      'comment-only prepare guard unexpectedly passed',
    );
    assert.match(commentOnlyOutput, /prepare-package\.mjs may reuse dist only after verifying/u);
    console.log('Emitted-artifact entrypoint checker ignores comment-only binding guards.');
  } finally {
    mutationFiles.restoreAll();
  }

  const formalPath = path.join(root, 'scripts/formal.mjs');
  const formalOriginal = fs.readFileSync(formalPath, 'utf8');
  try {
    const importAnchor = "await import('./runtime-boundary-refinement.mjs')";
    assert.equal(
      formalOriginal.split(importAnchor).length,
      2,
      'formal runtime producer import mutation anchor is stale or not unique',
    );
    mutationFiles.writeFileSync(
      formalPath,
      formalOriginal.replace(
        importAnchor,
        "await Promise.resolve({}); /* import('./runtime-boundary-refinement.mjs') */",
      ),
    );
    const commentOnlyImport = spawnSync(
      process.execPath,
      ['scripts/check-emitted-artifact-entrypoints.mjs'],
      { cwd: root, encoding: 'utf8', env: process.env, timeout: 15_000 },
    );
    const commentOnlyImportOutput = `${commentOnlyImport.stdout ?? ''}\n${commentOnlyImport.stderr ?? ''}`;
    requireExpectedProcessFailure(
      commentOnlyImport,
      'comment-only formal producer import unexpectedly passed',
    );
    assert.match(
      commentOnlyImportOutput,
      /formal\.mjs must verify the bound build before importing/u,
    );
    console.log('Emitted-artifact entrypoint checker ignores comment-only producer imports.');
  } finally {
    mutationFiles.restoreAll();
  }

  const buildAnchor = "await runParallel([\n  npmParallelEntry('format'";
  assert.equal(
    assuranceOriginal.split(buildAnchor).length,
    2,
    'startup-build anchor is stale or not unique',
  );
  mutationFiles.writeFileSync(
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
      timeout: 15_000,
    },
  );
  const earlyOutput = `${earlyConsumer.stdout ?? ''}\n${earlyConsumer.stderr ?? ''}`;
  requireExpectedProcessFailure(earlyConsumer, 'pre-build assurance consumer unexpectedly passed');
  assert.match(
    earlyOutput,
    /packed consumer.*exactly once|packed consumer.*before the single build/u,
  );
  console.log('Emitted-artifact entrypoint ordering rejects a consumer before the single build.');
  mutationFiles.restoreAll();
  const buildEntry = "  npmParallelEntry('single build', ['run', 'build']),";
  assert.equal(
    assuranceOriginal.split(buildEntry).length,
    2,
    'concurrent-build consumer anchor is stale or not unique',
  );
  mutationFiles.writeFileSync(
    assurancePath,
    assuranceOriginal.replace(
      buildEntry,
      `${buildEntry}
  ['unlisted concurrent dist consumer', process.execPath, ['scripts/consumer-smoke.mjs']],`,
    ),
  );
  const concurrentConsumer = spawnSync(
    process.execPath,
    ['scripts/check-emitted-artifact-entrypoints.mjs'],
    { cwd: root, encoding: 'utf8', env: process.env, timeout: 15_000 },
  );
  const concurrentOutput = `${concurrentConsumer.stdout ?? ''}
${concurrentConsumer.stderr ?? ''}`;
  requireExpectedProcessFailure(
    concurrentConsumer,
    'concurrent pre-build assurance consumer unexpectedly passed',
  );
  assert.match(
    concurrentOutput,
    /unlisted concurrent dist consumer.*before the single build.*pre-build exemption/u,
  );
  console.log(
    'Emitted-artifact entrypoint ordering rejects an unreviewed consumer concurrent with the single build.',
  );
} finally {
  mutationFiles.restoreAll();
}
mutationFiles.dispose();
