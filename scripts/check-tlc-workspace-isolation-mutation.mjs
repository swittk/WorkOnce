import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMutationFileGuard } from './mutation-file-guard.mjs';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutationFiles = createMutationFileGuard();
function mutate(relative, from, to, label, pattern) {
  const target = path.join(root, relative);
  const original = fs.readFileSync(target, 'utf8');
  assert.ok(original.includes(from), `${label} mutation anchor is stale`);
  try {
    mutationFiles.writeFileSync(target, original.replace(from, to));
    const result = spawnSync(process.execPath, ['scripts/check-tlc-workspace-isolation.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      timeout: 15_000,
    });
    requireExpectedProcessFailure(result, `${label} mutant`, pattern);
  } finally {
    mutationFiles.restoreAll();
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
  "const tlcWorkspace = resolve('.artifacts', 'tlc');",
  'lifecycle global TLC workspace regression',
  /process-global generated TLC directory|acquire a private TLC workspace/u,
);
mutate(
  'scripts/formal.mjs',
  '    `-Djava.io.tmpdir=${javaTmp}`,',
  '    `-Djava.io.tmpdir=/tmp`,',
  'formal shard process-global Java temporary directory regression',
  /standard-module extraction from process-global temp/u,
);
mutate(
  'scripts/tlc-workspace.mjs',
  '    if (code === 0) rmSync(workspace, { recursive: true, force: true });',
  '    rmSync(workspace, { recursive: true, force: true });',
  'failed TLC workspace diagnostics are deleted',
  /successful invocation/u,
);

mutate(
  'scripts/tlc-workspace.mjs',
  '  if (!insideBase(workspace))',
  '  if (false)',
  'inherited TLC workspace containment removal',
  /containment-checked|private descendant/u,
);

console.log('TLC workspace isolation mutation guard rejects shared generated-module namespaces.');
mutationFiles.dispose();
