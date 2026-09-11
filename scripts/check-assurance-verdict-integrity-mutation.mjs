import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAssuranceVerdictIntegrity } from './check-assurance-verdict-integrity.mjs';

import { createMutationFileGuard } from './mutation-file-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutationFiles = createMutationFileGuard();
function mutate(relative, from, to, label, pattern) {
  const target = path.join(root, relative);
  const original = fs.readFileSync(target, 'utf8');
  assert.equal(original.split(from).length, 2, `${label} mutation anchor is stale or not unique`);
  try {
    mutationFiles.writeFileSync(target, original.replace(from, to));
    let failure;
    try {
      assertAssuranceVerdictIntegrity();
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, `${label} unexpectedly passed`);
    assert.match(
      `${failure.name}: ${failure.message}`,
      pattern,
      `${label} failed for an unrelated reason`,
    );
  } finally {
    mutationFiles.restoreAll();
  }
}

mutate(
  'scripts/check-bounded-trace-domain.mjs',
  "  'formal/WorkOnceRuntime.tla',",
  "  'formal/WorkOnceRuntime-omitted.tla',",
  'bounded evidence drops runtime TLA model provenance',
  /bounded-domain evidence must hash the runtime TLA model consumed by runtime boundary proof/u,
);
mutate(
  'scripts/check-bounded-trace-domain.mjs',
  "  'formal/WorkOnceRuntime.cfg',",
  "  'formal/WorkOnceRuntime-omitted.cfg',",
  'bounded evidence drops runtime TLC config provenance',
  /bounded-domain evidence must hash the runtime TLC config consumed by runtime boundary proof/u,
);
mutate(
  'scripts/check-formal-implementation-conformance.mjs',
  "  'test/internal-semantic-surface.test.mjs',",
  "  'test/internal-semantic-surface-omitted.test.mjs',",
  'assurance infrastructure drops semantic-surface regression provenance',
  /assurance infrastructure digest must hash the internal semantic surface regression test/u,
);

mutate(
  'scripts/check-bounded-trace-domain.mjs',
  "  'scripts/mutation-file-guard.mjs',",
  "  'scripts/mutation-file-guard-omitted.mjs',",
  'bounded evidence drops mutation file guard provenance',
  /bounded-domain evidence must hash the mutation file guard used by mutation witnesses/u,
);
mutate(
  'scripts/check-bounded-trace-domain.mjs',
  'if (Object.keys(current.domain).length === 0)',
  'if (false && Object.keys(current.domain).length === 0)',
  'bounded domain accepts zero reviewed dimensions',
  /bounded-domain report must fail closed when the corpus reports zero dimensions/u,
);

mutate(
  'scripts/check-external-source-model-mutation.mjs',
  "requireSuccessfulProcess(bindingCheck(), 'baseline external source/model binding');",
  'void bindingCheck;',
  'external source/model mutation guard loses its green-before baseline',
  /external source\/model mutation guard must prove a green baseline before creating mutants/u,
);
mutate(
  'scripts/check-tlc-outcome-classification.mjs',
  "const invalidJar = path.join(artifactDir, 'invalid-tlc-classification.jar');",
  "const invalidJar = path.join(root, 'src/work.ts');",
  'live TLC classifier writes outside generated artifact roots',
  /check-tlc-outcome-classification\.mjs mutates tracked source\/config without signal-safe file restoration/u,
);

mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  "for (const relative of ['dist/index.js', 'dist-cjs/index.js', 'dist/index.d.ts']) {",
  "for (const relative of ['dist/index.js', 'dist-cjs/index.js', 'dist/index.d.ts', 'src/worker.ts']) {",
  'generated-only mutation scope hides a tracked dynamic path target',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  '  fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);',
  "  const writeFileSync = fs.writeFileSync; writeFileSync(path.join(root, 'src/worker.ts'), originalStamp); fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);",
  'bare write call hides a tracked source target beside a generated write',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  '  fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);',
  "  fs.writeFile(path.join(root, 'src/worker.ts'), originalStamp, () => {}); fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);",
  'callback fs write hides a tracked source target beside a generated write',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  "import fs from 'node:fs';",
  "import fs from 'node:fs';\nimport { writeFile as callbackWrite } from 'node:fs';\ncallbackWrite('src/worker.ts', 'scope-audit-probe', () => {});",
  'named callback fs write hides a tracked source target',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  '  fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);',
  "  fs.createWriteStream(path.join(root, 'src/worker.ts')); fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);",
  'write stream acquisition hides a tracked source mutation target',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  '  fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);',
  "  void fs.promises.open(path.join(root, 'src/kernel.ts'), 'w'); fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);",
  'writable file-handle acquisition hides a tracked source mutation target',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  '  fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);',
  "  const flags = process.env.WORKONCE_MUTATION_OPEN_FLAGS; void fs.promises.open(path.join(root, '.artifacts/probe'), flags); fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);",
  'dynamic file-handle flags bypass fail-closed mutation classification',
  /fs open flags cannot be statically resolved before generated-only classification/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  '  fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);',
  "  delayedTrackedWrite(path.join(root, 'src/worker.ts'), originalStamp); const delayedTrackedWrite = fs.writeFileSync; fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);",
  'tracked write before its later alias declaration remains classified',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  "import fs from 'node:fs';",
  "const importedLaterWrite = fs.writeFileSync;\nimport fs from 'node:fs';\nimportedLaterWrite('src/worker.ts', 'scope-audit-probe');",
  'tracked write through an alias declared before its static fs import remains classified',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  '  fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);',
  "  const { writeFile: renamedTrackedWrite } = fs.promises; renamedTrackedWrite(path.join(root, 'src/worker.ts'), originalStamp); fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);",
  'renamed destructured promise write hides a tracked source target beside a generated write',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  '  fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);',
  "  fs.copyFileSync(stampPath, path.join(root, 'src/worker.ts')); fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);",
  'copyFileSync destination hides a tracked mutation target',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  '  fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);',
  "  fs.renameSync(stampPath, path.join(root, 'src/worker.ts')); fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);",
  'renameSync destination hides a tracked mutation target',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  '  fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);',
  "  fs.rmSync(path.join(root, 'src/worker.ts')); fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);",
  'rmSync hides a tracked mutation target',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  '  fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);',
  '  fs.writeSync(1, originalStamp); fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);',
  'writeSync file descriptor cannot be proven generated-only',
  /mutation target cannot be statically resolved/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  '  fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);',
  "  fs.promises.writeFile(path.join(root, 'src/worker.ts'), originalStamp); fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);",
  'fs.promises.writeFile hides a tracked mutation target',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  "import fs from 'node:fs';",
  "import fs from 'node:fs';\nimport { writeFile as promiseWriteFile } from 'node:fs/promises';\npromiseWriteFile('src/worker.ts', 'scope-audit-probe');",
  'destructured fs promises target is classified',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  "import fs from 'node:fs';",
  "import fs from 'node:fs';\nimport { promises as renamedPromises } from 'node:fs';\nrenamedPromises.writeFile('src/worker.ts', 'scope-audit-probe');",
  'renamed node:fs promises namespace target is classified',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  "import fs from 'node:fs';",
  "import fs from 'node:fs';\nimport fsp from 'node:fs/promises';\nfsp.writeFile('src/worker.ts', 'scope-audit-probe');",
  'default node:fs/promises target is classified',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  "import fs from 'node:fs';",
  "import fs from 'node:fs';\nimport * as fsp from 'node:fs/promises';\nfsp.writeFile('src/worker.ts', 'scope-audit-probe');",
  'namespace node:fs/promises target is classified',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-local-runner-implementation-mutations.mjs',
  'requireExpectedProcessFailure(result, `${label} mutant`, pattern);',
  'assert.notEqual(result.status, 0, `${label} mutant unexpectedly passed`);',
  'bare status-null mutation kill',
  /bare child exit-status verdict/u,
);
mutate(
  'scripts/check-local-runner-implementation-mutations.mjs',
  "import { spawnSync } from 'node:child_process';",
  "import { spawn } from 'node:child_process';",
  'mutation checker bypasses bounded spawnSync controls',
  /must (?:import|use) spawnSync/u,
);
mutate(
  'scripts/check-local-runner-implementation-mutations.mjs',
  "import { spawnSync } from 'node:child_process';",
  "import { spawnSync } from 'node:child_process';\nimport * as childProcess from 'node:child_process';\nchildProcess.spawnSync(process.execPath, ['-e', '']);",
  'namespace spawnSync call loses its timeout bound',
  /spawnSync options must be an inline object so timeout bounds are auditable/u,
);
mutate(
  'scripts/check-local-runner-implementation-mutations.mjs',
  "import { spawnSync } from 'node:child_process';",
  "import { spawnSync } from 'node:child_process';\nconst aliasedSpawnSync = spawnSync;\naliasedSpawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });",
  'aliased spawnSync call loses its timeout bound',
  /unbounded spawnSync mutation subprocess/u,
);
mutate(
  'scripts/check-local-runner-implementation-mutations.mjs',
  "import { spawnSync } from 'node:child_process';",
  "import { spawnSync } from 'node:child_process';\nconst processTools = { run: spawnSync };\nconst { run: nestedSpawnSync } = processTools;\nnestedSpawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });",
  'object/destructured spawnSync alias loses its timeout bound',
  /unbounded spawnSync mutation subprocess/u,
);
mutate(
  'scripts/check-local-runner-implementation-mutations.mjs',
  "import { spawnSync } from 'node:child_process';",
  "import { spawn } from 'child_process';",
  'unprefixed mutation checker bypasses bounded spawnSync controls',
  /must (?:import|use) spawnSync/u,
);
mutate(
  'scripts/check-assurance-scheduling-mutation.mjs',
  '        timeout: 5_000,\n',
  '',
  'one spawnSync loses its bound while sibling timeout identifiers remain',
  /unbounded spawnSync mutation subprocess/u,
);
mutate(
  'scripts/check-alias-contract-mutation.mjs',
  'function runNode(args, timeout = 15_000) {',
  'function runNode(args, timeout = 0) {',
  'spawnSync shorthand timeout default becomes unbounded',
  /unbounded spawnSync mutation subprocess/u,
);
mutate(
  'scripts/check-alias-contract-mutation.mjs',
  '    45_000,',
  '    0,',
  'spawnSync shorthand timeout call override becomes unbounded',
  /unbounded spawnSync mutation subprocess/u,
);
mutate(
  'scripts/local-runner-refinement.mjs',
  "    await within(firstWave.promise, 'competing runners first wave');",
  '    await firstWave.promise;',
  'bare deferred refinement wait',
  /bare deferred await/u,
);
mutate(
  'scripts/check-storage-source-model-mutation.mjs',
  'const mutationFiles = createMutationFileGuard();',
  'const mutationFiles = { writeFileSync: fs.writeFileSync.bind(fs), dispose() {} };',
  'source-mutating storage guard loses termination cleanup',
  /signal-safe file restoration/u,
);
mutate(
  'scripts/check-storage-source-model-mutation.mjs',
  'const mutationFiles = createMutationFileGuard();',
  'const mutationFiles = createMutationFileGuard();\nfs.writeFileSync(target, original);',
  'guarded mutation checker hides adjacent raw tracked write',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-lifecycle-source-model-mutation.mjs',
  "import assert from 'node:assert/strict';",
  "import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nconst { writeFile: hiddenWrite } = fs.promises;\nhiddenWrite('src/worker.ts', 'selector-probe');",
  'runtime-destructured promise write alias bypasses mutation-target selection',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  '  fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);',
  "  fs['writeFileSync'](path.join(root, 'src/worker.ts'), originalStamp); fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);",
  'computed fs mutation member hides a tracked source target',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  '  fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);',
  "  const hiddenWrites = { tracked: fs.writeFileSync }; hiddenWrites.tracked(path.join(root, 'src/worker.ts'), originalStamp); fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);",
  'object-property fs mutation alias hides a tracked source target',
  /mutates tracked source\/config without signal-safe file restoration/u,
);
mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  '  fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);',
  "  fs[process.env.WORKONCE_MUTATION_METHOD](path.join(root, 'src/worker.ts'), originalStamp); fs.writeFileSync(stampPath, `${JSON.stringify(mutant, null, 2)}\\n`);",
  'dynamic fs mutation member must fail closed when unresolved',
  /mutation callee cannot be statically resolved/u,
);
mutate(
  'scripts/local-runner-refinement.mjs',
  '          await within(heartbeatAttempted.promise, `${adapter}-heartbeat storage attempt`);',
  '          await sleep(35);',
  'local heartbeat cause witness returns to scheduler-delay synchronization',
  /local runner cause-precision witnesses must synchronize on both defined and undefined heartbeat attempts/u,
);
mutate(
  'scripts/external-transport-refinement.mjs',
  "      await within(heartbeatAttempted.promise, 'external heartbeat transport attempt');",
  '      await sleep(20);',
  'external heartbeat cause witness returns to scheduler-delay synchronization',
  /external heartbeat cause-precision witness/u,
);
mutate(
  'scripts/formal-bounded-refinement-corpus.mjs',
  "    await waitUntil(() => claimCalls >= 2, 'external second claim');",
  '    while (claimCalls < 2) await new Promise((resolve) => setTimeout(resolve, 1));',
  'unbounded formal-corpus claim wait',
  /unbounded claim-count spin wait/u,
);
mutate(
  'test/lifecycle-formal.test.mjs',
  '    maxBuffer: 64 * 1024 * 1024,\n',
  '',
  'lifecycle formal wrapper loses explicit output budget',
  /lifecycle formal wrapper must bound captured TLC output explicitly/u,
);
mutate(
  'test/process/lifecycle-process.test.mjs',
  "    const exited = once(child, 'exit', { signal: AbortSignal.timeout(childExitTimeoutMs) });",
  "    const exited = once(child, 'exit');",
  'unbounded child exit wait family',
  /unbounded child exit wait/u,
);
mutate(
  'scripts/external-transport-refinement.mjs',
  '    noFatalEscape: managed !== undefined && !managed.rejected,',
  '    noFatalEscape: true,',
  'fabricated external no-fatal-escape witness',
  /fabricates a proof-result boolean/u,
);
mutate(
  'scripts/storage-refinement.mjs',
  '    oneAccepted,\n    maxSafeAccepted,',
  '    oneAccepted: true,\n    maxSafeAccepted: true,',
  'fabricated storage acceptance witness',
  /storage refinement oneAccepted witness must be observation-derived/u,
);
mutate(
  'scripts/lifecycle-formal.mjs',
  "  if (outcome.kind !== 'success') {",
  '  if (false) {',
  'active lifecycle TLC runModel accepts non-success outcomes',
  /lifecycle formal runModel must fail closed on every non-success TLC outcome/u,
);
mutate(
  'scripts/lifecycle-formal.mjs',
  '    .map(([invariant]) => String.raw`    /\\ ENABLED Mutant_${invariant}`)',
  '    .map(([invariant]) => String.raw`    /\\ TRUE`)',
  'lifecycle mutation batch loses per-branch enabledness proof',
  /lifecycle formal mutation batches must prove every generated branch is enabled/u,
);
mutate(
  'scripts/lifecycle-formal.mjs',
  "const mutationWitnessInvariants = [\n  'INVARIANT MutationWitnesses',\n  'INVARIANT MutationBranchesEnabled',\n];",
  "const mutationWitnessInvariants = [\n  'INVARIANT MutationWitnesses',\n];",
  'lifecycle mutation config drops enabledness invariant',
  /lifecycle formal mutation witness configs must check per-branch enabledness/u,
);
mutate(
  'formal/WorkOnceContract.tla',
  '       /\\ s.observedWithinDeadline\n',
  '',
  'formal outbox runDispatcher sample loses deadline witness',
  /formal outbox runDispatcher contract must require observedWithinDeadline/u,
);
mutate(
  'scripts/check-tlc-outcome-classification.mjs',
  "  requireExpectedProcessFailure(result, 'invalid TLC jar formal-assurance probe');",
  "  assert.notEqual(result.status, 0, 'invalid TLC jar unexpectedly passed formal assurance');",
  'live TLC probe bare status verdict',
  /live TLC probe must preserve the shared fail-closed process classifier/u,
);
mutate(
  'scripts/check-formal-implementation-conformance.mjs',
  "  requireSuccessfulProcess(result, 'formal implementation surface extractor');",
  "  if (result.status !== 0) throw new Error('surface extractor failed');",
  'surface extractor cause collapse',
  /formal implementation extractor must preserve the shared successful-process classifier/u,
);
mutate(
  'scripts/lifecycle-refinement.mjs',
  '        entered.resolve();\n        assert.equal(snapshot.generation, 1);',
  '        assert.equal(snapshot.generation, 1);\n        entered.resolve();',
  'assertion-before-entry race hang',
  /signals entry after assertions/u,
);
mutate(
  'scripts/lifecycle-refinement.mjs',
  '    for (; passes < maxPasses; passes++) {',
  '    for (;;) {',
  'unbounded lifecycle claim drain',
  /finite claim-drain witness must remain explicitly bounded by maxPasses/u,
);
mutate(
  'scripts/lifecycle-refinement.mjs',
  'async function finiteDrainSample',
  'async function renamedFiniteDrainSample',
  'scoped assurance section loses its start anchor',
  /finite-drain sample start anchor is missing/u,
);
mutate(
  'scripts/lifecycle-formal.mjs',
  "  ['finiteClaimDrain', 'FiniteClaimDrainMissingAdapterSamples'],\n",
  '',
  'lifecycle adapter-domain mutation set loses finite drain',
  /lifecycle adapter-domain mutation set must cover finiteClaimDrain/u,
);
mutate(
  'test/policy-refinement.test.mjs',
  'void policyRefinementSamplesPromise.catch(() => {});\n',
  '',
  'shared policy refinement promise loses rejection observer',
  /shared policy refinement sample promise must attach an immediate rejection observer/u,
);
mutate(
  'test/process/lifecycle-process.test.mjs',
  'const lifecycleLeaseMs = lifecycleHarnessWaitBudgetMs + childMessageTimeoutMs;',
  'const lifecycleLeaseMs = childMessageTimeoutMs * 2;',
  'lifecycle process lease falls inside aggregate harness wait budget',
  /lifecycle process lease must stay beyond the aggregate harness wait budget/u,
);

