import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kernelPath = path.join(root, 'dist/kernel.js');
const workPath = path.join(root, 'dist/work.js');
const originals = new Map([
  [kernelPath, fs.readFileSync(kernelPath, 'utf8')],
  [workPath, fs.readFileSync(workPath, 'utf8')],
]);
function restore() {
  for (const [file, text] of originals) fs.writeFileSync(file, text);
}
function runExpectedFailure(label, pattern) {
  const result = spawnSync(process.execPath, ['--test', 'test/read-history-refinement.test.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 10_000,
  });
  requireExpectedProcessFailure(result, `${label} mutant`, pattern);
  console.log(`Read-history implementation mutation guard rejects ${label}.`);
}
try {
  {
    const original = originals.get(kernelPath);
    const needle = '...row.history.slice(-127),';
    assert.equal(original.includes(needle), true, 'history retention mutation anchor is stale');
    fs.writeFileSync(kernelPath, original.replace(needle, '...row.history.slice(-126),'));
    runExpectedFailure(
      '127-event history retention',
      /historyTruncation\.(?:retainedEvents|exactly128)/u,
    );
    restore();
  }
  {
    const original = originals.get(workPath);
    const needle = 'return copy(row.history);';
    assert.equal(original.includes(needle), true, 'history order mutation anchor is stale');
    fs.writeFileSync(workPath, original.replace(needle, 'return copy(row.history).reverse();'));
    runExpectedFailure(
      'reversed public history order',
      /historyCongruence\.allFutureHistoryTailsSame|historyTruncation\.latestActionsExact/u,
    );
    restore();
  }
} finally {
  restore();
}
