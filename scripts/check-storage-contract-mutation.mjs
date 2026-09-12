import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function countAnchor(source, anchor) {
  if (typeof anchor === 'string') return source.split(anchor).length - 1;
  const flags = anchor.flags.includes('g') ? anchor.flags : `${anchor.flags}g`;
  return [...source.matchAll(new RegExp(anchor.source, flags))].length;
}

function requireRed(relative, label, anchors, mutate, args, pattern) {
  const target = path.join(root, relative);
  const original = fs.readFileSync(target, 'utf8');
  for (const anchor of anchors)
    assert.equal(
      countAnchor(original, anchor),
      1,
      `${label} mutation anchor is stale or not unique`,
    );
  const mutant = mutate(original, ...anchors);
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
  ['return row ? copy(row) : undefined;'],
  (text, anchor) => text.replace(anchor, 'return row ?? undefined;'),
  ['--test', 'test/storage-contract-hardening.test.mjs'],
  /getMany detached mutation leaked caller write into durable storage/u,
);
requireRed(
  'dist/cas.js',
  'bounded compare-miss retries',
  ['conflicts < maxConflicts'],
  (text, anchor) => text.replace(anchor, 'conflicts <= maxConflicts'),
  ['--test', 'test/storage-contract-hardening.test.mjs'],
  /bounded contention exhaustion must stop after exactly maxConflicts compare attempts/u,
);
requireRed(
  'dist/cas.js',
  'unknown CAS acknowledgement propagation',
  [/const applied = await port\.compareExchange\(\{([\s\S]*?)\n\s*\}\);/u],
  (text, anchor) =>
    text.replace(
      anchor,
      `let applied;\n                try {\n                    applied = await port.compareExchange({$1\n                    });\n                } catch {\n                    continue;\n                }`,
    ),
  ['--test', 'test/storage-contract-hardening.test.mjs'],
  /unknown acknowledgement must propagate to caller/u,
);
requireRed(
  'dist/cas.js',
  'CAS deadline expiry classification',
  [
    /\s*if \(change\.validUntil !== undefined\) \{[\s\S]*?throw new WorkConflict\('lease_expired'\);\s*\}/u,
  ],
  (text, anchor) => text.replace(anchor, ''),
  ['--test', 'test/storage-refinement.test.mjs'],
  /invalidWrite\.deadlineEqualityRejected: .*"deadlineEqualityRejected":false/u,
);
requireRed(
  'dist/memory.js',
  'exclusive afterId cursor ordering',
  ['compareUtf8Text(row.id, query.afterId) > 0'],
  (text, anchor) => text.replace(anchor, 'compareUtf8Text(row.id, query.afterId) >= 0'),
  ['--test', 'test/storage-refinement.test.mjs'],
  /detached\.cursorExact: .*"cursorExact":false/u,
);
requireRed(
  'dist/storage-validation.js',
  'exact +1 revision validation',
  ['next.revision !== expectedRevision'],
  (text, anchor) => text.replace(anchor, 'next.revision < expectedRevision'),
  [
    '--input-type=module',
    '--eval',
    "import { runConformance } from './dist/conformance.js'; import { createMemoryStore } from './dist/memory.js'; let clock = 100000; await runConformance(() => { const store = createMemoryStore({ now: () => clock }); return { store, advance(ms) { clock += ms; }, close() { store.close?.(); } }; });",
  ],
  /skipped revision must be rejected by the store contract/u,
);
requireRed(
  'dist/sqlite.js',
  'SQLite startup busy recognition',
  ['return /database is (?:locked|busy)/iu.test(error.message);'],
  (text, anchor) => text.replace(anchor, 'return false;'),
  ['--test', 'test/storage-contract-hardening.test.mjs'],
  /SQLite busy startup retry must absorb one-shot busy and complete bootstrap/u,
);
requireRed(
  'dist/sqlite.js',
  'SQLite native busy primary-code recognition',
  ['if (errcode === 5 || errcode === 6)'],
  (text, anchor) => text.replace(anchor, 'if (false)'),
  ['--test', 'test/storage-contract-hardening.test.mjs'],
  /opaque native sqlite failure/u,
);
console.log(
  'Storage mutation guard rejects detached-read, cursor/revision, CAS retry/deadline/unknown-ACK and SQLite busy/message regressions.',
);
