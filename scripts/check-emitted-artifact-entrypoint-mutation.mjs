import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(root, 'package.json');
const original = fs.readFileSync(packagePath, 'utf8');
try {
  const pkg = JSON.parse(original);
  pkg.scripts['test:process'] = 'node --test test/process/*.test.mjs';
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  const result = spawnSync(process.execPath, ['scripts/check-emitted-artifact-entrypoints.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.notEqual(result.status, 0, 'unguarded test:process entrypoint unexpectedly passed');
  assert.match(output, /test:process.*lost its required build\/binding guard/u);
  console.log(
    'Emitted-artifact entrypoint mutation guard rejects removal of test:process freshness.',
  );
} finally {
  fs.writeFileSync(packagePath, original);
}
