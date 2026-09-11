import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure, requireSuccessfulProcess } from './subprocess-outcome.mjs';

import { createMutationFileGuard } from './mutation-file-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutationFiles = createMutationFileGuard();
const target = path.join(root, 'scripts/formal-implementation-surface.cjs');
const original = fs.readFileSync(target, 'utf8');
const stableReturn = 'return `node_modules/typescript/lib/${tail}`;';
const legacyReturn = "return path.relative(root, absolute).split(path.sep).join('/');";
function selfTest(flag) {
  return spawnSync(process.execPath, [target, flag], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 15_000,
  });
}
if (process.env.WORKONCE_SOURCE_PATH_BASELINE_CERTIFIED !== String(process.ppid)) {
  requireSuccessfulProcess(selfTest('--self-test-source-paths'), 'baseline compiler source paths');
  requireSuccessfulProcess(
    selfTest('--self-test-trivia-ordinals'),
    'baseline type identity trivia',
  );
}

try {
  assert.equal(
    original.split(stableReturn).length,
    2,
    'source-path portability mutation anchor is stale or not unique',
  );
  const mutant = original.replace(stableReturn, legacyReturn);
  mutationFiles.writeFileSync(target, mutant);
  const result = selfTest('--self-test-source-paths');
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  requireExpectedProcessFailure(
    result,
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
  mutationFiles.restoreAll();
}

try {
  const aliasAnchor =
    'return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;';
  assert.equal(
    original.split(aliasAnchor).length,
    2,
    'export-alias resolver mutation anchor is stale or not unique',
  );
  mutationFiles.writeFileSync(target, original.replace(aliasAnchor, 'return symbol;'));
  const result = selfTest('--self-test-trivia-ordinals');
  requireExpectedProcessFailure(
    result,
    'unresolved root-export alias mutant',
    /Root export alias/u,
  );
  console.log('Compiler surface mutation guard rejects unresolved root-export type aliases.');
} finally {
  mutationFiles.restoreAll();
}
mutationFiles.dispose();
