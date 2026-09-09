import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function requireRed(relative, label, mutate, args, pattern) {
  const target = path.join(root, relative);
  const original = fs.readFileSync(target, 'utf8');
  const mutant = mutate(original);
  assert.notEqual(mutant, original, `${label} mutation anchor did not match`);
  try {
    fs.writeFileSync(target, mutant);
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      timeout: 20_000,
    });
    requireExpectedProcessFailure(result, `${label} mutant`, pattern);
  } finally {
    fs.writeFileSync(target, original);
  }
}
requireRed(
  'dist/memory.js',
  'detached getMany rows',
  (text) => text.replace('return row ? copy(row) : undefined;', 'return row ?? undefined;'),
  ['--test', 'test/storage-contract-hardening.test.mjs'],
  /MUTATED|detached/u,
);
requireRed(
  'dist/cas.js',
  'bounded compare-miss retries',
  (text) => text.replace('conflicts < maxConflicts', 'conflicts <= maxConflicts'),
  ['--test', 'test/storage-contract-hardening.test.mjs'],
  /compareCalls|bounded contention exhaustion/u,
);
requireRed(
  'dist/cas.js',
  'unknown CAS acknowledgement propagation',
  (text) =>
    text.replace(
      /const applied = await port\.compareExchange\(\{([\s\S]*?)\n\s*\}\);/u,
      `let applied;\n                try {\n                    applied = await port.compareExchange({$1\n                    });\n                } catch {\n                    continue;\n                }`,
    ),
  ['--test', 'test/storage-contract-hardening.test.mjs'],
  /unknown acknowledgement|unknown outcome/u,
);
requireRed(
  'dist/cas.js',
  'CAS deadline expiry classification',
  (text) =>
    text.replace(
      /\s*if \(change\.validUntil !== undefined\) \{[\s\S]*?throw new WorkConflict\('lease_expired'\);\s*\}/u,
      '',
    ),
  ['--test', 'test/storage-refinement.test.mjs'],
  /deadlineEqualityRejected|Storage refinement failed/u,
);
requireRed(
  'dist/memory.js',
  'exclusive afterId cursor ordering',
  (text) =>
    text.replace(
      'compareUtf8Text(row.id, query.afterId) > 0',
      'compareUtf8Text(row.id, query.afterId) >= 0',
    ),
  ['--test', 'test/storage-refinement.test.mjs'],
  /cursorExact|Storage refinement failed/u,
);
requireRed(
  'dist/storage-validation.js',
  'exact +1 revision validation',
  (text) => text.replace('next.revision !== expectedRevision', 'false'),
  ['--test', 'test/storage-refinement.test.mjs'],
  /exactRevisionError|Storage refinement failed/u,
);
requireRed(
  'dist/sqlite.js',
  'SQLite startup busy recognition',
  (text) =>
    text.replace('return /database is (?:locked|busy)/iu.test(error.message);', 'return false;'),
  ['--test', 'test/storage-contract-hardening.test.mjs'],
  /one-shot native busy|database is (?:locked|busy)/iu,
);
console.log(
  'Storage mutation guard rejects detached-read, cursor/revision, CAS retry/deadline/unknown-ACK and SQLite busy regressions.',
);
