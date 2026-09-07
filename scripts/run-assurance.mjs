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
run('format', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'format:check']);
run('type surface', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'check']);
run('single build', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);
run('public mapping', process.execPath, ['scripts/check-formal-implementation-conformance.mjs']);
run('implementation traces', process.execPath, ['--test', ...unitTests]);
run('real process faults', process.execPath, ['--test', ...processTests]);
run('bounded-domain audit', process.execPath, ['scripts/check-bounded-trace-domain.mjs']);
run('TLC once', process.execPath, ['scripts/formal.mjs']);
run('packed consumer', process.execPath, ['scripts/consumer-smoke.mjs']);
console.log('[assurance] all gates passed');
