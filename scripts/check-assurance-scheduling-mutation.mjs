import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'scripts/run-assurance.mjs');
const original = fs.readFileSync(target, 'utf8');
const formalTarget = path.join(root, 'scripts/formal.mjs');
const formalOriginal = fs.readFileSync(formalTarget, 'utf8');
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
    assert.notEqual(result.status, 0, `${label} scheduling mutant unexpectedly passed`);
    assert.match(output, pattern, `${label} scheduling mutant failed for an unrelated reason`);
    console.log(`Assurance scheduling mutation guard rejects ${label}.`);
  } finally {
    fs.writeFileSync(target, original);
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
    assert.notEqual(result.status, 0, `${label} scheduling mutant unexpectedly passed`);
    assert.match(output, pattern, `${label} scheduling mutant failed for an unrelated reason`);
    console.log(`Assurance scheduling mutation guard rejects ${label}.`);
  } finally {
    fs.writeFileSync(formalTarget, formalOriginal);
  }
}

try {
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
    'parallel process-fault suite',
    (text) =>
      text.replace(
        "  ['public mapping', process.execPath, ['scripts/check-formal-implementation-conformance.mjs']],\n]);\nrun('real process faults', process.execPath, ['--test', ...processTests]);",
        "  ['public mapping', process.execPath, ['scripts/check-formal-implementation-conformance.mjs']],\n  ['real process faults', process.execPath, ['--test', ...processTests]],\n]);",
      ),
    /Real process faults must run outside runParallel/u,
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
}
