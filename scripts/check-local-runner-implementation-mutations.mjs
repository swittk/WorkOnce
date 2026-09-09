import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'dist/worker.js');
const original = fs.readFileSync(target, 'utf8');
function runExpectedFailure(label, witness, pattern) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { assertLocalRunnerMutationWitness } from './scripts/local-runner-refinement.mjs'; await assertLocalRunnerMutationWitness(${JSON.stringify(witness)});`,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      timeout: 10_000,
    },
  );
  requireExpectedProcessFailure(result, `${label} mutant`, pattern);
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
    runExpectedFailure('ownership-cause erasure', 'ownershipCause', /ownershipCause/u);
    fs.writeFileSync(target, original);
  }
  {
    const block = `if (fatal !== undefined || options.signal.aborted)\n            break;\n        for (const claim of claims) {`;
    assert.equal(
      original.split(block).length,
      2,
      'post-claim stop-gate mutation anchor must be unique',
    );
    const inner = `if ((_b = options.signal) === null || _b === void 0 ? void 0 : _b.aborted)\n        stop();`;
    assert.equal(
      original.split(inner).length,
      2,
      'processClaim pre-handler stop-gate anchor must be unique',
    );
    const mutant = original
      .replace(block, `if (false)\n            break;\n        for (const claim of claims) {`)
      .replace(inner, `if (false)\n        stop();`);
    fs.writeFileSync(target, mutant);
    runExpectedFailure(
      'dual post-stop handler admission fences',
      'lateClaimStop',
      /lateClaimStop/u,
    );
    fs.writeFileSync(target, original);
  }
  {
    const needle = `if (fatal === undefined)
            fatal = { error };`;
    assert.equal(original.split(needle).length, 2, 'first-fatal mutation anchor must be unique');
    fs.writeFileSync(target, original.replace(needle, 'fatal = { error };'));
    runExpectedFailure('first fatal overwrite', 'firstFatal', /firstFatal/u);
    fs.writeFileSync(target, original);
  }
  {
    const needle = 'wakePoll === null || wakePoll === void 0 ? void 0 : wakePoll();';
    assert.equal(original.split(needle).length, 2, 'wakePoll mutation anchor must be unique');
    fs.writeFileSync(target, original.replace(needle, 'void wakePoll;'));
    runExpectedFailure('lost active-fatal poll wakeup', 'wakePoll', /wakePoll/u);
    fs.writeFileSync(target, original);
  }
} finally {
  fs.writeFileSync(target, original);
}
