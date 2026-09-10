import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertLifecycleRefinementSamples,
  runLifecycleRefinementSamples,
} from '../scripts/lifecycle-refinement.mjs';

test('compiled lifecycle observations cover hidden revisions, receipts, scan fairness, adapter parity and boundaries', async () => {
  const samples = await runLifecycleRefinementSamples();
  assertLifecycleRefinementSamples(samples);
});

test('lifecycle refinement rejects adapter substitution without a count change', async () => {
  const samples = await runLifecycleRefinementSamples();
  for (const kind of ['claimLimit', 'stolenPageContinuation']) {
    const sqliteIndex = samples.findIndex(
      (sample) => sample.kind === kind && sample.adapter === 'sqlite',
    );
    const memory = samples.find((sample) => sample.kind === kind && sample.adapter === 'memory');
    assert.notEqual(sqliteIndex, -1);
    assert.ok(memory);
    const mutant = samples.map((sample, index) => (index === sqliteIndex ? { ...memory } : sample));
    assert.throws(
      () => assertLifecycleRefinementSamples(mutant),
      new RegExp(`${kind} adapter coverage drifted`, 'u'),
    );
  }
});

test('lifecycle refinement rejects count-preserving sample-kind substitution', async () => {
  const samples = await runLifecycleRefinementSamples();
  const sourceIndex = samples.findIndex((sample) => sample.kind === 'leaseFenceCause');
  const replacement = samples.find((sample) => sample.kind === 'generationCompetition');
  assert.notEqual(sourceIndex, -1);
  assert.ok(replacement);
  const mutant = samples.map((sample, index) =>
    index === sourceIndex ? { ...replacement } : sample,
  );
  assert.throws(
    () => assertLifecycleRefinementSamples(mutant),
    /lifecycle sample kind coverage drifted/u,
  );
});

test('lifecycle refinement rejects count-preserving terminal outcome substitution', async () => {
  const samples = await runLifecycleRefinementSamples();
  for (const kind of ['terminalReceipt', 'terminalAckLoss']) {
    const failIndex = samples.findIndex(
      (sample) => sample.kind === kind && sample.outcomeKind === 'fail',
    );
    const succeed = samples.find(
      (sample) => sample.kind === kind && sample.outcomeKind === 'succeed',
    );
    assert.notEqual(failIndex, -1);
    assert.ok(succeed);
    const mutant = samples.map((sample, index) => (index === failIndex ? { ...succeed } : sample));
    assert.throws(
      () => assertLifecycleRefinementSamples(mutant),
      new RegExp(`${kind} outcome coverage drifted`, 'u'),
    );
  }
});

test('lifecycle refinement rejects extra evidence fields in equivalence families', async () => {
  const samples = await runLifecycleRefinementSamples();
  for (const kind of ['claimOrderEquivalence', 'adapterLifecycleEquivalence']) {
    const mutant = samples.map((sample) =>
      sample.kind === kind ? { ...sample, unexpectedEvidence: true } : sample,
    );
    assert.throws(
      () => assertLifecycleRefinementSamples(mutant),
      new RegExp(`${kind} evidence fields drifted`, 'u'),
    );
  }
});

test('lifecycle refinement rejects an omitted required evidence field', async () => {
  const samples = await runLifecycleRefinementSamples();
  const mutant = samples.map((sample) => {
    if (sample.kind !== 'terminalReceipt' || sample.outcomeKind !== 'succeed') return sample;
    const { resetClearsReceipt: _removed, ...rest } = sample;
    return rest;
  });
  assert.throws(
    () => assertLifecycleRefinementSamples(mutant),
    /terminalReceipt evidence fields drifted/u,
  );
});
