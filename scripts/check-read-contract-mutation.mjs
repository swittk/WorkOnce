import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'dist/work.js');
const original = fs.readFileSync(target, 'utf8');

function runReadContract() {
  return spawnSync(process.execPath, ['--test', 'test/read-contract.test.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 15_000,
  });
}
function requireRed(label, mutant, pattern) {
  assert.notEqual(mutant, original, `${label} mutation anchor did not match`);
  fs.writeFileSync(target, mutant);
  const result = runReadContract();
  requireExpectedProcessFailure(result, `${label} mutant`, pattern);
  fs.writeFileSync(target, original);
}

try {
  requireRed(
    'inspectId definition fence',
    original.replace(
      '        this.assertDefinition(row);\n        return this.snapshot(row, result.now);',
      '        return this.snapshot(row, result.now);',
    ),
    /definition_changed/u,
  );

  requireRed(
    'inspectMany definition fence',
    original.replace(
      '            this.assertDefinition(row);\n            return this.snapshot(row, result.now);',
      '            return this.snapshot(row, result.now);',
    ),
    /definition_changed/u,
  );

  requireRed(
    'history definition fence',
    original.replace(
      "    requireRow(row) {\n        if (!row)\n            throw new WorkConflict('not_found');\n        this.assertDefinition(row);\n    }",
      "    requireRow(row) {\n        if (!row)\n            throw new WorkConflict('not_found');\n    }",
    ),
    /definition_changed/u,
  );

  const orderAnchor = '        return result.rows.map((row) => {';
  assert.equal(
    original.split(orderAnchor).length,
    2,
    'inspectMany caller-order preservation anchor is not unique',
  );
  requireRed(
    'inspectMany caller-order preservation',
    original.replace(orderAnchor, '        return [...result.rows].reverse().map((row) => {'),
    /deepStrictEqual|Expected values to be strictly deep-equal/u,
  );

  console.log(
    'Read-contract mutation guard rejects missing definition fences and inspectMany order corruption.',
  );
} finally {
  fs.writeFileSync(target, original);
}
