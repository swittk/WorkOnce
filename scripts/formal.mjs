import { availableParallelism } from 'node:os';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const jar = resolve(process.env.TLA2TOOLS_JAR ?? '.artifacts/tla2tools.jar');
if (!existsSync(jar))
  throw new Error('Set TLA2TOOLS_JAR to the official tla2tools.jar. See docs/assurance.md.');
mkdirSync('.artifacts/tlc', { recursive: true });
const workers = String(Math.max(2, Math.min(8, availableParallelism())));
const timeoutMs = 30_000;
const result = spawnSync(
  'java',
  [
    '-Xmx512m',
    '-XX:+UseParallelGC',
    '-cp',
    jar,
    'tlc2.TLC',
    '-workers',
    workers,
    '-metadir',
    resolve('.artifacts/tlc'),
    '-config',
    'WorkOnce.cfg',
    'WorkOnce.tla',
  ],
  { cwd: 'formal', stdio: 'inherit', timeout: timeoutMs, killSignal: 'SIGKILL' },
);
if (result.error) {
  const prefix =
    result.error.code === 'ETIMEDOUT'
      ? `TLC infrastructure timeout after ${timeoutMs} ms`
      : 'TLC infrastructure spawn failure';
  throw new Error(`${prefix}: ${result.error.message}`, { cause: result.error });
}
if (result.signal) throw new Error(`TLC infrastructure terminated by signal ${result.signal}`);
if (result.status === null) throw new Error('TLC infrastructure returned no exit status');
process.exit(result.status);
