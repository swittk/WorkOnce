import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism, loadavg, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { requireSuccessfulProcess } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logicalCpus = availableParallelism();
const currentLoad = loadavg()[0];
const availableTestCpus = Math.floor(logicalCpus - currentLoad);
const unitTestConcurrency = String(
  logicalCpus <= 2
    ? Math.max(1, logicalCpus)
    : Math.max(4, Math.min(8, logicalCpus, availableTestCpus)),
);
const tlcWorkers = String(
  logicalCpus >= 16
    ? 12
    : Math.max(2, Math.min(8, Math.floor(Math.max(2, logicalCpus - currentLoad) / 2))),
);
process.env.WORKONCE_TLC_WORKERS = tlcWorkers;
function run(label, command, args) {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  requireSuccessfulProcess(result, label);
  console.log(`[assurance] ${label}: ${Math.round(performance.now() - started)} ms`);
}
function runNpm(label, args) {
  if (process.platform === 'win32') {
    run(label, process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args]);
    return;
  }
  run(label, 'npm', args);
}
function npmParallelEntry(label, args) {
  if (process.platform === 'win32')
    return [label, process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args]];
  return [label, 'npm', args];
}
function terminateProcessTree(child) {
  const pid = child.pid;
  if (!Number.isInteger(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH')
      console.error(`[assurance] process-tree termination failed for pid ${pid}:`, error);
  }
}
async function runParallel(entries) {
  const started = performance.now();
  const children = new Set();
  let primaryError;
  const terminateAllProcessTrees = () => {
    for (const child of children) terminateProcessTree(child);
  };
  const outcomes = await Promise.allSettled(
    entries.map(
      ([label, command, args]) =>
        new Promise((resolvePromise, rejectPromise) => {
          const childStarted = performance.now();
          const child = spawn(command, args, {
            cwd: root,
            env: process.env,
            stdio: 'inherit',
            shell: false,
            detached: process.platform !== 'win32',
          });
          children.add(child);
          const fail = (error) => {
            if (primaryError === undefined) {
              primaryError = error;
              terminateAllProcessTrees();
            }
            rejectPromise(error);
          };
          child.once('error', (error) => {
            fail(error);
            children.delete(child);
          });
          child.once('exit', (code, signal) => {
            if (signal) {
              fail(new Error(`${label} terminated by ${signal}`));
              children.delete(child);
              return;
            }
            if (code !== 0) {
              fail(new Error(`${label} exited with status ${String(code)}`));
              children.delete(child);
              return;
            }
            children.delete(child);
            console.log(`[assurance] ${label}: ${Math.round(performance.now() - childStarted)} ms`);
            resolvePromise();
          });
        }),
    ),
  );
  if (primaryError !== undefined) throw primaryError;
  const unexpectedFailure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (unexpectedFailure) throw unexpectedFailure.reason;
  console.log(`[assurance] parallel batch: ${Math.round(performance.now() - started)} ms`);
}
async function runParallelProcessTreeSelfTest() {
  if (process.platform === 'win32') {
    console.log('Parallel assurance process-tree containment uses taskkill /t on Windows.');
    return;
  }
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'workonce-assurance-tree-'));
  const failedMarker = path.join(directory, 'failed-descendant.txt');
  const siblingMarker = path.join(directory, 'sibling-descendant.txt');
  const descendantCode = (marker) => `
    const fs = require('node:fs');
    setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(marker)}, 'late\\n');
      process.exit(0);
    }, 400);
  `;
  const parentCode = (marker, fail) => `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode(marker))}], { stdio: 'ignore' });
    ${fail ? 'setTimeout(() => process.exit(17), 60);' : ''}
    setInterval(() => {}, 1000);
  `;
  try {
    let observedFailure = false;
    try {
      const selfTestEntries = [
        ['process-tree failing parent', process.execPath, ['-e', parentCode(failedMarker, true)]],
        ['process-tree sibling parent', process.execPath, ['-e', parentCode(siblingMarker, false)]],
      ];
      await runParallel(selfTestEntries);
    } catch (error) {
      if (!/process-tree failing parent exited with status 17/u.test(String(error?.message)))
        throw error;
      observedFailure = true;
    }
    if (!observedFailure)
      throw new Error('parallel process-tree self-test did not observe parent failure');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 650));
    if (fs.existsSync(failedMarker) || fs.existsSync(siblingMarker))
      throw new Error('parallel assurance failure left an orphan descendant process running');
    console.log(
      'Parallel assurance failure contains both failed-child and sibling descendant process trees.',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
if (process.argv.includes('--self-test-process-tree')) {
  await runParallelProcessTreeSelfTest();
  process.exit(0);
}
const unitTests = fs
  .readdirSync(path.join(root, 'test'))
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => name !== 'lifecycle-proof-controls.test.mjs')
  .filter((name) => name !== 'lifecycle-formal.test.mjs')
  .sort()
  .map((name) => `test/${name}`);
const processTests = fs
  .readdirSync(path.join(root, 'test/process'))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => `test/process/${name}`);
