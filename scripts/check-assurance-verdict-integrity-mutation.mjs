import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAssuranceVerdictIntegrity } from './check-assurance-verdict-integrity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function mutate(relative, from, to, label, pattern) {
  const target = path.join(root, relative);
  const original = fs.readFileSync(target, 'utf8');
  assert.ok(original.includes(from), `${label} mutation anchor is stale`);
  try {
    fs.writeFileSync(target, original.replace(from, to));
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
    fs.writeFileSync(target, original);
  }
}

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
  /oneAccepted|literal/u,
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
  /for \(;;\)|maxPasses/u,
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
  'scripts/local-runner-refinement.mjs',
  "    await within(firstWave.promise, 'competing runners first wave');",
  '    await firstWave.promise;',
  'local-runner refinement restores an unbounded deferred wait',
  /bare deferred await|bounded refinement wait/u,
);
mutate(
  'scripts/external-transport-refinement.mjs',
  '        if (claimDelayMs > 0) await sleep(claimDelayMs);',
  '        void claimDelayMs;',
  'one-tick refinement loses deterministic claim-latency witness',
  /claimDelayMs|delayedOneTick/u,
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
  /heartbeat|unknownAckHistory/u,
);
mutate(
  'test/process/local-runner-process.test.mjs',
  "  child.on('message', (message) => {",
  "  child.once('message', (message) => {",
  'IPC inbox loses messages between awaits',
  /child\.on|childInboxes|messages/u,
);
mutate(
  'test/process/local-runner-process.test.mjs',
  "          const snapshots = await observing.queue.inspectMany(['0', '1', '2']);",
  '          const snapshots = [];',
  'multi-active crash synchronization stops observing durable WorkOnce state',
  /inspectMany|durable WorkOnce/u,
);
mutate(
  'test/process/local-runner-child.mjs',
  "const leaseMs = mode === 'multi-active' ? 2000 : 200;",
  'const leaseMs = 200;',
  'scheduler-sensitive multi-active crash lease',
  /multi-active|2000/u,
);
mutate(
  'test/process/local-runner-process.test.mjs',
  "  const exited = once(child, 'exit', { signal: AbortSignal.timeout(15000) });",
  "  const exited = once(child, 'exit');",
  'unbounded process exit wait',
  /unbounded child exit wait/u,
);
mutate(
  'scripts/run-assurance.mjs',
  '        child.kill();',
  '        void child;',
  'parallel sibling leak',
  /The input did not match/u,
);

console.log(
  'Assurance verdict integrity mutation guard rejects all reviewed false-green and hang regressions.',
);
