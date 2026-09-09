import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptsRoot = path.join(root, 'scripts');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

export function assertAssuranceVerdictIntegrity() {
  const mutationFiles = fs
    .readdirSync(scriptsRoot)
    .filter((name) => /^check-.*mutation.*\.mjs$/u.test(name))
    .filter((name) => name !== 'check-assurance-verdict-integrity-mutation.mjs')
    .sort();
  const bareStatusPatterns = [
    /assert\.(?:notEqual|notStrictEqual|equal|strictEqual)\([\s\S]{0,160}?\.status\s*,\s*0\b/gu,
    /\b[A-Za-z_$][A-Za-z0-9_$]*\.status\s*(?:===|!==|==|!=)\s*0\b/gu,
  ];
  for (const name of mutationFiles) {
    const source = read(`scripts/${name}`);
    if (!source.includes('spawnSync')) continue;
    assert.match(source, /timeout:\s*\d/u, `${name} has an unbounded mutation subprocess`);
    for (const pattern of bareStatusPatterns) {
      pattern.lastIndex = 0;
      assert.equal(
        pattern.test(source),
        false,
        `${name} contains a bare child exit-status verdict instead of the shared fail-closed subprocess classifier`,
      );
    }
    if (/\b[A-Za-z_$][A-Za-z0-9_$]*\.status\b/u.test(source))
      assert.match(
        source,
        /requireExpectedProcessFailure|requireSuccessfulProcess/u,
        `${name} inspects child status without the shared fail-closed subprocess classifier`,
      );
  }

  const liveTlcProbe = read('scripts/check-tlc-outcome-classification.mjs');
  assert.match(
    liveTlcProbe,
    /requireExpectedProcessFailure\(result, 'invalid TLC jar formal-assurance probe'\)/u,
  );
  assert.match(liveTlcProbe, /timeout:\s*15_000/u);

  const formalConformance = read('scripts/check-formal-implementation-conformance.mjs');
  assert.match(
    formalConformance,
    /requireSuccessfulProcess\(result, 'formal implementation surface extractor'\)/u,
  );
  assert.match(
    formalConformance,
    /--check-semantic-environment-binding-only/u,
    'formal conformance must retain the fast compiler/toolchain binding-only control',
  );
  assert.match(
    formalConformance,
    /previousDigest !== currentDigest[\s\S]{0,240}?canonicalText\(previousFiles\) !== canonicalText\(semanticEnvironmentFiles\)/u,
    'fast compiler/toolchain binding control must compare the same reviewed file list and digest used by the full manifest',
  );
  assert.match(formalConformance, /maxBuffer: 32 \* 1024 \* 1024,[\s\S]{0,120}?timeout:\s*30_000/u);

  const sourceHashTest = read('test/source-semantic-hash.test.mjs');
  assert.match(sourceHashTest, /requireSuccessfulProcess\(result, 'source semantic hash proof'\)/u);
  assert.match(sourceHashTest, /timeout:\s*30_000/u);

  const lifecycleFormal = read('scripts/lifecycle-formal.mjs');
  assert.match(lifecycleFormal, /classifyTlcOutcome/u);
  assert.match(lifecycleFormal, /requireExpectedInvariantViolation\(result, invariant\)/u);
  assert.doesNotMatch(lifecycleFormal, /const semanticFailure\s*=/u);

  const storageFormal = read('scripts/storage-formal.mjs');
  assert.match(storageFormal, /classifyTlcOutcome/u);
  assert.match(storageFormal, /requireExpectedInvariantViolation\(result, invariant\)/u);
  assert.doesNotMatch(storageFormal, /const rejectedForInvariant\s*=/u);

  const storageRefinement = read('scripts/storage-refinement.mjs');
  assert.doesNotMatch(storageRefinement, /oneAccepted\s*:\s*true/u);
  assert.doesNotMatch(storageRefinement, /maxSafeAccepted\s*:\s*true/u);
  assert.match(storageRefinement, /oneAccepted\s*=\s*true/u);
  assert.match(storageRefinement, /maxSafeAccepted\s*=\s*true/u);
  const historyStart = storageRefinement.indexOf('materiallyDifferentHistory:');
  const historyEnd = storageRefinement.indexOf('sameDurableProjection:', historyStart);
  assert.ok(
    historyStart >= 0 && historyEnd > historyStart,
    'storage history provenance field is missing',
  );
  const historyWitness = storageRefinement.slice(historyStart, historyEnd);
  for (const required of ['completedRequests', 'before.revision', 'future.history.length'])
    assert.ok(
      historyWitness.includes(required),
      `storage history provenance no longer derives materiallyDifferentHistory from observed ${required}`,
    );

  const lifecycleRefinement = read('scripts/lifecycle-refinement.mjs');
  const resetStart = lifecycleRefinement.indexOf('async function resetCheckRaceSample');
  const resetEnd = lifecycleRefinement.indexOf('\nasync function ', resetStart + 1);
  const resetSample = lifecycleRefinement.slice(resetStart, resetEnd);
  assert.ok(
    resetSample.indexOf('entered.resolve();') >= 0,
    'reset race no longer signals callback entry',
  );
  assert.ok(
    resetSample.indexOf('entered.resolve();') <
      resetSample.indexOf('assert.equal(snapshot.generation'),
    'reset race signals entry after assertions and can strand the outer waiter',
  );
  assert.match(resetSample, /Promise\.race\(\[entered\.promise, pending\]\)/u);
  const drainStart = lifecycleRefinement.indexOf('async function finiteDrainSample');
  const drainEnd = lifecycleRefinement.indexOf('\nasync function ', drainStart + 1);
  const drainSample = lifecycleRefinement.slice(drainStart, drainEnd);
  assert.match(drainSample, /const maxPasses\s*=\s*\d+/u);
  assert.match(drainSample, /for \(; passes < maxPasses; passes\+\+\)/u);
  assert.match(drainSample, /boundedPasses:\s*passes < maxPasses/u);
  assert.doesNotMatch(drainSample, /for \(;;\)/u);

  const externalRefinement = read('scripts/external-transport-refinement.mjs');
  const leaseStart = externalRefinement.indexOf('async function leaseBoundarySample');
  const leaseEnd = externalRefinement.indexOf(
    '\nasync function heartbeatFailureSample',
    leaseStart + 1,
  );
  const leaseSample = externalRefinement.slice(leaseStart, leaseEnd);
  assert.match(leaseSample, /async function one\(lease, claimDelayMs = 0\)/u);
  assert.match(leaseSample, /if \(claimDelayMs > 0\) await sleep\(claimDelayMs\)/u);
  assert.match(leaseSample, /delayedOneTick = await one\([\s\S]*?,\s*5,\s*\)/u);
  assert.match(leaseSample, /oneTickHeartbeatCompatible/u);
  assert.match(leaseSample, /Confirmed external lease deadline passed/u);
  assert.match(leaseSample, /delayedOneTick\.heartbeatCalls === 0/u);
  const externalModel = read('formal/WorkOnceExternal.tla');
  assert.match(externalModel, /s\.oneTickHeartbeatCompatible/u);
  assert.doesNotMatch(externalModel, /s\.oneTickAccepted/u);

  const readHistory = read('scripts/read-history-refinement.mjs');
  const mixedStart = readHistory.indexOf('async function casMixedRaceSample');
  const mixedEnd = readHistory.indexOf('\nexport async function ', mixedStart + 1);
  const mixedSample = readHistory.slice(mixedStart, mixedEnd);
  assert.match(mixedSample, /finally\s*\{/u);
  assert.match(mixedSample, /release\.resolve\(\)/u);
  assert.match(mixedSample, /Promise\.allSettled\(\[reading\]\)/u);

  const processTest = read('test/process/local-runner-process.test.mjs');
  const messageStart = processTest.indexOf('async function nextMessage(child)');
  const messageEnd = processTest.indexOf('\nasync function kill(child)', messageStart + 1);
  const messageHelper = processTest.slice(messageStart, messageEnd);
  assert.match(messageHelper, /child\.once\('message', onMessage\)/u);
  assert.match(messageHelper, /child\.once\('exit', onExit\)/u);
  assert.match(messageHelper, /child\.once\('error', onError\)/u);
  assert.match(messageHelper, /child\.exitCode !== null \|\| child\.signalCode !== null/u);
  assert.match(messageHelper, /Local-runner child exited before its next IPC message/u);
  assert.doesNotMatch(messageHelper, /once\(child, 'message', \{ signal: AbortSignal\.timeout/u);

  const multiStart = processTest.indexOf("test('SIGKILL with three active local attempts");
  const multiEnd = processTest.indexOf("\ntest('SIGKILL after heartbeat", multiStart + 1);
  const multiFixture = processTest.slice(multiStart, multiEnd);
  assert.match(multiFixture, /seed\(path, 3, 2000\)/u);
  assert.match(multiFixture, /sleep\(2050\)/u);
  assert.match(multiFixture, /reopen\(path, 2000\)/u);
  const processChild = read('test/process/local-runner-child.mjs');
  assert.match(processChild, /mode === 'multi-active' \? 2000 : 200/u);

  const killStart = processTest.indexOf('async function kill(child)');
  const killEnd = processTest.indexOf('\nasync function ', killStart + 1);
  const killHelper = processTest.slice(killStart, killEnd);
  assert.match(killHelper, /child\.exitCode !== null \|\| child\.signalCode !== null/u);
  assert.match(killHelper, /AbortSignal\.timeout\(15000\)/u);
  assert.match(killHelper, /assert\.equal\(signal, 'SIGKILL'\)/u);

  const assuranceRunner = read('scripts/run-assurance.mjs');
  assert.match(assuranceRunner, /requireSuccessfulProcess\(result, label\)/u);
  assert.match(assuranceRunner, /const terminateSiblings = \(failedChild\) =>/u);
  assert.match(assuranceRunner, /child\.kill\(\)/u);
  assert.ok(
    (assuranceRunner.match(/terminateSiblings\(child\)/gu) ?? []).length >= 3,
    'parallel assurance failure paths no longer terminate surviving siblings',
  );

  for (const wrapper of [
    'test/lifecycle-formal.test.mjs',
    'test/lifecycle-proof-controls.test.mjs',
  ])
    assert.match(
      read(wrapper),
      /requireSuccessfulProcess/u,
      `${wrapper} must preserve timeout/signal/spawn causes through the shared subprocess classifier`,
    );

  return mutationFiles.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mutationFiles = assertAssuranceVerdictIntegrity();
  console.log(
    `Assurance verdict integrity is fail-closed across ${mutationFiles} mutation checkers, TLC classification, observed witnesses, bounded races/drains and process-fault waits.`,
  );
}