await runParallel([
  npmParallelEntry('format', ['run', 'format:check']),
  [
    'type-contract tests',
    process.execPath,
    ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.tests.json'],
  ],
  npmParallelEntry('single build', ['run', 'build']),
]);
await runParallel([
  [
    'internal semantic topology audit',
    process.execPath,
    ['scripts/check-internal-semantic-inventory.mjs'],
  ],
  [
    'TLC outcome classification live probe',
    process.execPath,
    ['scripts/check-tlc-outcome-classification.mjs'],
  ],
  [
    'emitted-artifact entrypoint audit',
    process.execPath,
    ['scripts/check-emitted-artifact-entrypoints.mjs'],
  ],
  [
    'assurance verdict integrity audit',
    process.execPath,
    ['scripts/check-assurance-verdict-integrity.mjs'],
  ],
  [
    'TLC workspace isolation audit',
    process.execPath,
    ['scripts/check-tlc-workspace-isolation.mjs'],
  ],
]);
run('internal semantic topology mutation guard', process.execPath, [
  'scripts/check-internal-semantic-inventory-mutation.mjs',
]);
run('formal config mutation coverage inventory guard', process.execPath, [
  'scripts/check-formal-config-coverage-mutation.mjs',
]);
run('build/source freshness mutation guard', process.execPath, [
  'scripts/check-build-source-binding-mutation.mjs',
]);
run('emitted-artifact entrypoint mutation guard', process.execPath, [
  'scripts/check-emitted-artifact-entrypoint-mutation.mjs',
]);
run('alias runtime/type mutation guard', process.execPath, [
  'scripts/check-alias-contract-mutation.mjs',
]);
run('compiler source-path portability mutation guard', process.execPath, [
  'scripts/check-source-path-portability-mutation.mjs',
]);
run('assurance verdict integrity mutation guard', process.execPath, [
  'scripts/check-assurance-verdict-integrity-mutation.mjs',
]);
run('TLC workspace isolation mutation guard', process.execPath, [
  'scripts/check-tlc-workspace-isolation-mutation.mjs',
]);
await runParallel([
  npmParallelEntry('ES2018 Web Worker', ['run', 'check:web']),
  [
    'formal config parser',
    process.execPath,
    ['scripts/check-formal-implementation-conformance.mjs', '--self-test-config-checks'],
  ],
  [
    'type identity trivia',
    process.execPath,
    ['scripts/formal-implementation-surface.cjs', '--self-test-trivia-ordinals'],
  ],
  [
    'compiler source-path portability',
    process.execPath,
    ['scripts/formal-implementation-surface.cjs', '--self-test-source-paths'],
  ],
  ['public mapping', process.execPath, ['scripts/check-formal-implementation-conformance.mjs']],
  [
    'implementation traces',
    process.execPath,
    ['--test', '--test-concurrency', unitTestConcurrency, ...unitTests],
  ],
]);
await runParallel([
  [
    'lifecycle formal proof wrapper',
    process.execPath,
    ['--test', 'test/lifecycle-formal.test.mjs'],
  ],
  ['real process faults', process.execPath, ['--test', '--test-concurrency', '3', ...processTests]],
]);
run('lifecycle proof binding', process.execPath, ['scripts/check-lifecycle-proof-binding.mjs']);
run('lifecycle source/model mutation guard', process.execPath, [
  'scripts/check-lifecycle-source-model-mutation.mjs',
]);
run('lifecycle implementation mutation guards', process.execPath, [
  'scripts/check-lifecycle-implementation-mutations.mjs',
]);
run('typed-read definition-fence mutation guard', process.execPath, [
  'scripts/check-read-boundary-mutation.mjs',
]);
run('typed-read source/model mutation guard', process.execPath, [
  'scripts/check-read-source-model-binding-mutation.mjs',
]);
run('typed-read route/order mutation guard', process.execPath, [
  'scripts/check-read-contract-mutation.mjs',
]);
run('read-history retention/order mutation guard', process.execPath, [
  'scripts/check-read-history-mutations.mjs',
]);
run('policy source/model mutation guard', process.execPath, [
  'scripts/check-policy-source-model-binding-mutation.mjs',
]);
run('policy implementation mutation guards', process.execPath, [
  'scripts/check-policy-implementation-mutations.mjs',
]);
run('local-runner source/model mutation guard', process.execPath, [
  'scripts/check-local-runner-source-model-mutation.mjs',
]);
run('local-runner implementation mutation guards', process.execPath, [
  'scripts/check-local-runner-implementation-mutations.mjs',
]);
run('external source/model mutation guard', process.execPath, [
  'scripts/check-external-source-model-mutation.mjs',
]);
run('external implementation mutation guards', process.execPath, [
  'scripts/check-external-implementation-mutations.mjs',
]);
run('outbox source/model mutation guard', process.execPath, [
  'scripts/check-outbox-source-model-binding-mutation.mjs',
]);
run('outbox implementation mutation guard', process.execPath, [
  'scripts/check-outbox-implementation-mutations.mjs',
]);
run('storage implementation mutation guard', process.execPath, [
  'scripts/check-storage-contract-mutation.mjs',
]);
run('storage source/model mutation guard', process.execPath, [
  'scripts/check-storage-source-model-mutation.mjs',
]);
run('assurance infrastructure binding mutation guard', process.execPath, [
  'scripts/check-assurance-infrastructure-binding-mutation.mjs',
]);
run('parallel process-tree containment self-test', process.execPath, [
  'scripts/run-assurance.mjs',
  '--self-test-process-tree',
]);
run('assurance scheduling audit', process.execPath, ['scripts/check-assurance-scheduling.mjs']);
run('assurance scheduling mutation guard', process.execPath, [
  'scripts/check-assurance-scheduling-mutation.mjs',
]);
await runParallel([
  ['TLC storage/conformance + mutation guards', process.execPath, ['scripts/storage-formal.mjs']],
  ['bounded-domain audit', process.execPath, ['scripts/check-bounded-trace-domain.mjs']],
  ['packed consumer', process.execPath, ['scripts/consumer-smoke.mjs']],
]);
run('TLC lifecycle/runtime/read/policy boundaries + mutation guards', process.execPath, [
  'scripts/formal.mjs',
]);
console.log('[assurance] all gates passed');