mutate(
  'scripts/formal.mjs',
  '  if (!Object.hasOwn(sample, field))',
  '  if (false)',
  'runtime negative observed-sample witness stops checking target-field presence',
  /runtime negative sample witnesses must prove their mutation field exists/u,
);

mutate(
  'scripts/formal.mjs',
  '  if (occurrences !== 1)',
  '  if (false)',
  'observed-sample rebinding stops failing closed',
  /observed-sample config rebinding must fail closed/u,
);
mutate(
  'scripts/lifecycle-formal.mjs',
  '  let specSwapped = false;',
  '  let specSwapped = true;',
  'mutation witness config no longer fails closed on missing specification substitution',
  /lifecycle TLC mutation witness must initialize specSwapped to false/u,
);
mutate(
  'scripts/external-transport-refinement.mjs',
  '        if (claimDelayMs > 0) await sleep(claimDelayMs);',
  '        void claimDelayMs;',
  'one-tick refinement loses deterministic claim-latency witness',
  /external one-tick lease witness must preserve deterministic claimDelayMs injection/u,
);
mutate(
  'formal/WorkOnceExternal.tla',
  's.oneTickHeartbeatCompatible',
  's.oneTickAccepted',
  'external model restores unconditional one-tick acceptance claim',
  /external TLA contract must require oneTickHeartbeatCompatible/u,
);
mutate(
  'scripts/external-transport-refinement.mjs',
  '        async heartbeat() {\n          return { observedAt: 100, leaseUntil: 100 + ackHistoryLeaseMs };\n        },',
  '        heartbeat: service.heartbeat,',
  'unknown-ACK witness allows scheduler-dependent durable heartbeat history',
  /AssertionError: unknown-ACK history sample must use deterministic heartbeat stub/u,
);
mutate(
  'test/process/local-runner-process.test.mjs',
  "          const snapshots = await observing.queue.inspectMany(['0', '1', '2']);",
  '          const snapshots = [];',
  'multi-active crash synchronization stops observing durable WorkOnce state',
  /multi-active crash fixture must observe durable WorkOnce state before SIGKILL/u,
);
mutate(
  'test/process/local-runner-child.mjs',
  "const leaseMs = mode === 'multi-active' ? 2000 : 200;",
  'const leaseMs = 200;',
  'scheduler-sensitive multi-active crash lease',
  /multi-active crash child must keep the 2000ms synchronization lease/u,
);
mutate(
  'test/process/local-runner-child.mjs',
  '          if (claimed) logicalNow += 1;',
  '          void claimed;',
  'heartbeat crash child loses deterministic logical clock advance',
  /heartbeat crash child must advance logical storage time after the initial claim/u,
);
mutate(
  'test/process/local-runner-process.test.mjs',
  'const childMessageTimeoutMs = 15_000;',
  'const childMessageTimeoutMs = 0;',
  'local-runner buffered IPC timeout becomes non-positive',
  /local-runner buffered IPC timeout must remain explicitly bounded at 15 seconds/u,
);
mutate(
  'test/process/local-runner-child.mjs',
  "    process.send?.({ stage: 'heartbeat-started', attempt: run.attempt });",
  "    process.send?.({ stage: 'heartbeat-started', ref: run.ref });",
  'heartbeat crash fixture loses the original durable lease deadline',
  /heartbeat crash child must expose the immutable claimed attempt including its original lease deadline/u,
);
mutate(
  'test/process/local-runner-process.test.mjs',
  '          snapshot.phase.attempt.leaseUntil > started.attempt.leaseUntil,',
  '          true,',
  'heartbeat crash fixture stops proving a durable renewal',
  /heartbeat crash fixture must observe the renewed durable lease/u,
);
mutate(
  'test/process/local-runner-process.test.mjs',
  "        (snapshot) => snapshot.phase.state === 'succeeded',",
  '        () => true,',
  'settlement crash fixture stops proving durable success',
  /settlement crash fixture must observe durable success/u,
);
mutate(
  'test/process/local-runner-child.mjs',
  '          if (renewed || settled) await forever;',
  '          void renewed; void settled;',
  'local-runner crash child stops at post-commit/pre-reply boundary',
  /must remain blocked after durable heartbeat\/settlement commit and before reply/u,
);
mutate(
  'test/process/external-effect-process.test.mjs',
  'const fixtureLeaseMs = childMessageTimeoutMs * 2;',
  'const fixtureLeaseMs = Math.floor(childMessageTimeoutMs / 2);',
  'external-effect fixture lease no longer outlives IPC liveness ceiling',
  /external-effect crash fixture lease must be derived to outlive its IPC liveness ceiling/u,
);
mutate(
  'test/process/policy-process.test.mjs',
  'const fixtureLeaseMs = childMessageTimeoutMs * 2;',
  'const fixtureLeaseMs = Math.floor(childMessageTimeoutMs / 2);',
  'policy fixture lease no longer outlives IPC liveness ceiling',
  /policy crash fixture lease must be derived to outlive its IPC liveness ceiling/u,
);
mutate(
  'test/process/policy-process.test.mjs',
  'expiredAt = before.phase.attempt.leaseUntil + 1;',
  'expiredAt = before.phase.attempt.leaseUntil - 1;',
  'policy crash reclaim clock stays before durable lease expiry',
  /policy crash reclaim must derive expiry from the durable lease deadline/u,
);
mutate(
  'test/process/local-runner-process.test.mjs',
  'expiredAt = Math.max(...snapshots.map((snapshot) => snapshot.phase.attempt.leaseUntil)) + 1;',
  'expiredAt = Math.max(...snapshots.map((snapshot) => snapshot.phase.attempt.leaseUntil)) - 1;',
  'multi-active crash reclaim clock stays before durable lease expiry',
  /multi-active crash fixture must derive expiry from the durable post-kill lease deadline/u,
);
mutate(
  'test/process/local-runner-process.test.mjs',
  "  const exited = once(child, 'exit', { signal: AbortSignal.timeout(15000) });",
  "  const exited = once(child, 'exit');",
  'unbounded process exit wait',
  /unbounded child exit wait/u,
);

