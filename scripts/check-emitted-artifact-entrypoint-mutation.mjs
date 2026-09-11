import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertEmittedArtifactEntrypoints } from './check-emitted-artifact-entrypoints.mjs';

import { createMutationFileGuard } from './mutation-file-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutationFiles = createMutationFileGuard();
const packagePath = path.join(root, 'package.json');
const original = fs.readFileSync(packagePath, 'utf8');
const assurancePath = path.join(root, 'scripts/run-assurance.mjs');
const assuranceOriginal = fs.readFileSync(assurancePath, 'utf8');
function expectCheckerFailure(context, pattern) {
  let failure;
  try {
    assertEmittedArtifactEntrypoints();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, `${context} unexpectedly passed`);
  assert.match(
    `${failure.name}: ${failure.message}`,
    pattern,
    `${context} failed for an unrelated reason`,
  );
}
try {
  const pkg = JSON.parse(original);
  assert.equal(
    pkg.scripts['test:process'],
    'node scripts/build-source-binding.mjs && node --test --test-concurrency=1 test/process/*.test.mjs',
    'test:process mutation anchor is stale',
  );
  pkg.scripts['test:process'] = 'node --test test/process/*.test.mjs';
  mutationFiles.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  expectCheckerFailure(
    'unguarded test:process entrypoint',
    /test:process.*lost its required build\/binding guard/u,
  );
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
    expectCheckerFailure(
      'unbound prepare reuse',
      /prepare-package\.mjs may reuse dist only after verifying/u,
    );
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
    expectCheckerFailure(
      'comment-only prepare guard',
      /prepare-package\.mjs may reuse dist only after verifying/u,
    );
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
    expectCheckerFailure(
      'comment-only formal producer import',
      /formal\.mjs must verify the bound build before importing/u,
    );
    console.log('Emitted-artifact entrypoint checker ignores comment-only producer imports.');
  } finally {
    mutationFiles.restoreAll();
  }

  try {
    const importAnchor = "await import('./runtime-boundary-refinement.mjs')";
    const dormantProducer = formalOriginal.replace(
      importAnchor,
      `await Promise.resolve({});
async function dormantRuntimeProducer() { return import('./runtime-boundary-refinement.mjs'); }`,
    );
    mutationFiles.writeFileSync(formalPath, dormantProducer);
    expectCheckerFailure(
      'dormant formal producer import',
      /formal\.mjs must verify the bound build before importing/u,
    );
    console.log('Emitted-artifact entrypoint checker ignores dormant dynamic producer imports.');
  } finally {
    mutationFiles.restoreAll();
  }

  try {
    const earlyStaticProducer = `import './runtime-boundary-refinement.mjs';\n${formalOriginal}`;
    mutationFiles.writeFileSync(formalPath, earlyStaticProducer);
    expectCheckerFailure(
      'early static formal producer import',
      /formal\.mjs must verify the bound build before importing/u,
    );
    console.log(
      'Emitted-artifact entrypoint checker rejects static producers that execute before the binding guard.',
    );
  } finally {
    mutationFiles.restoreAll();
  }

  try {
    const earlyDoWhileProducer = `do { await import('./runtime-boundary-refinement.mjs'); } while (false);\n${formalOriginal}`;
    mutationFiles.writeFileSync(formalPath, earlyDoWhileProducer);
    expectCheckerFailure(
      'early do-while formal producer import',
      /formal\.mjs must verify the bound build before importing/u,
    );
    console.log(
      'Emitted-artifact entrypoint checker treats do-while(false) bodies as executing once.',
    );
  } finally {
    mutationFiles.restoreAll();
  }

  try {
    const earlyIifeProducer = `(async () => { await import('./runtime-boundary-refinement.mjs'); })();\n${formalOriginal}`;
    mutationFiles.writeFileSync(formalPath, earlyIifeProducer);
    expectCheckerFailure(
      'early IIFE formal producer import',
      /formal\.mjs must verify the bound build before importing/u,
    );
    console.log(
      'Emitted-artifact entrypoint checker treats top-level IIFE bodies as module initialization.',
    );
  } finally {
    mutationFiles.restoreAll();
  }

  try {
    const importAnchor =
      "  const { runRuntimeBoundarySamples } = await import('./runtime-boundary-refinement.mjs');";
    assert.equal(
      formalOriginal.split(importAnchor).length,
      2,
      'constant-false formal producer import mutation anchor is stale or not unique',
    );
    mutationFiles.writeFileSync(
      formalPath,
      formalOriginal.replace(
        importAnchor,
        "  let dormantRuntimeProducer;\n  if (0) dormantRuntimeProducer = await import('./runtime-boundary-refinement.mjs');\n  const { runRuntimeBoundarySamples } = dormantRuntimeProducer ?? {};",
      ),
    );
    expectCheckerFailure(
      'constant-false formal producer import',
      /formal\.mjs must verify the bound build before importing/u,
    );
    console.log('Emitted-artifact entrypoint checker ignores constant-false producer imports.');
  } finally {
    mutationFiles.restoreAll();
  }

  try {
    const packedConsumerEntry =
      "  ['packed consumer', process.execPath, ['scripts/consumer-smoke.mjs']],\n";
    const storageBatchAnchor =
      "await runParallel([\n  ['TLC storage/conformance + mutation guards'";
    assert.equal(
      assuranceOriginal.split(packedConsumerEntry).length,
      2,
      'dormant packed-consumer entry anchor is stale or not unique',
    );
    assert.equal(
      assuranceOriginal.split(storageBatchAnchor).length,
      2,
      'dormant packed-consumer batch anchor is stale or not unique',
    );
    const dormantConsumer = assuranceOriginal
      .replace(packedConsumerEntry, '')
      .replace(
        storageBatchAnchor,
        "async function dormantPackedConsumer() {\n  await runParallel([['packed consumer', process.execPath, ['scripts/consumer-smoke.mjs']]]);\n}\nvoid dormantPackedConsumer;\n" +
          storageBatchAnchor,
      );
    mutationFiles.writeFileSync(assurancePath, dormantConsumer);
    expectCheckerFailure(
      'dormant packed consumer',
      /required step 'packed consumer'.*exactly once/u,
    );
    console.log('Emitted-artifact entrypoint checker ignores dormant assurance consumers.');
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
  expectCheckerFailure(
    'pre-build assurance consumer',
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
  expectCheckerFailure(
    'concurrent pre-build assurance consumer',
    /unlisted concurrent dist consumer.*before the single build.*pre-build exemption/u,
  );
  console.log(
    'Emitted-artifact entrypoint ordering rejects an unreviewed consumer concurrent with the single build.',
  );
} finally {
  mutationFiles.restoreAll();
}
mutationFiles.dispose();
