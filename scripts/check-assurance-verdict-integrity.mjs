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
    assert.doesNotMatch(
      source,
      /Object\.entries\(sample\)/u,
      `${name} validates only evidence fields that happen to be present instead of an exact sample schema`,
    );
  }
  const heartbeatLocalRunnerRefinement = read('scripts/local-runner-refinement.mjs');
  const localHeartbeatAttempts = [
    ...heartbeatLocalRunnerRefinement.matchAll(/await within\(heartbeatAttempted\.promise/gu),
  ].length;
  assert.equal(
    localHeartbeatAttempts,
    2,
    'local runner cause-precision witnesses must synchronize on both defined and undefined heartbeat attempts',
  );
  assert.match(
    heartbeatLocalRunnerRefinement,
    /const leaseMs = mode === 'heartbeat' \? 500 : 80/u,
    'local heartbeat-loss witness must keep expiry well outside the injected heartbeat-failure race',
  );
  assert.match(
    heartbeatLocalRunnerRefinement,
    /await waitForAbort\(run\.signal, `\$\{adapter\}-heartbeat ownership abort`\)/u,
    'local heartbeat-loss witness must observe the ownership abort before returning the handler outcome',
  );
  assert.doesNotMatch(
    heartbeatLocalRunnerRefinement,
    /failHeartbeat = true;[\s\S]{0,140}?await sleep\((?:30|35)\)/u,
    'local heartbeat cause-precision witness must not use scheduler delay as proof synchronization',
  );
  const heartbeatExternalRefinement = read('scripts/external-transport-refinement.mjs');
  assert.match(
    heartbeatExternalRefinement,
    /heartbeatAttempted\.resolve\(\);[\s\S]{0,500}?await within\(heartbeatAttempted\.promise, 'external heartbeat transport attempt'\)[\s\S]{0,220}?await waitForAbort\(run\.signal, 'external heartbeat ownership abort'\)/u,
    'external heartbeat cause-precision witness must synchronize on the transport attempt and ownership abort',
  );
  const externalTest = read('test/external.test.mjs');
  assert.match(
    externalTest,
    /await within\(heartbeatAttempted\.promise, 'external heartbeat attempt'\)[\s\S]{0,160}?await waitForAbort\(run\.signal, 'external heartbeat abort'\)/u,
    'direct external heartbeat test must synchronize on the attempted heartbeat and abort',
  );

  const childIpcInbox = read('test/process/child-ipc-inbox.mjs');
  assert.match(
    childIpcInbox,
    /child\.on\('message'/u,
    'child IPC inbox must use a persistent message listener',
  );
  assert.doesNotMatch(
    childIpcInbox,
    /child\.once\('message'/u,
    'child IPC inbox must not revert to a one-shot message listener',
  );

  const mutationFileGuard = read('scripts/mutation-file-guard.mjs');
  assert.match(
    mutationFileGuard,
    /dispose\(\) \{[\s\S]{0,160}?restoreAll\(\)/u,
    'mutation file guard must restore remembered files during normal disposal',
  );
  assert.match(
    mutationFileGuard,
    /process\.once\('exit', onExit\)/u,
    'mutation file guard must restore remembered files on process exit',
  );

  const boundedDomain = read('scripts/check-bounded-trace-domain.mjs');
  assert.doesNotMatch(
    boundedDomain,
    /(?:lifecycleAdapterCases|sqliteProcessCrashCases|implementationMutants|sqliteProcessCrashPrefixes)\s*:\s*\d+/u,
    'bounded-domain report contains an unobserved hard-coded coverage claim',
  );
  assert.match(
    boundedDomain,
    /historyLimit:[\s\S]{0,180}?historyTruncation[\s\S]{0,120}?retainedEvents/u,
    'bounded-domain history limit must come from the observed truncation sample',
  );
  const storageFormalSource = read('scripts/storage-formal.mjs');
  assert.match(
    storageFormalSource,
    /maxConflictsMatch[\s\S]{0,220}?formal\/WorkOnceStorage\.cfg/u,
    'storage mutation configs must derive MaxConflicts from the reviewed base config',
  );
  assert.doesNotMatch(
    storageFormalSource,
    /CONSTANT MaxConflicts = 3/u,
    'storage mutation configs must not hard-code a different MaxConflicts bound',
  );
  const policyRefinementSource = read('scripts/policy-refinement.mjs');
  assert.match(
    policyRefinementSource,
    /finally \{\s*release\.resolve\(\);\s*if \(pending\) await observe\(pending\);\s*fixture\.close\(\);/u,
    'policy async-race cleanup must settle the pending promise before fixture close',
  );

  const boundedCorpus = read('scripts/formal-bounded-refinement-corpus.mjs');
  assert.match(
    boundedCorpus,
    /worker-isolation[\s\S]{0,500}?leaseMs: 30_000, maxElapsedMs: 60_000[\s\S]{0,180}?leaseMs: 30_000, maxElapsedMs: 60_000/u,
    'worker-isolation proof must keep both lease and generation elapsed deadline outside CI scheduler stalls',
  );
  assert.doesNotMatch(
    boundedCorpus,
    /while\s*\([^)]*claimCalls[^)]*\)\s*(?:\{)?[\s\S]{0,180}?setTimeout/u,
    'formal bounded refinement corpus contains an unbounded claim-count spin wait',
  );
  assert.ok(
    storageFormalSource.includes(['max', 'Buffer: 16 * 1024 * 1024,'].join('')),
    'storage formal wrapper must bound captured TLC output explicitly',
  );
  const outboxRefinement = read('scripts/outbox-refinement.mjs');
  assert.match(
    outboxRefinement,
    /await within\(parentAckEntered, 'stale-parent held acknowledgement'\)/u,
    'outbox stale-parent refinement must bound its held-acknowledgement wait',
  );
  const lifecycleFormalTest = read('test/lifecycle-formal.test.mjs');
  assert.match(
    lifecycleFormalTest,
    /maxBuffer:\s*64 \* 1024 \* 1024/u,
    'lifecycle formal wrapper must bound captured TLC output explicitly',
  );
  for (const name of fs
    .readdirSync(path.join(root, 'test/process'))
    .filter((name) => name.endsWith('.mjs'))) {
    const source = read(`test/process/${name}`);
    assert.doesNotMatch(
      source,
      /once\([^,]+,\s*['"]exit['"]\s*\)/u,
      `${name} contains an unbounded child exit wait`,
    );
    if (name.endsWith('.test.mjs')) {
      assert.doesNotMatch(
        source,
        /once\([^,]+,\s*['"]message['"]/u,
        `${name} contains a lossy one-shot child IPC message wait instead of the buffered inbox`,
      );
      assert.doesNotMatch(
        source,
        /\bfork\(/u,
        `${name} forks a process without immediately attaching the buffered child IPC inbox`,
      );
    }
  }

  const generatedMutationRoots = ['dist', 'dist-cjs', '.artifacts'];
  for (const name of mutationFiles) {
    const source = read(`scripts/${name}`);
    if (!/(?:writeFileSync|appendFileSync)\(/u.test(source)) continue;
    if (/createMutationFileGuard\(\)/u.test(source)) continue;
    const declaredTargets = [
      ...[...source.matchAll(/path\.join\(root,\s*['"]([^'"]+)['"]/gu)].map((match) => match[1]),
    ];
    for (const helperName of ['requireRed', 'mutate', 'mutateFile'])
      if (new RegExp(`function ${helperName}\\(relative\\b`, 'u').test(source))
        declaredTargets.push(
          ...[
            ...source.matchAll(new RegExp(`\\b${helperName}\\(\\s*['\"]([^'\"]+)['\"]`, 'gu')),
          ].map((match) => match[1]),
        );
    assert.ok(
      declaredTargets.length > 0,
      `${name} writes mutation files but its target roots cannot be proven generated-only`,
    );
    const generatedOnly = declaredTargets.every((target) =>
      generatedMutationRoots.some(
        (rootName) => target === rootName || target.startsWith(`${rootName}/`),
      ),
    );
    assert.equal(
      generatedOnly,
      true,
      `${name} mutates tracked source/config without signal-safe file restoration`,
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
  assert.match(
    lifecycleFormal,
    /encoding: 'utf8'[\s\S]{0,100}?maxBuffer: 16 \* 1024 \* 1024/u,
    'lifecycle formal runner must capture TLC output with an explicit buffer bound',
  );
  assert.match(
    lifecycleFormal,
    /process\.stdout\.write\(result\.stdout \?\? ''\)/u,
    'lifecycle formal runner must re-emit captured TLC stdout after classification',
  );
  assert.match(
    lifecycleFormal,
    /process\.stderr\.write\(result\.stderr \?\? ''\)/u,
    'lifecycle formal runner must re-emit captured TLC stderr after classification',
  );
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
  assert.match(
    ackSample,
    /async heartbeat\(\) \{/u,
    'unknown-ACK history sample must use deterministic heartbeat stub',
  );
  assert.match(ackSample, /return \{ observedAt: 100, leaseUntil: 120 \}/u);
  assert.doesNotMatch(ackSample, /heartbeat: service\.heartbeat/u);

  const processTest = read('test/process/local-runner-process.test.mjs');
  const messageHelper = boundedSection(
    processTest,
    'function start(path, mode)',
    '\nasync function kill(child)',
    'local-runner buffered IPC helper',
  );
  assert.match(
    processTest,
    /import \{ forkWithInbox, nextChildMessage \} from '\.\/child-ipc-inbox\.mjs'/u,
    'local-runner process fixture must use the shared buffered IPC inbox',
  );
  assert.match(messageHelper, /forkWithInbox\(/u);
  assert.match(messageHelper, /nextChildMessage\(child, 15000\)/u);

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
  assert.match(
    assuranceRunner,
    /child\.kill\(\)/u,
    'parallel assurance failure paths must kill surviving siblings',
  );
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
