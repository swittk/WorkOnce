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
  assert.ok(original.includes(from), `${label} mutation anchor is stale`);
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
  'scripts/local-runner-refinement.mjs',
  '          await within(heartbeatAttempted.promise, `${adapter}-heartbeat storage attempt`);',
  '          await sleep(35);',
  'local heartbeat cause witness returns to scheduler-delay synchronization',
  /heartbeat attempts|scheduler delay|heartbeat-loss witness/u,
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
  /bound captured TLC output/u,
);
mutate(
  'test/process/lifecycle-process.test.mjs',
  "    const exited = once(child, 'exit', { signal: AbortSignal.timeout(15000) });",
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
  '  requireExpectedInvariantViolation(result, invariant);',
  '  void result;',
  'weak lifecycle TLC mutation classification',
  /requireExpectedInvariantViolation/u,
);
mutate(
  'scripts/check-tlc-outcome-classification.mjs',
  "  requireExpectedProcessFailure(result, 'invalid TLC jar formal-assurance probe');",
  "  assert.notEqual(result.status, 0, 'invalid TLC jar unexpectedly passed formal assurance');",
  'live TLC probe bare status verdict',
  /requireExpectedProcessFailure/u,
);
mutate(
  'scripts/check-formal-implementation-conformance.mjs',
  "  requireSuccessfulProcess(result, 'formal implementation surface extractor');",
  "  if (result.status !== 0) throw new Error('surface extractor failed');",
  'surface extractor cause collapse',
  /requireSuccessfulProcess/u,
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
  /start anchor is missing/u,
);
mutate(
  'scripts/lifecycle-formal.mjs',
  '  let specSwapped = false;',
  '  let specSwapped = true;',
  'mutation witness config no longer fails closed on missing specification substitution',
  /specSwapped|SPECIFICATION Spec/u,
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
  /oneTickHeartbeatCompatible|oneTickAccepted/u,
);
mutate(
  'scripts/external-transport-refinement.mjs',
  '        async heartbeat() {\n          return { observedAt: 100, leaseUntil: 120 };\n        },',
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
  'scripts/storage-formal.mjs',
  'CONSTANT MaxConflicts = ${maxConflicts}',
  'CONSTANT MaxConflicts = 3',
  'storage mutation config diverges from the reviewed base bound',
  /must not hard-code a different MaxConflicts bound/u,
);
mutate(
  'scripts/run-assurance.mjs',
  '        child.kill();',
  '        void child;',
  'parallel sibling leak',
  /parallel assurance failure paths must kill surviving siblings/u,
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
  '      assertExactBooleanSample(\n        sample,\n        [',
  '      Object.entries(sample);\n      assertExactBooleanSample(\n        sample,\n        [',
  'refinement validator returns to presence-only evidence checking',
  /validates only evidence fields that happen to be present/u,
);
mutate(
  'test/process/lifecycle-process.test.mjs',
  'const nextMessage = (child) => nextChildMessage(child, 15000);',
  "const nextMessage = async (child) => (await once(child, 'message', { signal: AbortSignal.timeout(15000) }))[0];",
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

console.log(
  'Assurance verdict integrity mutation guard rejects all reviewed false-green and hang regressions.',
);
mutationFiles.dispose();