mutate(
  'scripts/check-bounded-trace-domain.mjs',
  '    historyLimit: historyTruncationSample.retainedEvents,',
  '    historyLimit: 128,',
  'bounded-domain coverage returns to an unobserved literal',
  /history limit must come from the observed truncation sample/u,
);
mutate(
  'scripts/outbox-refinement.mjs',
  "  await within(parentAckEntered, 'stale-parent held acknowledgement');",
  '  await parentAckEntered;',
  'outbox stale-parent refinement restores unbounded held-ack wait',
  /outbox stale-parent refinement must bound its held-acknowledgement wait/u,
);
mutate(
  'scripts/outbox-refinement.mjs',
  '  } finally {\n    release();\n    try {\n      await delayed;\n    } catch (error) {\n      staleError = error;\n    }\n  }',
  '  } finally {\n    try {\n      await delayed;\n    } catch (error) {\n      staleError = error;\n    }\n  }\n  release();',
  'outbox stale-parent cleanup releases held acknowledgement after cleanup',
  /outbox stale-parent refinement must release its held acknowledgement and drain delayed work in finally/u,
);
mutate(
  'test/process/sqlite-busy-child.mjs',
  "      db.exec('COMMIT');\n      if (process.send) process.send({ unlocking: true, unlockingAt: Date.now() }, finishUnlock);",
  "      if (process.send) process.send({ unlocking: true, unlockingAt: Date.now() }, finishUnlock);\n      db.exec('COMMIT');",
  'SQLite busy child publishes unlock before commit',
  /SQLite busy lock-release witness must publish only after COMMIT completes/u,
);
mutate(
  'test/process/sqlite-busy-child.mjs',
  'if (process.send) process.send({ unlocking: true, unlockingAt: Date.now() }, finishUnlock);',
  'if (process.send) { process.send({ unlocking: true, unlockingAt: Date.now() }); finishUnlock(); }',
  'SQLite busy child closes before unlock IPC flush completes',
  /SQLite busy child must flush the unlock witness before closing its IPC channel/u,
);
mutate(
  'scripts/check-bounded-trace-domain.mjs',
  "  'scripts/refinement-sample-schema.mjs',\n",
  '',
  'bounded-domain evidence loses shared refinement sample schema',
  /bounded-domain evidence must hash the shared refinement sample schema/u,
);
mutate(
  'scripts/check-bounded-trace-domain.mjs',
  "  'test/process/child-ipc-inbox.mjs',\n",
  '',
  'bounded-domain evidence loses shared child IPC inbox',
  /bounded-domain evidence must hash the shared child IPC inbox used by process witnesses/u,
);
mutate(
  'scripts/check-bounded-trace-domain.mjs',
  "  'assurance/red-before/mutation-guard-cross-contamination.json',\n",
  '',
  'bounded-domain evidence loses mutation-guard scheduling witness',
  /bounded-domain evidence must hash the mutation-guard scheduling witness/u,
);
mutate(
  'scripts/check-bounded-trace-domain.mjs',
  "  'assurance/red-before/process-fault-test-concurrency.json',\n",
  '',
  'bounded-domain evidence loses process-fault scheduling witness',
  /bounded-domain evidence must hash the process-fault scheduling witness/u,
);
mutate(
  'scripts/storage-formal.mjs',
  'SPECIFICATION BatchSpec\\nCONSTANT MaxConflicts = ${maxConflicts}',
  'SPECIFICATION BatchSpec\\nCONSTANT MaxConflicts = 3',
  'storage mutation config diverges from the reviewed base bound',
  /must not hard-code a different MaxConflicts bound/u,
);
mutate(
  'scripts/run-assurance.mjs',
  '              terminateAllProcessTrees();',
  '              void children;',
  'parallel descendant tree leak',
  /parallel assurance failure no longer terminates every active child tree/u,
);

