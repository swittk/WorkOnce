import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

import { createMutationFileGuard } from './mutation-file-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutationFiles = createMutationFileGuard();
const target = path.join(root, 'scripts/formal-implementation-surface.cjs');
const original = fs.readFileSync(target, 'utf8');
const stableReturn = 'return `node_modules/typescript/lib/${tail}`;';
const legacyReturn = "return path.relative(root, absolute).split(path.sep).join('/');";

try {
  const mutant = original.replace(stableReturn, legacyReturn);
  assert.notEqual(mutant, original, 'source-path portability mutation anchor did not match');
  mutationFiles.writeFileSync(target, mutant);
  const result = spawnSync(process.execPath, [target, '--self-test-source-paths'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 15_000,
  });
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
    original.includes(aliasAnchor),
    true,
    'export-alias resolver mutation anchor is stale',
  );
  mutationFiles.writeFileSync(target, original.replace(aliasAnchor, 'return symbol;'));
  const result = spawnSync(process.execPath, [target, '--self-test-trivia-ordinals'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 15_000,
  });
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
