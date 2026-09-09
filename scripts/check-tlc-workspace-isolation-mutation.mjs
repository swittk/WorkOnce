import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function mutate(relative, from, to, label, pattern) {
  const target = path.join(root, relative);
  const original = fs.readFileSync(target, 'utf8');
  assert.ok(original.includes(from), `${label} mutation anchor is stale`);
  try {
    fs.writeFileSync(target, original.replace(from, to));
    const result = spawnSync(process.execPath, ['scripts/check-tlc-workspace-isolation.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      timeout: 15_000,
    });
    requireExpectedProcessFailure(result, `${label} mutant`, pattern);
  } finally {
    fs.writeFileSync(target, original);
  }
}

mutate(
  'scripts/formal.mjs',
  'env: { ...process.env, WORKONCE_TLC_ARTIFACT_DIR: shardWorkspace },',
  'env: process.env,',
  'formal shard workspace inheritance removal',
  /distinct generated-module namespaces/u,
);
mutate(
  'scripts/lifecycle-formal.mjs',
  "const tlcWorkspace = acquireTlcWorkspace('lifecycle-formal');",
  "const tlcWorkspace = resolve('.artifacts/tlc');",
  'lifecycle global TLC workspace regression',
  /process-global generated TLC directory|acquire a private TLC workspace/u,
);

console.log('TLC workspace isolation mutation guard rejects shared generated-module namespaces.');
