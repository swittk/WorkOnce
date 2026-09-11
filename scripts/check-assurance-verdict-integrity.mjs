import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptsRoot = path.join(root, 'scripts');
const testRoot = path.join(root, 'test');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
function boundedSection(source, startAnchor, endAnchor, label) {
  const start = source.indexOf(startAnchor);
  assert.notEqual(start, -1, `${label} start anchor is missing`);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  assert.ok(end > start, `${label} end anchor is missing or precedes its start`);
  return source.slice(start, end);
}
function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text;
  return undefined;
}
function assertSpawnSyncTimeouts(name, source) {
  const sourceFile = ts.createSourceFile(
    name,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const positiveNumber = (expression) =>
    expression && ts.isNumericLiteral(expression) && Number(expression.text) > 0;
  const directCalls = (functionName) => {
    const found = [];
    const collect = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === functionName
      )
        found.push(node);
      ts.forEachChild(node, collect);
    };
    collect(sourceFile);
    return found;
  };
  const identifierHasPositiveValue = (identifier, context) => {
    for (let current = context; current; current = current.parent) {
      if (!ts.isFunctionLike(current)) continue;
      const parameterIndex = current.parameters.findIndex(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text,
      );
      if (parameterIndex < 0) continue;
      const parameter = current.parameters[parameterIndex];
      if (!positiveNumber(parameter.initializer)) return false;
      if (!current.name || !ts.isIdentifier(current.name)) return false;
      const calls = directCalls(current.name.text);
      if (calls.length === 0) return false;
      return calls.every((call) => {
        const argument = call.arguments[parameterIndex];
        return argument === undefined ? true : positiveNumber(argument);
      });
    }
    let declaration;
    const findDeclaration = (node) => {
      if (
        declaration === undefined &&
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === identifier.text
      )
        declaration = node;
      ts.forEachChild(node, findDeclaration);
    };
    findDeclaration(sourceFile);
    return declaration !== undefined && positiveNumber(declaration.initializer);
  };
  const positiveTimeoutProperty = (property) => {
    if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === 'timeout')
      return (
        positiveNumber(property.initializer) ||
        (ts.isIdentifier(property.initializer) &&
          identifierHasPositiveValue(property.initializer, property))
      );
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'timeout')
      return identifierHasPositiveValue(property.name, property);
    return false;
  };
  let calls = 0;
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'spawnSync'
    ) {
      calls++;
      const options = node.arguments[2];
      assert.ok(
        options && ts.isObjectLiteralExpression(options),
        `${name} spawnSync options must be an inline object so timeout bounds are auditable`,
      );
      const hasPositiveTimeout = options.properties.some(positiveTimeoutProperty);
      assert.ok(
        hasPositiveTimeout,
        `${name} has an unbounded spawnSync mutation subprocess or non-positive timeout`,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  assert.ok(
    calls > 0,
    `${name} must use spawnSync so the shared bounded/fail-closed subprocess controls apply`,
  );
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
    if (!/(?:node:)?child_process/u.test(source)) continue;
    assert.match(
      source,
      /import\s*\{[^}]*\bspawnSync\b[^}]*\}\s*from ['"](?:node:)?child_process['"]/u,
      `${name} must import spawnSync so the shared bounded/fail-closed subprocess controls apply`,
    );
    assert.match(
      source,
      /\bspawnSync\(/u,
      `${name} must use spawnSync so the shared bounded/fail-closed subprocess controls apply`,
    );
    assertSpawnSyncTimeouts(name, source);
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

  for (const relative of fs
    .readdirSync(testRoot, { recursive: true })
    .filter((name) => name.endsWith('.mjs'))
    .sort()) {
    const source = read(`test/${relative}`);
    if (!/\bspawnSync\(/u.test(source)) continue;
    assertSpawnSyncTimeouts(`test/${relative}`, source);
  }

  const buildSourceBindingMutation = read('scripts/check-build-source-binding-mutation.mjs');
  assert.match(
    buildSourceBindingMutation,
    /requireSuccessfulProcess\(bindingCheck\(\), 'baseline build\/source binding'\)/u,
    'build/source mutation guard must verify a green bound baseline before creating mutants',
  );
  const buildInputBindingMutation = read('scripts/check-build-input-binding-mutation.mjs');
  assert.match(
    buildInputBindingMutation,
    /requireSuccessfulProcess\(bindingCheck\(\), 'baseline build-input binding'\)/u,
    'build-input mutation guard must establish a green baseline before mutating tracked build inputs',
  );
  const sourcePathPortabilityMutation = read('scripts/check-source-path-portability-mutation.mjs');
  assert.match(
    sourcePathPortabilityMutation,
    /WORKONCE_SOURCE_PATH_BASELINE_CERTIFIED !== String\(process\.ppid\)/u,
    'source-path mutation guard standalone baseline bypass must be bound to its direct assurance parent',
  );
  for (const [flag, label] of [
    ['--self-test-source-paths', 'baseline compiler source paths'],
    ['--self-test-trivia-ordinals', 'baseline type identity trivia'],
  ]) {
    const flagPattern = flag.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const labelPattern = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    assert.match(
      sourcePathPortabilityMutation,
      new RegExp(
        `requireSuccessfulProcess\\([\\s\\S]{0,120}?selfTest\\('${flagPattern}'\\)[\\s\\S]{0,120}?'${labelPattern}'`,
        'u',
      ),
      `source-path mutation guard must prove ${label} before standalone mutants`,
    );
  }
  const sourcePathAssuranceRunner = read('scripts/run-assurance.mjs');
  const sourcePathMutationPosition = sourcePathAssuranceRunner.indexOf(
    "run('compiler source-path portability mutation guard'",
  );
  assert.ok(
    sourcePathMutationPosition >= 0,
    'assurance runner lost compiler source-path mutation guard',
  );
  for (const label of [
    'type identity trivia baseline',
    'compiler source-path portability baseline',
  ]) {
    const baselinePosition = sourcePathAssuranceRunner.indexOf(`'${label}'`);
    assert.ok(
      baselinePosition >= 0 && baselinePosition < sourcePathMutationPosition,
      `${label} must run before compiler source-path mutants`,
    );
  }
  assert.match(
    sourcePathAssuranceRunner,
    /WORKONCE_SOURCE_PATH_BASELINE_CERTIFIED = String\(process\.pid\)/u,
    'assurance runner must bind compiler baseline certification to its own process id',
  );

  const assuranceInfrastructureBindingMutation = read(
    'scripts/check-assurance-infrastructure-binding-mutation.mjs',
  );
  for (const [pattern, label] of [
    [
      /requireSuccessfulProcess\([\s\S]{0,260}?--check-infrastructure-binding-only[\s\S]{0,160}?baseline assurance infrastructure binding/u,
      'assurance infrastructure mutation guard must establish a green infrastructure baseline',
    ],
    [
      /requireSuccessfulProcess\([\s\S]{0,260}?--check-evidence-binding-only[\s\S]{0,160}?baseline bounded-trace evidence binding/u,
      'assurance infrastructure mutation guard must establish a green bounded-evidence baseline',
    ],
    [
      /requireSuccessfulProcess\([\s\S]{0,260}?--check-semantic-environment-binding-only[\s\S]{0,160}?baseline semantic-environment binding/u,
      'assurance infrastructure mutation guard must establish a green semantic-environment baseline',
    ],
  ])
    assert.match(assuranceInfrastructureBindingMutation, pattern, label);

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
  for (const name of [
    'scripts/outbox-refinement.mjs',
    'scripts/external-transport-refinement.mjs',
  ]) {
    const source = read(name);
    assert.match(
      source,
      /waitForRefinementObservation/u,
      `${name} must use the shared fail-closed refinement liveness guard`,
    );
    assert.doesNotMatch(
      source,
      /observedWithinDeadline\s*=\s*(?:true|false)\b/u,
      `${name} must derive liveness evidence from observed state instead of scheduler time`,
    );
  }
  const refinementLiveness = read('scripts/refinement-liveness.mjs');
  assert.match(
    refinementLiveness,
    /throw new Error\(`refinement timed out waiting for \$\{label\}`\)/u,
    'refinement liveness timeout must fail closed instead of emitting false evidence',
  );

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

  const lifecycleProcessTest = read('test/process/lifecycle-process.test.mjs');
  assert.match(
    lifecycleProcessTest,
    /const lifecycleHarnessWaitBudgetMs = childMessageTimeoutMs \* 2 \+ childExitTimeoutMs/u,
    'lifecycle process harness must account for both message waits plus process exit',
  );
  assert.match(
    lifecycleProcessTest,
    /const lifecycleLeaseMs = lifecycleHarnessWaitBudgetMs \+ childMessageTimeoutMs/u,
    'lifecycle process lease must stay beyond the aggregate harness wait budget',
  );
  assert.match(
    lifecycleProcessTest,
    /\[path, mode, detail, String\(lifecycleLeaseMs\), String\(lifecycleMaxElapsedMs\)\]/u,
    'lifecycle parent must pass the authoritative timing contract to the child',
  );
  const lifecycleProcessChild = read('test/process/lifecycle-child.mjs');
  assert.match(
    lifecycleProcessChild,
    /const \[path, mode, detail, leaseMsArg, maxElapsedMsArg\] = process\.argv\.slice\(2\)/u,
    'lifecycle child must consume the parent timing contract instead of duplicating lease literals',
  );
  assert.match(
    lifecycleProcessChild,
    /limits: \{ leaseMs, maxAttempts: 4, maxElapsedMs, maxDeferrals: 4 \}/u,
    'lifecycle child definition must use the parent-supplied lease and elapsed budget',
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
  assert.match(
    mutationFileGuard,
    /fs\.writeSync\(2, `\$\{restoreFailureDiagnostic\(error\)\}\\n`\)/u,
    'mutation file guard must synchronously publish restore failures before forced exit',
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
  assert.match(
    boundedDomain,
    /'scripts\/refinement-sample-schema\.mjs'/u,
    'bounded-domain evidence must hash the shared refinement sample schema',
  );
  assert.match(
    boundedDomain,
    /'test\/process\/child-ipc-inbox\.mjs'/u,
    'bounded-domain evidence must hash the shared child IPC inbox used by process witnesses',
  );
  assert.match(
    boundedDomain,
    /'formal\/WorkOnceRuntime\.tla'/u,
    'bounded-domain evidence must hash the runtime TLA model consumed by runtime boundary proof',
  );
  assert.match(
    boundedDomain,
    /'formal\/WorkOnceRuntime\.cfg'/u,
    'bounded-domain evidence must hash the runtime TLC config consumed by runtime boundary proof',
  );
  assert.match(
    boundedDomain,
    /'scripts\/mutation-file-guard\.mjs'/u,
    'bounded-domain evidence must hash the mutation file guard used by mutation witnesses',
  );
  assert.match(
    boundedDomain,
    /if \(Object\.keys\(current\.domain\)\.length === 0\)/u,
    'bounded-domain report must fail closed when the corpus reports zero dimensions',
  );
  assert.match(
    boundedDomain,
    /'assurance\/red-before\/mutation-guard-cross-contamination\.json'/u,
    'bounded-domain evidence must hash the mutation-guard scheduling witness',
  );
  assert.match(
    boundedDomain,
    /'assurance\/red-before\/process-fault-test-concurrency\.json'/u,
    'bounded-domain evidence must hash the process-fault scheduling witness',
  );
  const sqliteBusyChild = read('test/process/sqlite-busy-child.mjs');
  assert.match(
    sqliteBusyChild,
    /process\.send\(\{ unlocking: true, unlockingAt: Date\.now\(\) \}, finishUnlock\)/u,
    'SQLite busy child must flush the unlock witness before closing its IPC channel',
  );
  const formalSource = read('scripts/formal.mjs');
  assert.match(
    formalSource,
    /enabledBranches[\s\S]{0,500}?ENABLED Mutant_/u,
    'formal invariant mutation batches must prove every generated branch is enabled',
  );
  assert.match(
    formalSource,
    /INVARIANT MutationBranchesEnabled/u,
    'formal mutation witness configs must check per-branch enabledness',
  );
  for (const [name, sourceNeedle] of [
    [
      'runtime',
      'RuntimeNegativeSampleMutantsRejected == /\\\\ ~InvalidSampleCheck!RuntimeSamplesConform /\\\\ ~BadRunnerCheck!RuntimeSamplesConform /\\\\ ~BadReadCheck!RuntimeSamplesConform',
    ],
    [
      'read-history',
      'ReadHistoryNegativeSampleMutantRejected == ~InvalidSampleCheck!ReadHistorySamplesConform',
    ],
    [
      'local-runner',
      'LocalRunnerNegativeSampleMutantRejected == ~InvalidSampleCheck!LocalRunnerSamplesConform',
    ],
    ['policy', 'PolicyNegativeSampleMutantRejected == ~InvalidSampleCheck!PolicySamplesConform'],
    ['outbox', 'OutboxNegativeSampleMutantRejected == ~OutboxSamplesConformFor(BadSamples)'],
    [
      'external',
      'ExternalNegativeSampleMutantRejected == ~InvalidSampleCheck!ExternalSamplesConform',
    ],
  ])
    assert.ok(
      formalSource.includes(sourceNeedle),
      `${name} bad-sample mutations must remain in the observed-model TLC traversal`,
    );
  assert.match(
    formalSource,
    /runReachableMutationWitnessBatch\(\{[\s\S]{0,180}?WorkOnceOutboxReachableMutationBatch/u,
    'outbox reachable semantic mutants must share one base-state traversal',
  );
  assert.doesNotMatch(
    formalSource,
    /WorkOnce(?:RuntimeSamplesMutant|RuntimeRunnerFailureMutant|RuntimeReadFenceMutant|ReadHistorySamplesMutant|LocalRunnerSamplesMutant|PolicySamplesMutant|OutboxSamplesMutant|ExternalSamplesMutant)\.tla/u,
    'formal bad-sample witnesses regressed to one JVM per sample mutation',
  );
  const lifecycleFormalSource = read('scripts/lifecycle-formal.mjs');
  assert.ok(
    lifecycleFormalSource.includes(
      'LifecycleNegativeSampleMutantsRejected == /\\\\ ~LifecycleSamplesConform(BadSamples) /\\\\ ~LifecycleSamplesConform(BadFieldSamples)',
    ),
    'lifecycle bad-sample witnesses must share the observed-model TLC traversal',
  );
  assert.doesNotMatch(
    lifecycleFormalSource,
    /WorkOnceLifecycleSamples(?:FalseField)?Mutant\.tla/u,
    'lifecycle bad-sample witnesses regressed to one JVM per mutation',
  );
  for (const [kind, mutantName] of [
    ['claimScanContinuation', 'ClaimScanContinuationMissingAdapterSamples'],
    ['stolenPageContinuation', 'StolenPageContinuationMissingAdapterSamples'],
    ['claimLimit', 'ClaimLimitMissingAdapterSamples'],
    ['finiteClaimDrain', 'FiniteClaimDrainMissingAdapterSamples'],
  ]) {
    assert.match(
      lifecycleFormalSource,
      new RegExp(`\\['${kind}', '${mutantName}'\\]`, 'u'),
      `lifecycle adapter-domain mutation set must cover ${kind}`,
    );
  }
  assert.ok(
    lifecycleFormalSource.includes('~LifecycleSamplesConform(${name})'),
    'lifecycle adapter-domain mutant table must feed the shared rejection invariant',
  );
  assert.match(
    lifecycleFormalSource,
    /INVARIANT LifecycleAdapterDomainMutantsRejected/u,
    'lifecycle observed-model config must execute adapter-domain nonvacuity mutants',
  );
  assert.match(
    formalSource,
    /if \(!specSwapped\)\s*throw new Error\('Mutation witness config found no SPECIFICATION Spec line to rebind'\)/u,
    'formal mutation witness config must fail closed when SPECIFICATION Spec is absent',
  );
  const storageFormalSource = read('scripts/storage-formal.mjs');
  assert.ok(
    storageFormalSource.includes(
      'StorageNegativeSampleMutantsRejected == /\\\\ ~InvalidSampleCheck!StorageSamplesConform /\\\\ ~DuplicateSlotCheck!StorageSamplesConform',
    ),
    'storage bad-sample witnesses must share the observed-model TLC traversal',
  );
  assert.doesNotMatch(
    storageFormalSource,
    /WorkOnceStorageMutant_(?:StorageSamplesConform|DuplicateSlotsConform)\.tla/u,
    'storage bad-sample witnesses regressed to one JVM per mutation',
  );
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
  const lifecycleRefinementSource = read('scripts/lifecycle-refinement.mjs');
  assert.match(
    lifecycleRefinementSource,
    /const lifecycleAdapters = \['memory', 'sqlite', 'cas'\];/u,
    'lifecycle adapter equivalence must have one authoritative adapter-domain array',
  );
  assert.doesNotMatch(
    lifecycleRefinementSource,
    /adapters:\s*'memory,sqlite,cas'/u,
    'lifecycle adapter evidence label must derive from the adapter loop rather than a duplicate literal',
  );
  assert.ok(
    (lifecycleRefinementSource.match(/adapters:\s*lifecycleAdapters\.join\(','\)/gu) ?? [])
      .length >= 2,
    'both lifecycle adapter-equivalence samples must derive their evidence label from the iterated adapter array',
  );
  const refinementSqliteFixture = read('scripts/refinement-sqlite-fixture.mjs');
  assert.match(
    refinementSqliteFixture,
    /catch \(error\) \{[\s\S]{0,180}?rmSync\(directory,[\s\S]{0,100}?throw error/u,
    'shared SQLite refinement fixture must remove its directory when store construction fails',
  );
  assert.match(
    refinementSqliteFixture,
    /try \{[\s\S]{0,100}?store\.close\(\);[\s\S]{0,100}?finally \{[\s\S]{0,100}?rmSync\(directory/u,
    'shared SQLite refinement fixture must remove its directory even when store close fails',
  );
  for (const provenanceSource of [
    read('scripts/check-formal-implementation-conformance.mjs'),
    read('scripts/check-bounded-trace-domain.mjs'),
    read('scripts/check-lifecycle-proof-binding.mjs'),
  ])
    assert.match(
      provenanceSource,
      /'scripts\/refinement-sqlite-fixture\.mjs'/u,
      'shared SQLite refinement fixture must be content-bound by assurance provenance',
    );

  const policyRefinementSource = read('scripts/policy-refinement.mjs');
  assert.match(
    policyRefinementSource,
    /finally \{\s*release\.resolve\(\);\s*if \(pending\) await observe\(pending\);\s*fixture\.close\(\);/u,
    'policy async-race cleanup must settle the pending promise before fixture close',
  );
  const policyRefinementTest = read('test/policy-refinement.test.mjs');
  assert.match(
    policyRefinementTest,
    /const policyRefinementSamplesPromise = runPolicyRefinementSamples\(\);\s*void policyRefinementSamplesPromise\.catch\(\(\) => \{\}\);/u,
    'shared policy refinement sample promise must attach an immediate rejection observer',
  );

  const conformance = read('scripts/check-formal-implementation-conformance.mjs');
  assert.match(
    conformance,
    /'test\/internal-semantic-surface\.test\.mjs'/u,
    'assurance infrastructure digest must hash the internal semantic surface regression test',
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
  assert.match(
    outboxRefinement,
    /finally \{\s*release\(\);\s*try \{\s*await delayed;\s*\} catch \(error\) \{\s*staleError = error;\s*\}\s*\}/u,
    'outbox stale-parent refinement must release its held acknowledgement and drain delayed work in finally',
  );
  assert.match(
    sqliteBusyChild,
    /db\.exec\('COMMIT'\);[\s\S]{0,160}?process\.send\(\{ unlocking: true, unlockingAt: Date\.now\(\) \}, finishUnlock\)/u,
    'SQLite busy lock-release witness must publish only after COMMIT completes',
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
  function resolvedMutationWriteTargets(source, name) {
    const sourceFile = ts.createSourceFile(
      name,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const declarations = new Map();
    const domains = new Map();
    const functions = new Map();
    const calls = [];
    const aliasDeclarations = [];
    const mutations = [];
    const mutationGuardBindings = new Set();
    let guardedMutations = 0;
    const promiseMutationImports = new Map();
    const promiseMutationNamespaces = new Set();
    const directMutationImports = new Map();
    const mutationAliases = new Map();
    const objectMutationAliases = new Map();
    const fsNamespaces = new Set();
    const directMutationPathArguments = new Map([
      ['writeFileSync', [0]],
      ['appendFileSync', [0]],
      ['copyFileSync', [1]],
      ['cpSync', [1]],
      ['renameSync', [0, 1]],
      ['rmSync', [0]],
      ['unlinkSync', [0]],
      ['truncateSync', [0]],
      ['writeSync', [0]],
    ]);
    const promiseMutationPathArguments = new Map([
      ['writeFile', [0]],
      ['appendFile', [0]],
      ['copyFile', [1]],
      ['cp', [1]],
      ['rename', [0, 1]],
      ['rm', [0]],
      ['unlink', [0]],
      ['truncate', [0]],
    ]);
    const staticMemberNames = (expression) => {
      if (ts.isPropertyAccessExpression(expression)) return [expression.name.text];
      if (!ts.isElementAccessExpression(expression) || !expression.argumentExpression) return [];
      return resolve(expression.argumentExpression);
    };
    const memberMutationIndexes = (expression) => {
      if (!(ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)))
        return [];
      const names = staticMemberNames(expression);
      const base = expression.expression;
      const objectAlias = ts.isIdentifier(base) ? objectMutationAliases.get(base.text) : undefined;
      const mutationNamespace =
        isFsNamespaceExpression(base) ||
        isPromiseNamespaceExpression(base) ||
        objectAlias !== undefined;
      if (ts.isElementAccessExpression(expression) && mutationNamespace && names.length !== 1)
        assert.fail(
          `${name} mutation callee cannot be statically resolved before generated-only classification`,
        );
      if (names.length !== 1) return [];
      const [member] = names;
      if (isFsNamespaceExpression(base)) return directMutationPathArguments.get(member) ?? [];
      if (isPromiseNamespaceExpression(base)) return promiseMutationPathArguments.get(member) ?? [];
      const objectIndexes = objectAlias?.get(member);
      if (objectIndexes) return objectIndexes;
      return directMutationPathArguments.get(member) ?? [];
    };
    function mutationTargetIndexes(call) {
      const expression = call.expression;
      if (ts.isIdentifier(expression)) {
        const alias = mutationAliases.get(expression.text);
        if (alias) return alias;
        const direct = directMutationPathArguments.get(expression.text);
        if (direct) return direct;
        const directImported = directMutationImports.get(expression.text);
        if (directImported) return directMutationPathArguments.get(directImported) ?? [];
        const imported = promiseMutationImports.get(expression.text);
        return imported ? (promiseMutationPathArguments.get(imported) ?? []) : [];
      }
      if (!(ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)))
        return [];
      const names = staticMemberNames(expression);
      if (
        ts.isIdentifier(expression.expression) &&
        mutationGuardBindings.has(expression.expression.text) &&
        names.length === 1 &&
        (names[0] === 'writeFileSync' || names[0] === 'appendFileSync')
      ) {
        guardedMutations++;
        return [];
      }
      return memberMutationIndexes(expression);
    }
    const add = (map, key, value) => {
      const values = map.get(key) ?? [];
      values.push(value);
      map.set(key, values);
    };
    const isFsNamespaceExpression = (expression) =>
      ts.isIdentifier(expression) && fsNamespaces.has(expression.text);
    const isPromiseNamespaceExpression = (expression) =>
      (ts.isIdentifier(expression) && promiseMutationNamespaces.has(expression.text)) ||
      (ts.isPropertyAccessExpression(expression) &&
        expression.name.text === 'promises' &&
        isFsNamespaceExpression(expression.expression));
    const aliasedMutationIndexes = (expression) => {
      if (ts.isIdentifier(expression)) {
        const alias = mutationAliases.get(expression.text);
        if (alias) return alias;
        const direct = directMutationPathArguments.get(expression.text);
        if (direct) return direct;
        const directImported = directMutationImports.get(expression.text);
        if (directImported) return directMutationPathArguments.get(directImported) ?? [];
        const promiseImported = promiseMutationImports.get(expression.text);
        return promiseImported ? (promiseMutationPathArguments.get(promiseImported) ?? []) : [];
      }
      return memberMutationIndexes(expression);
    };
    const objectPropertyNames = (nameNode) => {
      if (ts.isComputedPropertyName(nameNode)) return resolve(nameNode.expression);
      const name = propertyNameText(nameNode);
      return name === undefined ? [] : [name];
    };
    function discover(node) {
      if (ts.isVariableDeclaration(node) && node.initializer) aliasDeclarations.push(node);
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteralLike(node.moduleSpecifier) &&
        node.importClause
      ) {
        const clause = node.importClause;
        if (node.moduleSpecifier.text === 'node:fs/promises') {
          if (clause.name) promiseMutationNamespaces.add(clause.name.text);
          if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
            promiseMutationNamespaces.add(clause.namedBindings.name.text);
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
            for (const element of clause.namedBindings.elements) {
              const imported = element.propertyName?.text ?? element.name.text;
              if (promiseMutationPathArguments.has(imported))
                promiseMutationImports.set(element.name.text, imported);
            }
        }
        if (node.moduleSpecifier.text === 'node:fs') {
          if (clause.name) fsNamespaces.add(clause.name.text);
          if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
            fsNamespaces.add(clause.namedBindings.name.text);
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
            for (const element of clause.namedBindings.elements) {
              const imported = element.propertyName?.text ?? element.name.text;
              if (imported === 'promises') promiseMutationNamespaces.add(element.name.text);
              else if (directMutationPathArguments.has(imported))
                directMutationImports.set(element.name.text, imported);
            }
        }
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        add(declarations, node.name.text, node.initializer);
        if (
          ts.isCallExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === 'createMutationFileGuard'
        )
          mutationGuardBindings.add(node.name.text);
        if (isPromiseNamespaceExpression(node.initializer))
          promiseMutationNamespaces.add(node.name.text);
        const aliasIndexes = aliasedMutationIndexes(node.initializer);
        if (aliasIndexes.length > 0) mutationAliases.set(node.name.text, aliasIndexes);
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer
      ) {
        const directSource = isFsNamespaceExpression(node.initializer);
        const promiseSource = isPromiseNamespaceExpression(node.initializer);
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const imported = element.propertyName?.getText(sourceFile) ?? element.name.text;
          if (directSource && imported === 'promises') {
            promiseMutationNamespaces.add(element.name.text);
            continue;
          }
          const indexes = directSource
            ? directMutationPathArguments.get(imported)
            : promiseSource
              ? promiseMutationPathArguments.get(imported)
              : undefined;
          if (indexes) mutationAliases.set(element.name.text, indexes);
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
      if (ts.isForOfStatement(node)) {
        const [declaration] = node.initializer.declarations ?? [];
        if (declaration && ts.isIdentifier(declaration.name))
          add(domains, declaration.name.text, node.expression);
        else if (declaration && ts.isArrayBindingPattern(declaration.name))
          declaration.name.elements.forEach((element, index) => {
            if (ts.isBindingElement(element) && ts.isIdentifier(element.name))
              add(domains, element.name.text, { iterable: node.expression, index });
          });
      }
      if (ts.isCallExpression(node)) calls.push(node);
      ts.forEachChild(node, discover);
    }
    discover(sourceFile);
    function resolveMutationAlias(declaration) {
      let changed = false;
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        if (
          isPromiseNamespaceExpression(declaration.initializer) &&
          !promiseMutationNamespaces.has(declaration.name.text)
        ) {
          promiseMutationNamespaces.add(declaration.name.text);
          changed = true;
        }
        const aliasIndexes = aliasedMutationIndexes(declaration.initializer);
        if (aliasIndexes.length > 0 && !mutationAliases.has(declaration.name.text)) {
          mutationAliases.set(declaration.name.text, aliasIndexes);
          changed = true;
        }
        let objectAlias;
        if (ts.isObjectLiteralExpression(declaration.initializer)) {
          objectAlias = new Map();
          for (const property of declaration.initializer.properties) {
            let indexes = [];
            let propertyNames = [];
            if (ts.isPropertyAssignment(property)) {
              propertyNames = objectPropertyNames(property.name);
              indexes = aliasedMutationIndexes(property.initializer);
            } else if (ts.isShorthandPropertyAssignment(property)) {
              propertyNames = [property.name.text];
              indexes = aliasedMutationIndexes(property.name);
            }
            if (indexes.length > 0)
              for (const propertyName of propertyNames) objectAlias.set(propertyName, indexes);
          }
        } else if (ts.isIdentifier(declaration.initializer)) {
          objectAlias = objectMutationAliases.get(declaration.initializer.text);
        }
        if (objectAlias?.size && !objectMutationAliases.has(declaration.name.text)) {
          objectMutationAliases.set(declaration.name.text, new Map(objectAlias));
          changed = true;
        }
      }
      if (ts.isObjectBindingPattern(declaration.name) && declaration.initializer) {
        const directSource = isFsNamespaceExpression(declaration.initializer);
        const promiseSource = isPromiseNamespaceExpression(declaration.initializer);
        for (const element of declaration.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const imported = element.propertyName?.getText(sourceFile) ?? element.name.text;
          if (
            directSource &&
            imported === 'promises' &&
            !promiseMutationNamespaces.has(element.name.text)
          ) {
            promiseMutationNamespaces.add(element.name.text);
            changed = true;
            continue;
          }
          const indexes = directSource
            ? directMutationPathArguments.get(imported)
            : promiseSource
              ? promiseMutationPathArguments.get(imported)
              : undefined;
          if (indexes && !mutationAliases.has(element.name.text)) {
            mutationAliases.set(element.name.text, indexes);
            changed = true;
          }
        }
      }
      return changed;
    }
    let aliasesChanged;
    do {
      aliasesChanged = false;
      for (const declaration of aliasDeclarations)
        if (resolveMutationAlias(declaration)) aliasesChanged = true;
    } while (aliasesChanged);
    for (const call of calls)
      for (const targetIndex of mutationTargetIndexes(call)) mutations.push({ call, targetIndex });
    for (const call of calls) {
      if (!ts.isIdentifier(call.expression)) continue;
      const fn = functions.get(call.expression.text);
      if (!fn) continue;
      fn.parameters.forEach((parameter, index) => {
        if (ts.isIdentifier(parameter.name) && call.arguments[index])
          add(domains, parameter.name.text, call.arguments[index]);
      });
    }
    function iterableElements(expression, index, seen) {
      if (ts.isIdentifier(expression)) {
        const initializers = declarations.get(expression.text) ?? [];
        return initializers.flatMap((initializer) => iterableElements(initializer, index, seen));
      }
      if (ts.isNewExpression(expression) && expression.expression.getText(sourceFile) === 'Map') {
        const [entries] = expression.arguments ?? [];
        return entries ? iterableElements(entries, index, seen) : [];
      }
      if (!ts.isArrayLiteralExpression(expression)) return [];
      const result = [];
      for (const element of expression.elements) {
        if (ts.isArrayLiteralExpression(element) && element.elements[index])
          result.push(element.elements[index]);
        else if (index === 0) result.push(element);
      }
      return result;
    }
    function resolve(expression, seen = new Set()) {
      if (ts.isStringLiteralLike(expression)) return [expression.text];
      if (ts.isTemplateExpression(expression)) {
        let value = expression.head.text;
        for (const span of expression.templateSpans) {
          if (
            !(
              ts.isPropertyAccessExpression(span.expression) &&
              span.expression.expression.getText(sourceFile) === 'process' &&
              span.expression.name.text === 'pid'
            )
          )
            return [];
          value += '__PID__' + span.literal.text;
        }
        return [value];
      }
      if (ts.isIdentifier(expression)) {
        if (expression.text === 'root') return [''];
        if (seen.has(expression.text)) return [];
        const nextSeen = new Set(seen).add(expression.text);
        const values = [];
        for (const domain of domains.get(expression.text) ?? []) {
          if (domain?.iterable)
            for (const candidate of iterableElements(domain.iterable, domain.index, nextSeen))
              values.push(...resolve(candidate, nextSeen));
          else if (ts.isArrayLiteralExpression(domain))
            for (const candidate of domain.elements) values.push(...resolve(candidate, nextSeen));
          else values.push(...resolve(domain, nextSeen));
        }
        for (const initializer of declarations.get(expression.text) ?? [])
          values.push(...resolve(initializer, nextSeen));
        return [...new Set(values)];
      }
      if (
        ts.isCallExpression(expression) &&
        ts.isPropertyAccessExpression(expression.expression) &&
        expression.expression.expression.getText(sourceFile) === 'path' &&
        expression.expression.name.text === 'join'
      ) {
        let paths = [''];
        for (const argument of expression.arguments) {
          const segments = resolve(argument, seen);
          if (segments.length === 0) return [];
          paths = paths.flatMap((base) =>
            segments.map((segment) => path.posix.join(base, segment)),
          );
        }
        return paths;
      }
      return [];
    }
    if (mutations.length + guardedMutations === 0) return null;
    const targets = [];
    for (const mutation of mutations) {
      const target = mutation.call.arguments[mutation.targetIndex];
      const resolved = target ? resolve(target) : [];
      assert.ok(
        resolved.length > 0,
        `${name} mutation target cannot be statically resolved before generated-only classification`,
      );
      targets.push(...resolved);
    }
    return [...new Set(targets)];
  }
  for (const name of mutationFiles) {
    const source = read(`scripts/${name}`);
    const resolvedTargets = resolvedMutationWriteTargets(source, name);
    if (resolvedTargets === null) continue;
    const generatedOnly = resolvedTargets.every((target) =>
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
    'live TLC probe must preserve the shared fail-closed process classifier',
  );
  assert.match(liveTlcProbe, /timeout:\s*15_000/u);

  const formalConformance = read('scripts/check-formal-implementation-conformance.mjs');
  assert.match(
    formalConformance,
    /requireSuccessfulProcess\(result, 'formal implementation surface extractor'\)/u,
    'formal implementation extractor must preserve the shared successful-process classifier',
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
  assert.match(
    lifecycleFormal,
    /const outcome = classifyTlcOutcome\(result\);[\s\S]{0,220}?if \(outcome\.kind !== 'success'\)/u,
    'lifecycle formal runModel must fail closed on every non-success TLC outcome',
  );
  assert.doesNotMatch(
    lifecycleFormal,
    /function requireInvariantRejects\(/u,
    'lifecycle formal must not retain an unreachable invariant-rejection helper as assurance evidence',
  );
  assert.doesNotMatch(lifecycleFormal, /const semanticFailure\s*=/u);
  assert.match(
    lifecycleFormal,
    /let specSwapped = false/u,
    'lifecycle TLC mutation witness must initialize specSwapped to false',
  );
  assert.match(lifecycleFormal, /specSwapped = true/u);
  assert.match(lifecycleFormal, /if \(!specSwapped\)[\s\S]{0,160}?SPECIFICATION Spec/u);
  assert.match(
    lifecycleFormal,
    /enabledBranches[\s\S]{0,500}?ENABLED Mutant_/u,
    'lifecycle formal mutation batches must prove every generated branch is enabled',
  );
  assert.match(
    lifecycleFormal,
    /INVARIANT MutationBranchesEnabled/u,
    'lifecycle formal mutation witness configs must check per-branch enabledness',
  );

  const workOnceContract = read('formal/WorkOnceContract.tla');
  assert.match(
    workOnceContract,
    /s\.kind = "runDispatcher" ->[\s\S]{0,260}?s\.observedWithinDeadline/u,
    'formal outbox runDispatcher contract must require observedWithinDeadline',
  );

  const storageFormal = read('scripts/storage-formal.mjs');
  assert.match(storageFormal, /classifyTlcOutcome/u);
  assert.match(storageFormal, /requireExpectedInvariantViolation\(result, invariant\)/u);
  assert.doesNotMatch(storageFormal, /const rejectedForInvariant\s*=/u);

  const storageRefinement = read('scripts/storage-refinement.mjs');
  assert.doesNotMatch(
    storageRefinement,
    /oneAccepted\s*:\s*true/u,
    'storage refinement oneAccepted witness must be observation-derived',
  );
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
  assert.match(
    drainSample,
    /for \(; passes < maxPasses; passes\+\+\)/u,
    'finite claim-drain witness must remain explicitly bounded by maxPasses',
  );
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
  assert.match(
    leaseSample,
    /if \(claimDelayMs > 0\) await sleep\(claimDelayMs\)/u,
    'external one-tick lease witness must preserve deterministic claimDelayMs injection',
  );
  assert.match(leaseSample, /delayedOneTick = await one\([\s\S]*?,\s*5,\s*\)/u);
  assert.match(leaseSample, /oneTickHeartbeatCompatible/u);
  assert.match(leaseSample, /Confirmed external lease deadline passed/u);
  assert.match(leaseSample, /delayedOneTick\.heartbeatCalls === 0/u);
  const externalModel = read('formal/WorkOnceExternal.tla');
  assert.match(
    externalModel,
    /s\.oneTickHeartbeatCompatible/u,
    'external TLA contract must require oneTickHeartbeatCompatible',
  );
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
  assert.match(
    ackSample,
    /return \{ observedAt: 100, leaseUntil: 100 \+ ackHistoryLeaseMs \}/u,
    'unknown-ACK history sample must preserve the explicit reviewed lease duration',
  );
  assert.doesNotMatch(ackSample, /heartbeat: service\.heartbeat/u);

  const processTest = read('test/process/local-runner-process.test.mjs');
  const messageHelper = boundedSection(
    processTest,
    'function start(path, mode, now)',
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
  assert.match(
    multiFixture,
    /observing\.queue\.inspectMany\(\['0', '1', '2'\]\)/u,
    'multi-active crash fixture must observe durable WorkOnce state before SIGKILL',
  );
  assert.match(multiFixture, /snapshot\?\.phase\.state === 'running'/u);
  assert.match(multiFixture, /snapshots\.map\(\(snapshot\) => snapshot\.phase\.attempt\)/u);
  assert.doesNotMatch(multiFixture, /nextMessage\(child\)/u);
  assert.doesNotMatch(multiFixture, /sleep\(2050\)/u);
  assert.match(
    multiFixture,
    /expiredAt = Math\.max\(\.\.\.snapshots\.map\(\(snapshot\) => snapshot\.phase\.attempt\.leaseUntil\)\) \+ 1/u,
    'multi-active crash fixture must derive expiry from the durable post-kill lease deadline',
  );
  assert.match(
    multiFixture,
    /reopen\(path, 2000, expiredAt\)/u,
    'multi-active crash fixture must reclaim using a clock beyond the durable lease deadline',
  );
  const processChild = read('test/process/local-runner-child.mjs');
  assert.match(
    processChild,
    /mode === 'multi-active' \? 2000 : 200/u,
    'multi-active crash child must keep the 2000ms synchronization lease',
  );
  assert.match(
    processChild,
    /now: \(\) => logicalNow/u,
    'heartbeat crash child must use the parent-supplied logical storage clock',
  );
  assert.match(
    processChild,
    /if \(claimed\) logicalNow \+= 1/u,
    'heartbeat crash child must advance logical storage time after the initial claim',
  );
  assert.match(
    processTest,
    /seed\(path, 1, 200, logicalNow\)[\s\S]{0,160}?start\(path, 'heartbeat-ack', logicalNow\)/u,
    'heartbeat crash parent must seed and start the child on one shared logical storage clock',
  );

  const killHelper = boundedSection(
    processTest,
    'async function kill(child)',
    '\nasync function ',
    'local-runner kill helper',
  );
  assert.match(killHelper, /child\.exitCode !== null \|\| child\.signalCode !== null/u);
  assert.match(killHelper, /AbortSignal\.timeout\(15000\)/u);
  assert.match(killHelper, /assert\.equal\(signal, 'SIGKILL'\)/u);

  const externalEffectProcess = read('test/process/external-effect-process.test.mjs');
  assert.match(
    externalEffectProcess,
    /const childMessageTimeoutMs = 15_000;[\s\S]{0,80}?const fixtureLeaseMs = childMessageTimeoutMs \* 2;/u,
    'external-effect crash fixture lease must be derived to outlive its IPC liveness ceiling',
  );
  assert.match(
    externalEffectProcess,
    /\[dbPath, effectPath, mode, String\(fixtureLeaseMs\)\]/u,
    'external-effect crash child must receive the same derived fixture lease',
  );
  assert.match(
    externalEffectProcess,
    /expiredAt = running\.phase\.attempt\.leaseUntil \+ 1/u,
    'external-effect crash reclaim must derive expiry from the durable lease deadline',
  );
  assert.doesNotMatch(
    externalEffectProcess,
    /(?:await )?sleep\(/u,
    'external-effect crash fixture must not use scheduler sleeps to prove lease expiry',
  );

  const policyProcess = read('test/process/policy-process.test.mjs');
  assert.match(
    policyProcess,
    /const childMessageTimeoutMs = 15_000;[\s\S]{0,80}?const fixtureLeaseMs = childMessageTimeoutMs \* 2;/u,
    'policy crash fixture lease must be derived to outlive its IPC liveness ceiling',
  );
  assert.match(
    policyProcess,
    /\[path, mode, outcomeKind, String\(fixtureLeaseMs\), String\(fixtureMaxElapsedMs\)\]/u,
    'policy crash child must receive the same derived lease and elapsed budget',
  );
  assert.match(
    policyProcess,
    /expiredAt = before\.phase\.attempt\.leaseUntil \+ 1/u,
    'policy crash reclaim must derive expiry from the durable lease deadline',
  );
  assert.match(
    policyProcess,
    /reopen\(path, expiredAt\)/u,
    'policy crash fixture must reclaim using a logical clock beyond durable lease expiry',
  );
  assert.doesNotMatch(
    policyProcess,
    /(?:await )?sleep\(/u,
    'policy crash fixture must not use scheduler sleeps to prove lease expiry',
  );
  const policyChild = read('test/process/policy-child.mjs');
  assert.match(
    policyChild,
    /const \[path, mode, outcomeKind, leaseMsArg, maxElapsedMsArg\] = process\.argv\.slice\(2\)/u,
    'policy crash child must use parent-provided timing bounds',
  );
  assert.doesNotMatch(
    policyChild,
    /leaseMs:\s*250|const limits = \{ leaseMs:\s*250/u,
    'policy crash child must not restore a scheduler-sensitive fixed lease',
  );

  const assuranceRunner = read('scripts/run-assurance.mjs');
  assert.match(assuranceRunner, /requireSuccessfulProcess\(result, label\)/u);
  assert.match(assuranceRunner, /function terminateProcessTree\(child\)/u);
  assert.match(
    assuranceRunner,
    /result\.status !== 0 && result\.status !== 128/u,
    'Windows assurance containment must reject taskkill failures other than missing processes',
  );
  assert.match(
    assuranceRunner,
    /detached: process\.platform !== 'win32'/u,
    'parallel assurance children must be isolatable as complete process trees',
  );
  assert.match(
    assuranceRunner,
    /process\.kill\(-pid, 'SIGKILL'\)/u,
    'parallel assurance failure must terminate POSIX descendant process groups, not only direct children',
  );
  assert.match(
    assuranceRunner,
    /const outcomes = await Promise\.allSettled\(/u,
    'parallel assurance failure must wait for all direct children to settle before returning',
  );
  assert.match(
    assuranceRunner,
    /terminateAllProcessTrees\(\)/u,
    'parallel assurance failure no longer terminates every active child tree',
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
