import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function run(label, command, args) {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(`[assurance] ${label}: ${Math.round(performance.now() - started)} ms`);
}
function runNpm(label, args) {
  if (process.platform === 'win32') {
    run(label, process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args]);
    return;
  }
  run(label, 'npm', args);
}
const unitTests = fs
  .readdirSync(path.join(root, 'test'))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => `test/${name}`);
const processTests = fs
  .readdirSync(path.join(root, 'test/process'))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => `test/process/${name}`);
runNpm('format', ['run', 'format:check']);
runNpm('type surface', ['run', 'check']);
runNpm('single build', ['run', 'build']);
run('build/source freshness mutation guard', process.execPath, [
  'scripts/check-build-source-binding-mutation.mjs',
]);
run('emitted-artifact entrypoint audit', process.execPath, [
  'scripts/check-emitted-artifact-entrypoints.mjs',
]);
run('emitted-artifact entrypoint mutation guard', process.execPath, [
  'scripts/check-emitted-artifact-entrypoint-mutation.mjs',
]);
runNpm('ES2018 Web Worker', ['run', 'check:web']);
run('formal config parser', process.execPath, [
  'scripts/check-formal-implementation-conformance.mjs',
  '--self-test-config-checks',
]);
run('type identity trivia', process.execPath, [
  'scripts/formal-implementation-surface.cjs',
  '--self-test-trivia-ordinals',
]);
run('public mapping', process.execPath, ['scripts/check-formal-implementation-conformance.mjs']);
run('implementation traces', process.execPath, ['--test', ...unitTests]);
run('real process faults', process.execPath, ['--test', ...processTests]);
run('bounded-domain audit', process.execPath, ['scripts/check-bounded-trace-domain.mjs']);
run('assurance infrastructure binding mutation guard', process.execPath, [
  'scripts/check-assurance-infrastructure-binding-mutation.mjs',
]);
run('TLC lifecycle/runtime boundaries + mutation guard', process.execPath, ['scripts/formal.mjs']);
run('packed consumer', process.execPath, ['scripts/consumer-smoke.mjs']);
console.log('[assurance] all gates passed');