mutate(
  'scripts/storage-formal.mjs',
  '      maxBuffer: 16 * 1024 * 1024,',
  '      maxBuffer: 1024,',
  'storage formal loses bounded TLC output capacity',
  /storage formal wrapper must bound captured TLC output explicitly/u,
);

mutate(
  'scripts/lifecycle-refinement.mjs',
  "    } else if (sample.kind === 'cancelOrdering') {\n      assertExactBooleanSample(\n        sample,\n        [",
  "    } else if (sample.kind === 'cancelOrdering') {\n      Object.entries(sample);\n      assertExactBooleanSample(\n        sample,\n        [",
  'refinement validator returns to presence-only evidence checking',
  /validates only evidence fields that happen to be present/u,
);
mutate(
  'test/process/lifecycle-process.test.mjs',
  'const nextMessage = (child) => nextChildMessage(child, childMessageTimeoutMs);',
  "const nextMessage = async (child) => (await once(child, 'message', { signal: AbortSignal.timeout(childMessageTimeoutMs) }))[0];",
  'lifecycle process fixture returns to one-shot IPC waits',
  /lossy one-shot child IPC message wait/u,
);
mutate(
  'test/process/child-ipc-inbox.mjs',
  "  child.on('message', (message) => {",
  "  child.once('message', (message) => {",
  'child IPC inbox loses persistent message buffering',
  /persistent message listener/u,
);
mutate(
  'scripts/mutation-file-guard.mjs',
  "      restoreAll();\n      disposed = true;\n      process.off('SIGINT', onSigint);",
  "      void restoreAll;\n      disposed = true;\n      process.off('SIGINT', onSigint);",
  'mutation file guard loses normal-disposal restoration',
  /restore remembered files during normal disposal/u,
);
mutate(
  'scripts/mutation-file-guard.mjs',
  '    fs.writeSync(2, `${restoreFailureDiagnostic(error)}\\n`);',
  '    process.stderr.write(`${restoreFailureDiagnostic(error)}\\n`);',
  'mutation file guard restores asynchronous pre-exit diagnostics',
  /synchronously publish restore failures before forced exit/u,
);
mutate(
  'scripts/lifecycle-formal.mjs',
  "  process.stdout.write(result.stdout ?? '');",
  '  void result.stdout;',
  'lifecycle formal runner drops captured TLC stdout',
  /re-emit captured TLC stdout/u,
);

