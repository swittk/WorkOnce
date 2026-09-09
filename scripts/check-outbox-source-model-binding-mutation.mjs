import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src/work.ts');
const original = fs.readFileSync(target, 'utf8');
const needle = '        outboxAfterId = parent.id;';
const replacement = '        outboxAfterId = undefined;';
assert.equal(original.includes(needle), true, 'outbox source/model mutation anchor is stale');
try {
  fs.writeFileSync(target, original.replace(needle, replacement));
  const result = spawnSync(
    process.execPath,
    ['scripts/check-formal-implementation-conformance.mjs', '--check-outbox-binding-only'],
    { cwd: root, encoding: 'utf8', env: process.env, timeout: 15_000 },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  requireExpectedProcessFailure(result, 'outbox source/model drift mutant unexpectedly passed');
  assert.match(
    output,
    /Bound outbox scheduler semantics changed without an outbox model semantic change/u,
  );
  console.log(
    'Outbox source/model mutation guard rejects a changed scheduler cursor update with unchanged outbox models.',
  );
} finally {
  fs.writeFileSync(target, original);
}
