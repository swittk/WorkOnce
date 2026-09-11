import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure, requireSuccessfulProcess } from './subprocess-outcome.mjs';

import { createMutationFileGuard } from './mutation-file-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutationFiles = createMutationFileGuard();
const target = path.join(root, 'src/work.ts');
const original = fs.readFileSync(target, 'utf8');
const needle = '        outboxAfterId = parent.id;';
const replacement = '        outboxAfterId = undefined;';
assert.equal(
  original.split(needle).length,
  2,
  'outbox source/model mutation anchor is stale or not unique',
);
function bindingCheck() {
  return spawnSync(
    process.execPath,
    ['scripts/check-formal-implementation-conformance.mjs', '--check-outbox-binding-only'],
    { cwd: root, encoding: 'utf8', env: process.env, timeout: 15_000 },
  );
}
requireSuccessfulProcess(bindingCheck(), 'baseline outbox source/model binding');
try {
  mutationFiles.writeFileSync(target, original.replace(needle, replacement));
  const result = bindingCheck();
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
  mutationFiles.restoreAll();
}

const manifestPath = path.join(root, 'assurance/formal-implementation-manifest.json');
const manifestOriginal = fs.readFileSync(manifestPath, 'utf8');
try {
  const manifest = JSON.parse(manifestOriginal);
  assert.equal(
    typeof manifest.model?.outbox?.sourceDigest,
    'string',
    'outbox manifest source digest mutation anchor is stale',
  );
  delete manifest.model.outbox.sourceDigest;
  mutationFiles.writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}
`,
  );
  const result = spawnSync(
    process.execPath,
    ['scripts/check-formal-implementation-conformance.mjs', '--write'],
    { cwd: root, encoding: 'utf8', env: process.env, timeout: 15_000 },
  );
  const output = `${result.stdout ?? ''}
${result.stderr ?? ''}`;
  requireExpectedProcessFailure(
    result,
    'missing prior outbox source digest unexpectedly passed write',
  );
  assert.match(
    output,
    /Bound outbox scheduler semantics changed without an outbox model semantic change/u,
  );
  console.log(
    'Outbox write-path pairing rejects a missing prior source digest without review acknowledgement.',
  );
} finally {
  mutationFiles.restoreAll();
}
mutationFiles.dispose();
