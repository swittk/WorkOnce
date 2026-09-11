import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure, requireSuccessfulProcess } from './subprocess-outcome.mjs';
import { createMutationFileGuard } from './mutation-file-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutationFiles = createMutationFileGuard();
function runNode(args, timeout = 15_000) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout,
  });
}
function output(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}
const runtimeMutants = [
  [
    'dist/work.js',
    'async process(options, handler) {\n        return this.runAvailable(options, handler);\n    }',
    'async process(options, handler) {\n        return [];\n    }',
  ],
  [
    'dist-cjs/work.js',
    'async process(options, handler) {\n        return this.runAvailable(options, handler);\n    }',
    'async process(options, handler) {\n        return [];\n    }',
  ],
  [
    'dist/external.js',
    'export function processExternal(transport, options, handler) {\n    return runExternalAvailable(transport, options, handler);\n}',
    'export function processExternal(transport, options, handler) {\n    return Promise.resolve([]);\n}',
  ],
  [
    'dist-cjs/external.js',
    'function processExternal(transport, options, handler) {\n    return runExternalAvailable(transport, options, handler);\n}',
    'function processExternal(transport, options, handler) {\n    return Promise.resolve([]);\n}',
  ],
  [
    'dist/work.js',
    'if (!next)\n                return { value: this.snapshot(row, now) };',
    "if (!next)\n                throw new WorkConflict('not_waiting');",
  ],
  [
    'dist-cjs/work.js',
    'if (!next)\n                return { value: this.snapshot(row, now) };',
    "if (!next)\n                throw new kernel_js_1.WorkConflict('not_waiting');",
  ],
];
const runtimeWitnessArgs = ['--test', 'test/alias-mutation-witness.test.mjs'];
requireSuccessfulProcess(runNode(runtimeWitnessArgs), 'baseline alias mutation witnesses');
try {
  for (const [relative, anchor, replacement] of runtimeMutants) {
    const target = path.join(root, relative);
    const current = fs.readFileSync(target, 'utf8');
    assert.equal(
      current.split(anchor).length,
      2,
      `${relative} runtime alias mutation anchor is stale or not unique`,
    );
    mutationFiles.writeFileSync(target, current.replace(anchor, replacement));
  }
  const result = runNode(runtimeWitnessArgs);
  requireExpectedProcessFailure(result, 'runtime alias mutant batch unexpectedly passed');
  const diagnostics = output(result);
  for (const pattern of [
    /esm\.process\/runAvailable semantics/u,
    /commonjs\.process\/runAvailable semantics/u,
    /esm\.processExternal\/runExternalAvailable semantics/u,
    /commonjs\.processExternal\/runExternalAvailable semantics/u,
    /esm\.restart must not reject outside terminal states/u,
    /commonjs\.restart must not reject outside terminal states/u,
  ])
    assert.match(diagnostics, pattern, `runtime alias mutant did not trip ${String(pattern)}`);
} finally {
  mutationFiles.restoreAll();
}

const typeMutants = [
  [
    'src/work.ts',
    'export type EnqueueOptions = EnsureOptions;',
    'export type EnqueueOptions = any;',
    'test/types/aliases.ts(21,29)',
  ],
  [
    'src/worker.ts',
    'export type ProcessResult<O = unknown, R extends string = string> = RunAvailableResult<O, R>;',
    'export type ProcessResult<O = unknown, R extends string = string> = any;',
    'test/types/aliases.ts(22,34)',
  ],
  [
    'src/external.ts',
    'export type ExternalProcessResult<\n  O = unknown,\n  R extends string = string,\n> = ExternalRunAvailableResult<O, R>;',
    'export type ExternalProcessResult<O = unknown, R extends string = string> = any;',
    'test/types/aliases.ts(24,3)',
  ],
];
const typeOriginals = new Map();
try {
  for (const [relative, anchor, replacement] of typeMutants) {
    const target = path.join(root, relative);
    const original = fs.readFileSync(target, 'utf8');
    assert.equal(
      original.split(anchor).length,
      2,
      `${relative} type mutation anchor is stale or not unique`,
    );
    const changed = original.replace(anchor, replacement);
    assert.notEqual(changed, original, `${relative} mutation anchor did not match`);
    typeOriginals.set(target, original);
    mutationFiles.writeFileSync(target, changed);
  }
  const result = runNode(
    ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.tests.json'],
    45_000,
  );
  requireExpectedProcessFailure(result, 'type alias mutant batch unexpectedly passed');
  const diagnostics = output(result);
  for (const [, , , diagnostic] of typeMutants)
    assert.match(diagnostics, new RegExp(diagnostic.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
} finally {
  mutationFiles.restoreAll();
}

console.log(
  'Alias mutation guard rejects broken ESM/CommonJS runtime forwarders and any-degraded public type aliases.',
);
mutationFiles.dispose();
