import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireCausalMutationFailure } from './mutation-file-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'dist/work.js');
const original = fs.readFileSync(target, 'utf8');
const needle = '                outboxAfterId = parent.id;';
const replacement = '                outboxAfterId = undefined;';
assert.equal(
  original.split(needle).length,
  2,
  'compiled outbox cursor mutation anchor must be unique',
);
try {
  fs.writeFileSync(target, original.replace(needle, replacement));
  const runWitness = () =>
    spawnSync(process.execPath, ['--test', 'test/outbox-cursor-control.test.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      timeout: 15_000,
    });
  requireCausalMutationFailure(
    new Map([[target, original]]),
    runWitness,
    'compiled outbox cursor',
    /cursor must advance to the next parent on the second pass/u,
  );
  console.log('Outbox implementation mutation guard rejects a lost cursor advancement.');
} finally {
  fs.writeFileSync(target, original);
}
