import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptsRoot = path.join(root, 'scripts');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
function boundedSection(source, startAnchor, endAnchor, label) {
  const start = source.indexOf(startAnchor);
  assert.notEqual(start, -1, `${label} start anchor is missing`);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  assert.ok(end > start, `${label} end anchor is missing or precedes its start`);
  return source.slice(start, end);
}

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
    if (!/node:child_process/u.test(source)) continue;
    assert.match(
      source,
      /import\s*\{[^}]*\bspawnSync\b[^}]*\}\s*from ['"]node:child_process['"]/u,
      `${name} must import spawnSync so the shared bounded/fail-closed subprocess controls apply`,
    );
    assert.match(
      source,
      /\bspawnSync\(/u,
      `${name} must use spawnSync so the shared bounded/fail-closed subprocess controls apply`,
    );
    assert.match(source, /\btimeout\s*(?::|,)/u, `${name} has an unbounded mutation subprocess`);
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

  for (const name of fs
    .readdirSync(path.join(root, 'scripts'))
    .filter((name) => name.endsWith('refinement.mjs'))) {
    const source = read(`scripts/${name}`);
    assert.doesNotMatch(
      source,
      /\b(?:materiallyDifferentHistory|noFatalEscape|expectedEndpoint|perIdContractPreserved|drained)\s*:\s*true\b/u,
      `${name} fabricates a proof-result boolean instead of deriving it from observations`,
    );
    assert.doesNotMatch(
      source,
      /await\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?\.promise\s*;/u,
      `${name} contains a bare deferred await instead of a bounded refinement wait`,
    );
  }
  const boundedCorpus = read('scripts/formal-bounded-refinement-corpus.mjs');
  assert.doesNotMatch(
    boundedCorpus,
    /while\s*\([^)]*claimCalls[^)]*\)\s*(?:\{)?[\s\S]{0,180}?setTimeout/u,
    'formal bounded refinement corpus contains an unbounded claim-count spin wait',
  );
  const lifecycleFormalTest = read('test/lifecycle-formal.test.mjs');
  assert.match(
    lifecycleFormalTest,
    /maxBuffer:\s*64 \* 1024 \* 1024/u,
    'lifecycle formal wrapper must bound captured TLC output explicitly',
  );
  const storageSourceModelMutation = read('scripts/check-storage-source-model-mutation.mjs');
  assert.match(storageSourceModelMutation, /process\.once\('SIGINT'/u);
  assert.match(storageSourceModelMutation, /process\.once\('SIGTERM'/u);

  for (const name of fs
    .readdirSync(path.join(root, 'test/process'))
    .filter((name) => name.endsWith('.mjs'))) {
    const source = read(`test/process/${name}`);
    assert.doesNotMatch(
      source,
      /once\([^,]+,\s*['"]exit['"]\s*\)/u,
      `${name} contains an unbounded child exit wait`,
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
  assert.match(lifecycleFormal, /let specSwapped = false/u);
  assert.match(lifecycleFormal, /specSwapped = true/u);
  assert.match(lifecycleFormal, /if \(!specSwapped\)[\s\S]{0,160}?SPECIFICATION Spec/u);

  const storageFormal = read('scripts/storage-formal.mjs');
  assert.match(storageFormal, /classifyTlcOutcome/u);
  assert.match(storageFormal, /requireExpectedInvariantViolation\(result, invariant\)/u);
  assert.doesNotMatch(storageFormal, /const rejectedForInvariant\s*=/u);

  const storageRefinement = read('scripts/storage-refinement.mjs');
  assert.doesNotMatch(storageRefinement, /oneAccepted\s*:\s*true/u);
  assert.doesNotMatch(storageRefinement, /maxSafeAccepted\s*:\s*true/u);
  assert.match(storageRefinement, /oneAccepted\s*=\s*true/u);
  assert.match(storageRefinement, /maxSafeAccepted\s*=\s*true/u);
  const historyWitness = boundedSection(
    storageRefinement,
    'materiallyDifferentHistory:',
    'sameDurableProjection:',
    'storage history provenance',
  );
  for (const required of ['completedRequests', 'before.revision', 'future.history.length'])
    assert.ok(
      historyWitness.includes(required),
      `storage history provenance no longer derives materiallyDifferentHistory from observed ${required}`,
    );

  const lifecycleRefinement = read('scripts/lifecycle-refinement.mjs');
  const resetSample = boundedSection(
    lifecycleRefinement,
    'async function resetCheckRaceSample',
    '\nasync function ',
    'reset-check race sample',
  );
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
  const drainSample = boundedSection(
    lifecycleRefinement,
    'async function finiteDrainSample',
    '\nasync function ',
    'finite-drain sample',
  );
  assert.match(drainSample, /const maxPasses\s*=\s*\d+/u);
  assert.match(drainSample, /for \(; passes < maxPasses; passes\+\+\)/u);
  assert.match(drainSample, /boundedPasses:\s*passes < maxPasses/u);
  assert.doesNotMatch(drainSample, /for \(;;\)/u);

  const externalRefinement = read('scripts/external-transport-refinement.mjs');
  const leaseSample = boundedSection(
    externalRefinement,
    'async function leaseBoundarySample',
    '\nasync function heartbeatFailureSample',
    'external lease-boundary sample',
  );
  assert.match(leaseSample, /async function one\(lease, claimDelayMs = 0\)/u);
  assert.match(leaseSample, /if \(claimDelayMs > 0\) await sleep\(claimDelayMs\)/u);
  assert.match(leaseSample, /delayedOneTick = await one\([\s\S]*?,\s*5,\s*\)/u);
  assert.match(leaseSample, /oneTickHeartbeatCompatible/u);
  assert.match(leaseSample, /Confirmed external lease deadline passed/u);
  assert.match(leaseSample, /delayedOneTick\.heartbeatCalls === 0/u);
  const externalModel = read('formal/WorkOnceExternal.tla');
  assert.match(externalModel, /s\.oneTickHeartbeatCompatible/u);
  assert.doesNotMatch(externalModel, /s\.oneTickAccepted/u);

  const localRunnerRefinement = read('scripts/local-runner-refinement.mjs');
  assert.match(localRunnerRefinement, /function within\(promise, label, timeoutMs = 3000\)/u);
  assert.match(localRunnerRefinement, /local runner refinement timed out waiting for/u);
  assert.doesNotMatch(localRunnerRefinement, /await [A-Za-z_$][A-Za-z0-9_$.[\]]*\.promise;/u);
  assert.match(
    localRunnerRefinement,
    /Object\.prototype\.hasOwnProperty\.call\(result, 'error'\)/u,
  );

  const readHistory = read('scripts/read-history-refinement.mjs');
  const mixedSample = boundedSection(
    readHistory,
    'async function casMixedRaceSample',
    '\nexport async function ',
    'CAS mixed-race sample',
  );
  assert.match(mixedSample, /finally\s*\{/u);
  assert.match(mixedSample, /release\.resolve\(\)/u);
  assert.match(mixedSample, /Promise\.allSettled\(\[reading\]\)/u);

  const ackSample = boundedSection(
    externalRefinement,
    'async function unknownAckHistorySample',
    '\nexport async function runExternalTransportSamples',
    'unknown-ACK history sample',
  );
  assert.match(ackSample, /async heartbeat\(\) \{/u);
  assert.match(ackSample, /return \{ observedAt: 100, leaseUntil: 120 \}/u);
  assert.doesNotMatch(ackSample, /heartbeat: service\.heartbeat/u);

  const processTest = read('test/process/local-runner-process.test.mjs');
  const messageHelper = boundedSection(
    processTest,
    'function start(path, mode)',
    '\nasync function kill(child)',
    'local-runner buffered IPC helper',
  );
  assert.match(processTest, /const childInboxes = new WeakMap\(\)/u);
  assert.match(messageHelper, /child\.on\('message'/u);
  assert.match(messageHelper, /inbox\.messages\.push\(message\)/u);
  assert.match(messageHelper, /inbox\.messages\.shift\(\)/u);
  assert.match(messageHelper, /inbox\.waiters\.push\(waiter\)/u);
  assert.match(messageHelper, /child\.once\('exit'/u);
  assert.match(messageHelper, /child\.once\('error'/u);
  assert.match(messageHelper, /Local-runner child exited before its next IPC message/u);
  assert.doesNotMatch(messageHelper, /child\.once\('message'/u);

  const multiFixture = boundedSection(
    processTest,
    "test('SIGKILL with three active local attempts",
    "\ntest('SIGKILL after heartbeat",
    'multi-active crash fixture',
  );
  assert.match(multiFixture, /seed\(path, 3, 2000\)/u);
  assert.match(multiFixture, /inspectMany\(\['0', '1', '2'\]\)/u);
  assert.match(multiFixture, /snapshot\?\.phase\.state === 'running'/u);
  assert.match(multiFixture, /snapshots\.map\(\(snapshot\) => snapshot\.phase\.attempt\)/u);
  assert.doesNotMatch(multiFixture, /nextMessage\(child\)/u);
  assert.match(multiFixture, /sleep\(2050\)/u);
  assert.match(multiFixture, /reopen\(path, 2000\)/u);
  const processChild = read('test/process/local-runner-child.mjs');
  assert.match(processChild, /mode === 'multi-active' \? 2000 : 200/u);

  const killHelper = boundedSection(
    processTest,
    'async function kill(child)',
    '\nasync function ',
    'local-runner kill helper',
  );
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
