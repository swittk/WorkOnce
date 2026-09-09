import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'dist/work.js');
const original = fs.readFileSync(target, 'utf8');
const needle = '                outboxAfterId = parent.id;';
const replacement = '                outboxAfterId = undefined;';
assert.equal(original.includes(needle), true, 'compiled outbox cursor mutation anchor is stale');
try {
  fs.writeFileSync(target, original.replace(needle, replacement));
  const result = spawnSync(process.execPath, ['--test', 'test/outbox-cursor-control.test.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 15_000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  requireExpectedProcessFailure(result, 'compiled outbox cursor mutant unexpectedly passed');
  assert.match(output, /cursor must advance to the next parent on the second pass/u);
  console.log('Outbox implementation mutation guard rejects a lost cursor advancement.');
} finally {
  fs.writeFileSync(target, original);
}
