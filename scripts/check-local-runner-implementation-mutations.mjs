import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'dist/worker.js');
const original = fs.readFileSync(target, 'utf8');
function runExpectedFailure(label, pattern) {
  const result = spawnSync(process.execPath, ['--test', 'test/local-runner-refinement.test.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 10_000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.notEqual(result.status, 0, `${label} mutant unexpectedly passed`);
  assert.match(output, pattern, `${label} failed for an unrelated reason`);
  console.log(`Local-runner implementation mutation guard rejects ${label}.`);
}
try {
  {
    const needle = `if (ownershipLoss !== undefined)\n                throw ownershipLoss.error;`;
    assert.equal(original.includes(needle), true, 'ownership-cause mutation anchor is stale');
    fs.writeFileSync(
      target,
      original.replaceAll(
        needle,
        `if (ownershipLoss !== undefined)\n                throw new Error('Worker ownership lost');`,
      ),
    );
    runExpectedFailure('ownership-cause erasure', /stopReclaim|undefinedHeartbeat|wakePoll/u);
    fs.writeFileSync(target, original);
  }
  {
    const block = `if (fatal !== undefined || options.signal.aborted)\n            break;\n        for (const claim of claims) {`;
    assert.equal(original.includes(block), true, 'post-claim stop-gate mutation anchor is stale');
    const inner = `if ((_b = options.signal) === null || _b === void 0 ? void 0 : _b.aborted)\n        stop();`;
    assert.equal(
      original.includes(inner),
      true,
      'processClaim pre-handler stop-gate anchor is stale',
    );
    const mutant = original
      .replace(block, `if (false)\n            break;\n        for (const claim of claims) {`)
      .replace(inner, `if (false)\n        stop();`);
    fs.writeFileSync(target, mutant);
    runExpectedFailure('dual post-stop handler admission fences', /lateClaimStop/u);
    fs.writeFileSync(target, original);
  }
  {
    const needle = 'wakePoll === null || wakePoll === void 0 ? void 0 : wakePoll();';
    assert.equal(original.includes(needle), true, 'wakePoll mutation anchor is stale');
    fs.writeFileSync(target, original.replace(needle, 'void wakePoll;'));
    runExpectedFailure('lost active-fatal poll wakeup', /wakePoll/u);
    fs.writeFileSync(target, original);
  }
} finally {
  fs.writeFileSync(target, original);
}
