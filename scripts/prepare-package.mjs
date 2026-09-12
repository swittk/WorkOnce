import { spawnSync } from 'node:child_process';
import { assertBuildSourceBinding } from './build-source-binding.mjs';

if (process.env.WORKONCE_REUSE_BOUND_BUILD === '1') {
  assertBuildSourceBinding();
} else {
  const command =
    process.platform === 'win32'
      ? (process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe')
      : 'npm';
  const args =
    process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd run build'] : ['run', 'build'];
  const result = spawnSync(command, args, {
    cwd: new URL('..', import.meta.url),
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
