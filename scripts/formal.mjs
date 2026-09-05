import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const jar = process.env.TLA2TOOLS_JAR ?? resolve('.artifacts/tla2tools.jar');
if (!existsSync(jar))
  throw new Error('Set TLA2TOOLS_JAR to the official tla2tools.jar. See docs/assurance.md.');
mkdirSync('.artifacts/tlc', { recursive: true });
const result = spawnSync(
  'java',
  [
    '-Xmx512m',
    '-cp',
    jar,
    'tlc2.TLC',
    '-workers',
    '2',
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
