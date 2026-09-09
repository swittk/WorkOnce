import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'scripts/run-assurance.mjs');
const original = fs.readFileSync(target, 'utf8');
const formalTarget = path.join(root, 'scripts/formal.mjs');
const formalOriginal = fs.readFileSync(formalTarget, 'utf8');
const packageTarget = path.join(root, 'package.json');
const packageOriginal = fs.readFileSync(packageTarget, 'utf8');
function expectSchedulingFailure(label, mutate, pattern) {
  fs.writeFileSync(target, mutate(original));
  try {
    const result = spawnSync(process.execPath, ['scripts/check-assurance-scheduling.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      timeout: 15_000,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    requireExpectedProcessFailure(result, `${label} scheduling mutant unexpectedly passed`);
    assert.match(output, pattern, `${label} scheduling mutant failed for an unrelated reason`);
    console.log(`Assurance scheduling mutation guard rejects ${label}.`);
  } finally {
    fs.writeFileSync(target, original);
  }
}
function expectPackageSchedulingFailure(label, mutate, pattern) {
  fs.writeFileSync(packageTarget, mutate(packageOriginal));
  try {
    const result = spawnSync(process.execPath, ['scripts/check-assurance-scheduling.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      timeout: 15_000,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    requireExpectedProcessFailure(result, `${label} scheduling mutant unexpectedly passed`);
    assert.match(output, pattern, `${label} scheduling mutant failed for an unrelated reason`);
    console.log(`Assurance scheduling mutation guard rejects ${label}.`);
  } finally {
    fs.writeFileSync(packageTarget, packageOriginal);
  }
}
function expectFormalSchedulingFailure(label, mutate, pattern) {
  fs.writeFileSync(formalTarget, mutate(formalOriginal));
  try {
    const result = spawnSync(process.execPath, ['scripts/check-assurance-scheduling.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      timeout: 15_000,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    requireExpectedProcessFailure(result, `${label} scheduling mutant unexpectedly passed`);
    assert.match(output, pattern, `${label} scheduling mutant failed for an unrelated reason`);
    console.log(`Assurance scheduling mutation guard rejects ${label}.`);
  } finally {
    fs.writeFileSync(formalTarget, formalOriginal);
  }
}

try {
  expectPackageSchedulingFailure(
    'parallel package process-fault suite',
    (text) => text.replace(' --test-concurrency=1', ''),
    /test:process must serialize real process-fault files/u,
  );
  expectSchedulingFailure(
    'source-mutating lifecycle proof wrapper in read-only unit batch',
    (text) =>
      text.replace("\n  .filter((name) => name !== 'lifecycle-proof-controls.test.mjs')", ''),
    /source-mutating lifecycle proof wrapper must stay out/u,
  );
  expectSchedulingFailure(
    'lost dedicated type-contract compile',
    (text) => text.replace("'tsconfig.tests.json'", "'tsconfig.json'"),
    /dedicated type-contract test compile/u,
  );
  expectSchedulingFailure(
    'lost load-aware TLC worker budget',
    (text) => text.replace('process.env.WORKONCE_TLC_WORKERS = tlcWorkers;', ''),
    /load-aware TLC worker budget/u,
  );
  expectSchedulingFailure(
    'lost TLC workspace isolation preflight',
    (text) =>
      text.replace(
        "'scripts/check-tlc-workspace-isolation.mjs'",
        "'scripts/check-assurance-verdict-integrity.mjs'",
      ),
    /TLC workspace isolation audit/u,
  );
  expectSchedulingFailure(
    'cross-family TLC concurrency',
    (text) =>
      text.replace(
        "  ['packed consumer', process.execPath, ['scripts/consumer-smoke.mjs']],\n]);\nrun('TLC lifecycle/runtime/read/policy boundaries + mutation guards', process.execPath, [\n  'scripts/formal.mjs',\n]);",
        "  ['packed consumer', process.execPath, ['scripts/consumer-smoke.mjs']],\n  ['TLC lifecycle/runtime/read/policy boundaries + mutation guards', process.execPath, ['scripts/formal.mjs']],\n]);",
      ),
    /storage-formal and formal\.mjs must never be co-scheduled/u,
  );
  expectSchedulingFailure(
    'process faults overlap compiler/mapping work',
    (text) =>
      text.replace(
        "  [\n    'implementation traces',\n    process.execPath,\n    ['--test', '--test-concurrency', unitTestConcurrency, ...unitTests],\n  ],\n]);",
        "  [\n    'implementation traces',\n    process.execPath,\n    ['--test', '--test-concurrency', unitTestConcurrency, ...unitTests],\n  ],\n  ['real process faults', process.execPath, ['--test', '--test-concurrency', '3', ...processTests]],\n]);",
      ),
    /Expected exactly one bounded process-fault parallel group|must not overlap compiler\/mapping work/u,
  );
  expectSchedulingFailure(
    'unbounded HPSERVER process-fault file concurrency',
    (text) =>
      text.replace(
        "['real process faults', process.execPath, ['--test', '--test-concurrency', '3', ...processTests]],",
        "['real process faults', process.execPath, ['--test', ...processTests]],",
      ),
    /full assurance must cap process-fault file concurrency at three/u,
  );
  expectSchedulingFailure(
    'parallel source-mutating guards',
    (text) =>
      text.replace(
        "run('policy implementation mutation guards', process.execPath, [\n  'scripts/check-policy-implementation-mutations.mjs',\n]);",
        "await runParallel([[\n  'policy implementation mutation guards', process.execPath, ['scripts/check-policy-implementation-mutations.mjs'],\n]]);",
      ),
    /Source\/dist-mutating assurance guards must not run in runParallel/u,
  );
  expectFormalSchedulingFailure(
    'a third formal shard',
    (text) =>
      text.replace(
        "    runShard('--non-runtime-only'),",
        "    runShard('--non-runtime-only'),\n    runShard('--external-only'),",
      ),
    /formal\.mjs must use exactly the reviewed two shards/u,
  );
  expectFormalSchedulingFailure(
    'external-family shard imbalance',
    (text) =>
      text.replace(
        'if (runtimeOnly) {\n  const { runExternalTransportSamples, assertExternalTransportSamples } = await import(',
        'if (nonRuntimeOnly) {\n  const { runExternalTransportSamples, assertExternalTransportSamples } = await import(',
      ),
    /External formal family must stay on the reviewed lighter runtime shard/u,
  );
} finally {
  fs.writeFileSync(target, original);
  fs.writeFileSync(formalTarget, formalOriginal);
  fs.writeFileSync(packageTarget, packageOriginal);
}
