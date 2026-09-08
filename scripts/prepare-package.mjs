import { spawnSync } from 'node:child_process';
import { assertBuildSourceBinding } from './build-source-binding.mjs';

if (process.env.WORKONCE_REUSE_BOUND_BUILD === '1') {
  assertBuildSourceBinding();
} else {
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: new URL('..', import.meta.url),
    env: process.env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
