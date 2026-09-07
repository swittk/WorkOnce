import { availableParallelism } from 'node:os';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const jar = process.env.TLA2TOOLS_JAR ?? resolve('.artifacts/tla2tools.jar');
if (!existsSync(jar))
  throw new Error('Set TLA2TOOLS_JAR to the official tla2tools.jar. See docs/assurance.md.');
mkdirSync('.artifacts/tlc', { recursive: true });
const workers = String(Math.max(2, Math.min(8, availableParallelism())));
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
  { cwd: 'formal', stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
