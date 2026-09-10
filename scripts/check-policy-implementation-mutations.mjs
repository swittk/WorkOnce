import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const retryPath = path.join(root, 'dist/retry-policy.js');
const kernelPath = path.join(root, 'dist/kernel.js');
const workPath = path.join(root, 'dist/work.js');
const originals = new Map([
  [retryPath, fs.readFileSync(retryPath, 'utf8')],
  [kernelPath, fs.readFileSync(kernelPath, 'utf8')],
  [workPath, fs.readFileSync(workPath, 'utf8')],
]);
function restore() {
  for (const [file, text] of originals) fs.writeFileSync(file, text);
}
function runExpectedFailure(label, witness, pattern) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { assertPolicyMutationWitness } from './scripts/policy-refinement.mjs'; await assertPolicyMutationWitness(${JSON.stringify(witness)});`,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      timeout: 15_000,
    },
  );
  requireExpectedProcessFailure(result, `${label} mutant`, pattern);
  console.log(`Policy implementation mutation guard rejects ${label}.`);
}
try {
  {
    const original = originals.get(retryPath);
    const needle =
      'const scaled = initialDelayMs === 0 ? 0 : initialDelayMs * multiplier ** retries;';
    const replacement = 'const scaled = initialDelayMs * multiplier ** retries;';
    assert.equal(original.split(needle).length, 2, 'zero-delay mutation anchor must be unique');
    fs.writeFileSync(retryPath, original.replace(needle, replacement));
    runExpectedFailure(
      'zero-delay overflow mutation',
      'zeroOverflow',
      /backoffFinite\.matchesExpected:[^\n]*"category":"zeroOverflow"/u,
    );
    restore();
  }
  {
    const original = originals.get(kernelPath);
    const needle = `: row.attempts >= row.limits.maxAttempts\n                            ? 'attempt_budget_exhausted'\n                            : availableAt >= deadline\n                                ? 'deadline_exceeded'\n                                : 'deferral_budget_exhausted';`;
    const replacement = `: availableAt >= deadline\n                            ? 'deadline_exceeded'\n                            : row.attempts >= row.limits.maxAttempts\n                                ? 'attempt_budget_exhausted'\n                                : 'deferral_budget_exhausted';`;
    assert.equal(
      original.split(needle).length,
      2,
      'stop-precedence mutation anchor must be unique',
    );
    fs.writeFileSync(kernelPath, original.replace(needle, replacement));
    runExpectedFailure(
      'retry/defer stop-precedence mutation',
      'stopPrecedence',
      /"kind":"retryBoundary"[^\n]*"stop":"deadline_exceeded"[^\n]*"expected":"attempt_budget_exhausted"/u,
    );
    restore();
  }
  {
    const original = originals.get(workPath);
    const needle =
      'if (row.generation !== options.generation || row.revision !== options.revision)';
    const replacement = 'if (row.generation !== options.generation)';
    assert.equal(original.split(needle).length, 2, 'wake revision mutation anchor must be unique');
    fs.writeFileSync(workPath, original.replace(needle, replacement));
    runExpectedFailure(
      'wake revision-fence mutation',
      'wakeRevision',
      /wakeCompetition\.(?:exactlyOneWake|exactLoser):[^\n]*false/u,
    );
    restore();
  }
} finally {
  restore();
}
