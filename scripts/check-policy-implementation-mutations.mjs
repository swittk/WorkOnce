import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
function runExpectedFailure(label, pattern) {
  const result = spawnSync(process.execPath, ['--test', 'test/policy-refinement.test.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 15_000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.error, undefined, `${label} failed to execute: ${String(result.error)}`);
  assert.equal(result.signal, null, `${label} terminated by ${String(result.signal)}`);
  assert.equal(typeof result.status, 'number', `${label} did not produce an exit status`);
  assert.notEqual(result.status, 0, `${label} mutant unexpectedly passed`);
  assert.match(output, pattern, `${label} failed for an unrelated reason`);
  console.log(`Policy implementation mutation guard rejects ${label}.`);
}
try {
  {
    const original = originals.get(retryPath);
    const needle =
      'const scaled = initialDelayMs === 0 ? 0 : initialDelayMs * multiplier ** retries;';
    const replacement = 'const scaled = initialDelayMs * multiplier ** retries;';
    assert.equal(original.includes(needle), true, 'zero-delay mutation anchor is stale');
    fs.writeFileSync(retryPath, original.replace(needle, replacement));
    runExpectedFailure('zero-delay overflow mutation', /zeroOverflow/u);
    restore();
  }
  {
    const original = originals.get(kernelPath);
    const needle = `: row.attempts >= row.limits.maxAttempts\n                            ? 'attempt_budget_exhausted'\n                            : availableAt >= deadline\n                                ? 'deadline_exceeded'\n                                : 'deferral_budget_exhausted';`;
    const replacement = `: availableAt >= deadline\n                            ? 'deadline_exceeded'\n                            : row.attempts >= row.limits.maxAttempts\n                                ? 'attempt_budget_exhausted'\n                                : 'deferral_budget_exhausted';`;
    assert.equal(original.includes(needle), true, 'stop-precedence mutation anchor is stale');
    fs.writeFileSync(kernelPath, original.replace(needle, replacement));
    runExpectedFailure('retry/defer stop-precedence mutation', /attempt_budget_exhausted/u);
    restore();
  }
  {
    const original = originals.get(workPath);
    const needle =
      'if (row.generation !== options.generation || row.revision !== options.revision)';
    const replacement = 'if (row.generation !== options.generation)';
    assert.equal(original.includes(needle), true, 'wake revision mutation anchor is stale');
    fs.writeFileSync(workPath, original.replace(needle, replacement));
    runExpectedFailure('wake revision-fence mutation', /wakeCompetition/u);
    restore();
  }
} finally {
  restore();
}