mutate(
  'scripts/formal-bounded-refinement-corpus.mjs',
  "{ id: 'bad', leaseMs: 30_000, maxElapsedMs: 60_000 }",
  "{ id: 'bad', leaseMs: 30_000 }",
  'worker-isolation proof loses its generation elapsed deadline margin',
  /both lease and generation elapsed deadline/u,
);

mutate(
  'scripts/check-build-source-binding-mutation.mjs',
  "requireSuccessfulProcess(bindingCheck(), 'baseline build/source binding');",
  'void bindingCheck();',
  'build/source mutation guard loses green baseline precondition',
  /green bound baseline before creating mutants/u,
);

mutate(
  'scripts/run-assurance.mjs',
  '    if (result.status !== 0 && result.status !== 128)',
  '    if (false)',
  'Windows taskkill containment ignores failed termination',
  /Windows assurance containment must reject taskkill failures other than missing processes/u,
);

mutate(
  'scripts/formal.mjs',
  'RuntimeNegativeSampleMutantsRejected ==',
  'RuntimeNegativeSampleMutantsRejectedBROKEN ==',
  'runtime bad-sample batch loses its registered discriminating invariant',
  /runtime bad-sample mutations must remain in the observed-model TLC traversal/u,
);
mutate(
  'scripts/formal.mjs',
  "  if (!specSwapped)\n    throw new Error('Mutation witness config found no SPECIFICATION Spec line to rebind');",
  '  void specSwapped;',
  'formal mutation witness config loses missing-spec fail-closed guard',
  /formal mutation witness config must fail closed when SPECIFICATION Spec is absent/u,
);

