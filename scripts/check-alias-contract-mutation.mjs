import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function runNode(args) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 15_000,
  });
}
function output(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}
function requireRed(label, result, pattern) {
  requireExpectedProcessFailure(result, `${label} mutant unexpectedly passed`);
  assert.match(output(result), pattern);
}
function mutateFile(relative, mutate, check) {
  const target = path.join(root, relative);
  const original = fs.readFileSync(target, 'utf8');
  try {
    const changed = mutate(original);
    assert.notEqual(changed, original, `${relative} mutation anchor did not match`);
    fs.writeFileSync(target, changed);
    check();
  } finally {
    fs.writeFileSync(target, original);
  }
}

for (const [relative, anchor, replacement, label] of [
  [
    'dist/work.js',
    'async process(options, handler) {\n        return this.runAvailable(options, handler);\n    }',
    'async process(options, handler) {\n        return [];\n    }',
    'ESM WorkQueue.process',
  ],
  [
    'dist-cjs/work.js',
    'async process(options, handler) {\n        return this.runAvailable(options, handler);\n    }',
    'async process(options, handler) {\n        return [];\n    }',
    'CommonJS WorkQueue.process',
  ],
  [
    'dist/external.js',
    'export function processExternal(transport, options, handler) {\n    return runExternalAvailable(transport, options, handler);\n}',
    'export function processExternal(transport, options, handler) {\n    return Promise.resolve([]);\n}',
    'ESM processExternal',
  ],
  [
    'dist-cjs/external.js',
    'function processExternal(transport, options, handler) {\n    return runExternalAvailable(transport, options, handler);\n}',
    'function processExternal(transport, options, handler) {\n    return Promise.resolve([]);\n}',
    'CommonJS processExternal',
  ],
]) {
  mutateFile(
    relative,
    (text) => text.replace(anchor, replacement),
    () => {
      const result = runNode([
        '--test',
        '--test-name-pattern=ESM and CommonJS aliases execute the same hardened operations',
        'test/alias-contract.test.mjs',
      ]);
      requireRed(
        label,
        result,
        /aliases execute the same hardened operations|process\/runAvailable semantics|processExternal\/runExternalAvailable semantics/u,
      );
    },
  );
}

for (const [relative, anchor, replacement, label] of [
  [
    'dist/work.js',
    'if (!next)\n                return { value: this.snapshot(row, now) };',
    "if (!next)\n                throw new WorkConflict('not_waiting');",
    'ESM WorkQueue.restart nonterminal semantics',
  ],
  [
    'dist-cjs/work.js',
    'if (!next)\n                return { value: this.snapshot(row, now) };',
    "if (!next)\n                throw new kernel_js_1.WorkConflict('not_waiting');",
    'CommonJS WorkQueue.restart nonterminal semantics',
  ],
]) {
  mutateFile(
    relative,
    (text) => text.replace(anchor, replacement),
    () => {
      const result = runNode([
        '--test',
        '--test-name-pattern=restart preserves exact ergonomic-dispatch semantics',
        'test/alias-contract.test.mjs',
      ]);
      requireRed(label, result, /restart preserves exact ergonomic-dispatch semantics/u);
    },
  );
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
    const changed = original.replace(anchor, replacement);
    assert.notEqual(changed, original, `${relative} mutation anchor did not match`);
    typeOriginals.set(target, original);
    fs.writeFileSync(target, changed);
  }
  const result = runNode([
    'node_modules/typescript/bin/tsc',
    '--noEmit',
    '-p',
    'tsconfig.tests.json',
  ]);
  requireExpectedProcessFailure(result, 'type alias mutant batch unexpectedly passed');
  const diagnostics = output(result);
  for (const [, , , diagnostic] of typeMutants)
    assert.match(diagnostics, new RegExp(diagnostic.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
} finally {
  for (const [target, original] of typeOriginals) fs.writeFileSync(target, original);
}

console.log(
  'Alias mutation guard rejects broken ESM/CommonJS runtime forwarders and any-degraded public type aliases.',
);
