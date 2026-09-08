import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'scripts/formal.mjs');
const original = fs.readFileSync(target, 'utf8');

function run(script) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
  });
}
function output(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

try {
  fs.writeFileSync(target, `${original}\n// assurance-infrastructure-binding-mutant\n`);

  const manifest = run('scripts/check-formal-implementation-conformance.mjs');
  assert.notEqual(manifest.status, 0, 'formal manifest accepted a changed proof runner');
  assert.match(output(manifest), /Formal implementation manifest drifted/u);

  const bounded = run('scripts/check-bounded-trace-domain.mjs');
  assert.notEqual(bounded.status, 0, 'bounded trace report accepted a changed proof runner');
  assert.match(output(bounded), /Bounded trace report drifted/u);

  console.log('Assurance infrastructure binding rejects an unreviewed proof-runner mutation.');
} finally {
  fs.writeFileSync(target, original);
}
