import test from 'node:test';
import assert from 'node:assert/strict';
import { runBoundedRefinementCorpus } from '../scripts/formal-bounded-refinement-corpus.mjs';

test('bounded implementation refinement covers every reviewed WorkOnce lifecycle outcome', async () => {
  const report = await runBoundedRefinementCorpus();
  assert.ok(report.deterministicScenarios >= 20);
  assert.equal(report.fuzzTraces, 96);
  assert.ok(Object.values(report.coverage).every((count) => count > 0));
});
