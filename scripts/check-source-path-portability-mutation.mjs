import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'scripts/formal-implementation-surface.cjs');
const original = fs.readFileSync(target, 'utf8');
const stableReturn = 'return `node_modules/typescript/lib/${tail}`;';
const legacyReturn = "return path.relative(root, absolute).split(path.sep).join('/');";

try {
  const mutant = original.replace(stableReturn, legacyReturn);
  assert.notEqual(mutant, original, 'source-path portability mutation anchor did not match');
  fs.writeFileSync(target, mutant);
  const result = spawnSync(process.execPath, [target, '--self-test-source-paths'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 15_000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.notEqual(
    result.status,
    0,
    'worktree-relative compiler-source-path mutant unexpectedly passed',
  );
  assert.match(
    output,
    /TypeScript lib source identity depends on worktree\/install topology/u,
    'source-path portability mutant failed for an unrelated reason',
  );
  console.log(
    'Compiler source-path portability mutation guard rejects worktree-relative TypeScript library identity.',
  );
} finally {
  fs.writeFileSync(target, original);
}
