import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const helper = read('scripts/tlc-workspace.mjs');
assert.match(helper, /mkdtempSync/u, 'TLC workspace allocation must be collision-free');
assert.match(
  helper,
  /WORKONCE_TLC_ARTIFACT_DIR/u,
  'TLC child shards must accept a private parent workspace',
);
assert.match(helper, /rmSync\(workspace, \{ recursive: true, force: true \}\)/u);

for (const runner of [
  'scripts/formal.mjs',
  'scripts/lifecycle-formal.mjs',
  'scripts/storage-formal.mjs',
]) {
  const source = read(runner);
  assert.match(
    source,
    /from '\.\/tlc-workspace\.mjs'/u,
    `${runner} is not bound to the TLC workspace allocator`,
  );
  assert.match(
    source,
    /acquireTlcWorkspace/u,
    `${runner} does not acquire a private TLC workspace`,
  );
  assert.match(
    source,
    /cleanupTlcWorkspaceOnSuccess/u,
    `${runner} does not clean only its own successful workspace`,
  );
  assert.doesNotMatch(
    source,
    /['"`]\.artifacts\/tlc(?:['"`/])/u,
    `${runner} still addresses the process-global generated TLC directory`,
  );
  assert.match(
    source,
    /-DTLA-Library=.*tlcWorkspace/u,
    `${runner} does not isolate generated TLA module lookup`,
  );
  assert.match(
    source,
    /resolve\(tlcWorkspace,/u,
    `${runner} does not isolate TLC metadirs/generated files`,
  );
}

const formal = read('scripts/formal.mjs');
assert.match(
  formal,
  /const shardWorkspace = createTlcWorkspace\(`formal-\$\{mode\.slice\(2\)\}`\)/u,
);
assert.match(
  formal,
  /env: \{ \.\.\.process\.env, WORKONCE_TLC_ARTIFACT_DIR: shardWorkspace \}/u,
  'formal.mjs shards do not receive their distinct generated-module namespaces',
);
assert.equal((formal.match(/runShard\('--(?:runtime|non-runtime)-only'\)/gu) ?? []).length, 2);

console.log(
  'TLC runners and both formal shards use disjoint per-invocation generated-module workspaces.',
);
