import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure, requireSuccessfulProcess } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'dist/work.js');
const original = fs.readFileSync(target, 'utf8');
const pattern = /    assertDefinition\(row\) \{\n[\s\S]*?\n    \}\n    snapshot\(row, now\) \{/u;
const replacement = `    assertDefinition(row) {\n        return;\n    }\n    snapshot(row, now) {`;
const matches = [...original.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
assert.equal(matches.length, 1, 'read-definition mutant must match exactly one compiled WorkQueue');
const mutant = original.replace(pattern, replacement);
assert.notEqual(mutant, original, 'read-definition mutant did not match compiled WorkQueue');
const runTypedReadBoundary = () =>
  spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { assertTypedReadBoundarySamples, runTypedReadBoundarySamples } from './scripts/read-boundary-refinement.mjs'; const samples = await runTypedReadBoundarySamples(); assertTypedReadBoundarySamples(samples);`,
    ],
    { cwd: root, encoding: 'utf8', env: process.env, timeout: 15_000 },
  );
requireSuccessfulProcess(runTypedReadBoundary(), 'baseline typed-read boundary refinement');
try {
  fs.writeFileSync(target, mutant);
  const result = runTypedReadBoundary();
  requireExpectedProcessFailure(
    result,
    'compiled read-definition mutant',
    /Error: Typed read refinement failed: memory\.definitionFenceExact/u,
  );
  console.log(
    'Typed-read mutation guard rejects a compiled implementation with the definition fence disabled.',
  );
} finally {
  fs.writeFileSync(target, original);
}