mutate(
  'scripts/check-source-path-portability-mutation.mjs',
  'if (process.env.WORKONCE_SOURCE_PATH_BASELINE_CERTIFIED !== String(process.ppid)) {',
  'if (false) {',
  'source-path mutation checker loses parent-bound standalone baseline',
  /standalone baseline bypass must be bound to its direct assurance parent/u,
);
mutate(
  'scripts/check-source-path-portability-mutation.mjs',
  "  requireSuccessfulProcess(selfTest('--self-test-source-paths'), 'baseline compiler source paths');\n",
  '',
  'source-path mutation checker loses source-path green baseline',
  /must prove baseline compiler source paths before standalone mutants/u,
);
mutate(
  'scripts/outbox-refinement.mjs',
  '  let observedWithinDeadline;\n',
  '  let observedWithinDeadline = false;\n',
  'outbox refinement turns scheduler delay into false semantic evidence',
  /derive liveness evidence from observed state instead of scheduler time/u,
);
mutate(
  'scripts/external-transport-refinement.mjs',
  '  let observedWithinDeadline;\n',
  '  let observedWithinDeadline = true;\n',
  'external refinement fabricates scheduler-deadline semantic evidence',
  /derive liveness evidence from observed state instead of scheduler time/u,
);

mutate(
  'scripts/run-assurance.mjs',
  'process.env.WORKONCE_SOURCE_PATH_BASELINE_CERTIFIED = String(process.pid);',
  "process.env.WORKONCE_SOURCE_PATH_BASELINE_CERTIFIED = '1';",
  'assurance runner compiler baseline certificate loses parent binding',
  /must bind compiler baseline certification to its own process id/u,
);
mutate(
  'scripts/run-assurance.mjs',
  "    'compiler source-path portability baseline',\n",
  "    'compiler source-path portability missing-baseline',\n",
  'assurance runner loses named source-path baseline before mutants',
  /compiler source-path portability baseline must run before compiler source-path mutants/u,
);

