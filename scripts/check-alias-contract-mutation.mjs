import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runNode(args) {
  return spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: process.env });
}
function output(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}
function requireRed(label, result, pattern) {
  assert.notEqual(result.status, 0, `${label} mutant unexpectedly passed`);
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
      const result = runNode(['--test', 'test/alias-contract.test.mjs']);
      requireRed(
        label,
        result,
        /aliases execute the same hardened operations|process\/runAvailable semantics|processExternal\/runExternalAvailable semantics/u,
      );
    },
  );
}

const typeMutants = [
  [
    'src/work.ts',
    'export type EnqueueOptions = EnsureOptions;',
    'export type EnqueueOptions = any;',
    'EnqueueOptions',
  ],
  [
    'src/worker.ts',
    'export type ProcessResult<O = unknown, R extends string = string> = RunAvailableResult<O, R>;',
    'export type ProcessResult<O = unknown, R extends string = string> = any;',
    'ProcessResult',
  ],
  [
    'src/external.ts',
    'export type ExternalProcessResult<\n  O = unknown,\n  R extends string = string,\n> = ExternalRunAvailableResult<O, R>;',
    'export type ExternalProcessResult<O = unknown, R extends string = string> = any;',
    'ExternalProcessResult',
  ],
];
for (const [relative, anchor, replacement, label] of typeMutants) {
  mutateFile(
    relative,
    (text) => text.replace(anchor, replacement),
    () => {
      const result = runNode([
        'node_modules/typescript/bin/tsc',
        '--noEmit',
        '-p',
        'tsconfig.tests.json',
      ]);
      requireRed(label, result, /test\/types\/aliases\.ts/u);
    },
  );
}

console.log(
  'Alias mutation guard rejects broken ESM/CommonJS runtime forwarders and any-degraded public type aliases.',
);
