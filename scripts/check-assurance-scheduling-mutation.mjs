import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';
import { createMutationFileGuard } from './mutation-file-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutationFiles = createMutationFileGuard();
const target = path.join(root, 'scripts/run-assurance.mjs');
const original = fs.readFileSync(target, 'utf8');
const formalTarget = path.join(root, 'scripts/formal.mjs');
const formalOriginal = fs.readFileSync(formalTarget, 'utf8');
const packageTarget = path.join(root, 'package.json');
const packageOriginal = fs.readFileSync(packageTarget, 'utf8');
function assertUniqueMutationAnchor(source, mutate, label) {
  let anchor;
  let calls = 0;
  mutate({
    replace(from) {
      calls++;
      anchor = from;
      return '';
    },
  });
  assert.equal(calls, 1, `${label} mutation must perform exactly one string replacement`);
  assert.equal(typeof anchor, 'string', `${label} mutation anchor must be a string`);
  assert.equal(source.split(anchor).length, 2, `${label} mutation anchor is stale or not unique`);
}
function expectSchedulingFailure(label, mutate, pattern) {
  const mutant = mutate(original);
  assert.notEqual(mutant, original, `${label} scheduling mutation anchor is stale`);
  assertUniqueMutationAnchor(original, mutate, label);
  mutationFiles.writeFileSync(target, mutant);
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
    mutationFiles.restoreAll();
  }
}
function expectProcessTreeContainmentFailure(label, mutate) {
  const mutant = mutate(original);
  assert.notEqual(mutant, original, `${label} process-tree mutation anchor is stale`);
  assertUniqueMutationAnchor(original, mutate, label);
  mutationFiles.writeFileSync(target, mutant);
  try {
    const result = spawnSync(
      process.execPath,
      ['scripts/run-assurance.mjs', '--self-test-process-tree'],
      {
        cwd: root,
        encoding: 'utf8',
        env: process.env,
        timeout: 5_000,
      },
    );
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    requireExpectedProcessFailure(result, `${label} process-tree mutant unexpectedly passed`);
    assert.match(
      output,
      /orphan descendant process/u,
      `${label} process-tree mutant failed for an unrelated reason`,
    );
    console.log(`Assurance scheduling mutation guard rejects ${label}.`);
  } finally {
    mutationFiles.restoreAll();
  }
}

function expectPackageSchedulingFailure(label, mutate, pattern) {
  const mutant = mutate(packageOriginal);
  assert.notEqual(mutant, packageOriginal, `${label} scheduling mutation anchor is stale`);
  assertUniqueMutationAnchor(packageOriginal, mutate, label);
  mutationFiles.writeFileSync(packageTarget, mutant);
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
    mutationFiles.restoreAll();
  }
}
function expectFormalSchedulingFailure(label, mutate, pattern) {
  const mutant = mutate(formalOriginal);
  assert.notEqual(mutant, formalOriginal, `${label} scheduling mutation anchor is stale`);
  assertUniqueMutationAnchor(formalOriginal, mutate, label);
  mutationFiles.writeFileSync(formalTarget, mutant);
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
    mutationFiles.restoreAll();
  }
}

try {
  expectProcessTreeContainmentFailure('direct-child-only failure cleanup', (text) =>
    text.replace("process.kill(-pid, 'SIGKILL');", "child.kill('SIGKILL');"),
  );
  expectSchedulingFailure(
    'unbounded failed-child cleanup',
    (text) => text.replace('      pending.get(child)?.armCleanupTimeout();', '      void child;'),
    /bounded wait for every direct child/u,
  );
  expectSchedulingFailure(
    'unsynchronized descendant readiness',
    (text) =>
      text.replace(
        '    fs.writeFileSync(${JSON.stringify(readyMarker)}, String(process.pid));',
        '    void readyMarker;',
      ),
    /descendants must report readiness/u,
  );
  expectSchedulingFailure(
    'scheduler-sensitive self-expiring descendant',
    (text) =>
      text.replace(
        '    fs.writeFileSync(${JSON.stringify(readyMarker)}, String(process.pid));\n    setInterval(() => {}, 1000);',
        '    fs.writeFileSync(${JSON.stringify(readyMarker)}, String(process.pid));\n    setTimeout(() => process.exit(0), 400);',
      ),
    /must remain alive until explicit containment kills them|must not self-expire/u,
  );
  expectSchedulingFailure(
    'lost mutation-descendant fallback cleanup',
    (text) =>
      text.replace('    await cleanupReadyDescendants();', '    void cleanupReadyDescendants;'),
    /clean intentionally orphaned mutation descendants/u,
  );
  expectSchedulingFailure(
    'lost process-tree containment self-test',
    (text) =>
      text.replace(
        "run('parallel process-tree containment self-test', process.execPath, [\n  'scripts/run-assurance.mjs',\n  '--self-test-process-tree',\n]);\n",
        '',
      ),
    /descendant process-tree containment self-test exactly once/u,
  );
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
    'overcommitted two-core implementation traces',
    (text) =>
      text.replace(
        'logicalCpus <= 2\n    ? Math.max(1, logicalCpus)\n    : Math.max(4,',
        'logicalCpus <= 2\n    ? 4\n    : Math.max(4,',
      ),
    /Two-core CI must not overcommit implementation-trace test concurrency/u,
  );
  expectSchedulingFailure(
    'lost load-aware TLC worker budget',
    (text) => text.replace('process.env.WORKONCE_TLC_WORKERS = tlcWorkers;', ''),
    /load-aware TLC worker budget/u,
  );
  expectSchedulingFailure(
    'high-core TLC worker budget ignores host load',
    (text) =>
      text.replace(
        'Math.floor(Math.max(2, logicalCpus - currentLoad) / 2)',
        'Math.floor(logicalCpus / 2)',
      ),
    /twelve-worker ceiling load-aware/u,
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
        "const parentShardModes = ['--runtime-only', '--non-runtime-only'];",
        "const parentShardModes = ['--runtime-only', '--non-runtime-only', '--external-only'];",
      ),
    /formal\.mjs must use exactly the reviewed two shards/u,
  );
  expectFormalSchedulingFailure(
    'parallel formal shards on two-core CI',
    (text) => text.replace('if (availableParallelism() <= 2) {', 'if (false) {'),
    /Two-core CI must serialize formal shards/u,
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
  mutationFiles.restoreAll();
}
mutationFiles.dispose();
