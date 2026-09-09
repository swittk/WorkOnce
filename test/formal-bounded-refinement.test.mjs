import test from 'node:test';
import assert from 'node:assert/strict';
import { runBoundedRefinementCorpus } from '../scripts/formal-bounded-refinement-corpus.mjs';

const EXPECTED_COVERAGE_KEYS = [
  'attemptBudgetExhausted',
  'cancelQueued',
  'cancelRunning',
  'cancelWaiting',
  'cancelled',
  'claimA',
  'claimB',
  'conflictingSettlementRejected',
  'deadlineExceeded',
  'defer',
  'deferralBudgetExhausted',
  'dualExecutorCompetition',
  'dynamicDefer',
  'dynamicLimits',
  'dynamicNext',
  'dynamicRetry',
  'externalClaimLimit',
  'externalSuccessFollowup',
  'failed',
  'failureFollowup',
  'fenceIncrease',
  'followupBlocksReset',
  'followupDispatch',
  'generationTwo',
  'identicalSettlementReplay',
  'invalidExternalRenewal',
  'itemHandleKeyBinding',
  'leaseReclaim',
  'managedExternalFatalClaimBackoffWake',
  'managedExternalFatalClaimGate',
  'managedExternalFatalWake',
  'managedRunnerFatalClaimBackoffWake',
  'managedRunnerFatalClaimGate',
  'managedRunnerFatalWake',
  'manualRetry',
  'manualRetryDenied',
  'missingHandlerPromiseRejection',
  'oneMillisecondLease',
  'outcomeHelperAuthority',
  'parallelClaimCompetition',
  'queued',
  'renew',
  'rerun',
  'rerunDenied',
  'retryAllowed',
  'retryBudgetExhausted',
  'retryDenied',
  'running',
  'staleRenew',
  'staleSettle',
  'succeeded',
  'successFollowup',
  'timestampRange',
  'waitingDefer',
  'waitingRetry',
  'wake',
  'workerErrorIsolation',
];

test('bounded implementation refinement covers every reviewed WorkOnce lifecycle outcome', async () => {
  const report = await runBoundedRefinementCorpus();
  assert.equal(report.deterministicScenarios, 43);
  assert.equal(report.fuzzTraces, 96);
  assert.deepEqual(Object.keys(report.coverage).sort(), EXPECTED_COVERAGE_KEYS);
  assert.ok(Object.values(report.coverage).every((count) => count > 0));
});