mutate(
  'scripts/check-assurance-infrastructure-binding-mutation.mjs',
  "requireSuccessfulProcess(\n  run('scripts/check-formal-implementation-conformance.mjs', '--check-infrastructure-binding-only'),\n  'baseline assurance infrastructure binding',\n);\n",
  '',
  'assurance infrastructure mutation checker loses infrastructure baseline',
  /must establish a green infrastructure baseline/u,
);
mutate(
  'scripts/check-assurance-infrastructure-binding-mutation.mjs',
  "requireSuccessfulProcess(\n  run('scripts/check-bounded-trace-domain.mjs', '--check-evidence-binding-only'),\n  'baseline bounded-trace evidence binding',\n);\n",
  '',
  'assurance infrastructure mutation checker loses bounded-evidence baseline',
  /must establish a green bounded-evidence baseline/u,
);
mutate(
  'scripts/check-assurance-infrastructure-binding-mutation.mjs',
  "requireSuccessfulProcess(\n  run(\n    'scripts/check-formal-implementation-conformance.mjs',\n    '--check-semantic-environment-binding-only',\n  ),\n  'baseline semantic-environment binding',\n);\n",
  '',
  'assurance infrastructure mutation checker loses semantic-environment baseline',
  /must establish a green semantic-environment baseline/u,
);
mutate(
  'scripts/check-build-input-binding-mutation.mjs',
  "  requireSuccessfulProcess(bindingCheck(), 'baseline build-input binding');\n",
  '',
  'build-input mutation checker loses its green baseline',
  /build-input mutation guard must establish a green baseline/u,
);
mutate(
  'test/tlc-workspace.test.mjs',
  '      timeout: 15_000,\n',
  '',
  'TLC workspace test child loses its timeout bound',
  /test\/tlc-workspace\.test\.mjs has an unbounded spawnSync/u,
);
mutate(
  'scripts/lifecycle-refinement.mjs',
  "    kind: 'claimOrderEquivalence',\n    adapters: lifecycleAdapters.join(','),",
  "    kind: 'claimOrderEquivalence',\n    adapters: 'memory,sqlite,cas',",
  'lifecycle adapter evidence label becomes independent of iterated domain',
  /lifecycle adapter evidence label must derive from the adapter loop/u,
);

console.log(
  'Assurance verdict integrity mutation guard rejects all reviewed false-green and hang regressions.',
);
mutationFiles.dispose();
