import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBuildSourceBinding } from './build-source-binding.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assertBuildSourceBinding();
const { runBoundedRefinementCorpus } = await import('./formal-bounded-refinement-corpus.mjs');
const { runRuntimeBoundarySamples, assertRuntimeBoundarySamples } = await import(
  './runtime-boundary-refinement.mjs'
);
const { runExternalTransportSamples, assertExternalTransportSamples } = await import(
  './external-transport-refinement.mjs'
);
const { runOutboxRefinementSamples, assertOutboxRefinementSamples } = await import(
  './outbox-refinement.mjs'
);
const { runLocalRunnerRefinementSamples, assertLocalRunnerRefinementSamples } = await import(
  './local-runner-refinement.mjs'
);
const { runPolicyRefinementSamples, assertPolicyRefinementSamples } = await import(
  './policy-refinement.mjs'
);
const { runReadHistorySamples, assertReadHistorySamples } = await import(
  './read-history-refinement.mjs'
);
const { runStorageRefinementSamples, assertStorageRefinementSamples } = await import(
  './storage-refinement.mjs'
);
const target = path.join(root, 'assurance/bounded-trace-domain.json');
const write = process.argv.includes('--write');
const evidenceFiles = [
  'scripts/formal-bounded-refinement-corpus.mjs',
  'test/formal-bounded-refinement.test.mjs',
  'scripts/runtime-boundary-refinement.mjs',
  'scripts/read-boundary-refinement.mjs',
  'test/read-boundary-refinement.test.mjs',
  'test/read-contract.test.mjs',
  'scripts/check-read-boundary-mutation.mjs',
  'scripts/check-read-source-model-binding-mutation.mjs',
  'scripts/check-read-contract-mutation.mjs',
  'scripts/read-history-refinement.mjs',
  'test/read-history-refinement.test.mjs',
  'scripts/check-read-history-mutations.mjs',
  'formal/WorkOnceReadHistory.tla',
  'formal/WorkOnceReadHistory.cfg',
  'assurance/red-before/read-history-future-congruence.json',
  'test/runtime-boundary-refinement.test.mjs',
  'scripts/local-runner-refinement.mjs',
  'test/local-runner-refinement.test.mjs',
  'test/process/local-runner-child.mjs',
  'test/process/local-runner-process.test.mjs',
  'formal/WorkOnceLocalRunner.tla',
  'formal/WorkOnceLocalRunner.cfg',
  'scripts/check-local-runner-implementation-mutations.mjs',
  'scripts/check-local-runner-source-model-mutation.mjs',
  'assurance/red-before/local-runner-heartbeat-cause.json',
  'assurance/red-before/tlc-infrastructure-classification.json',
  'assurance/red-before/internal-mutable-property-topology.json',
  'assurance/red-before/internal-mutable-container-updates.json',
  'assurance/red-before/source-semantic-hash-collision.json',
  'assurance/red-before/formal-semantic-hash-collision.json',
  'assurance/red-before/compiler-directive-semantic-hash.json',
  'test/lifecycle-transition-matrix.test.mjs',
  'scripts/policy-refinement.mjs',
  'test/policy-refinement.test.mjs',
  'test/process/policy-child.mjs',
  'test/process/policy-process.test.mjs',
  'formal/WorkOncePolicy.tla',
  'formal/WorkOncePolicy.cfg',
  'scripts/check-policy-source-model-binding-mutation.mjs',
  'scripts/check-policy-implementation-mutations.mjs',
  'scripts/outbox-refinement.mjs',
  'scripts/check-outbox-source-model-binding-mutation.mjs',
  'scripts/check-outbox-implementation-mutations.mjs',
  'test/outbox-refinement.test.mjs',
  'test/outbox-cursor-control.test.mjs',
  'test/process/outbox-process.test.mjs',
  'test/process/outbox-child.mjs',
  'formal/WorkOnceOutbox.tla',
  'formal/WorkOnceOutbox.cfg',
  'formal/WorkOnceOutboxBudget.tla',
  'formal/WorkOnceOutboxBudget.cfg',
  'scripts/external-transport-refinement.mjs',
  'test/external-transport-refinement.test.mjs',
  'test/external.test.mjs',
  'test/process/external-effect-child.mjs',
  'test/process/external-effect-process.test.mjs',
  'formal/WorkOnceExternal.tla',
  'formal/WorkOnceExternal.cfg',
  'scripts/check-external-source-model-mutation.mjs',
  'scripts/check-external-implementation-mutations.mjs',
  'scripts/formal.mjs',
  'formal/WorkOnceStorage.cfg',
  'formal/WorkOnceStorage.tla',
  'assurance/red-before/storage-conformance-baseline.json',
  'test/process/sqlite-busy-child.mjs',
  'test/process/sqlite-busy-startup.test.mjs',
  'test/storage-contract-hardening.test.mjs',
  'test/storage-refinement.test.mjs',
  'test/process/storage-child.mjs',
  'test/process/storage-process.test.mjs',
  'test/process/sqlite-process.test.mjs',
  'scripts/check-storage-source-model-mutation.mjs',
  'scripts/check-storage-contract-mutation.mjs',
  'scripts/storage-formal.mjs',
  'scripts/storage-refinement.mjs',
  'scripts/build-source-binding.mjs',
  'scripts/check-build-source-binding-mutation.mjs',
  'scripts/check-assurance-infrastructure-binding-mutation.mjs',
  'scripts/tlc-outcome.mjs',
  'scripts/subprocess-outcome.mjs',
  'test/subprocess-outcome.test.mjs',
  'scripts/check-assurance-verdict-integrity.mjs',
  'scripts/check-assurance-verdict-integrity-mutation.mjs',
  'assurance/red-before/review-5148224210-assurance-verdict-integrity.json',
  'scripts/tlc-workspace.mjs',
  'test/tlc-workspace.test.mjs',
  'scripts/check-tlc-workspace-isolation.mjs',
  'scripts/check-tlc-workspace-isolation-mutation.mjs',
  'assurance/red-before/tlc-cross-invocation-workspace-collision.json',
  'scripts/check-tlc-outcome-classification.mjs',
  'scripts/check-formal-config-coverage-mutation.mjs',
  'scripts/internal-semantic-surface.mjs',
  'scripts/check-internal-semantic-inventory.mjs',
  'scripts/check-internal-semantic-inventory-mutation.mjs',
  'assurance/internal-semantic-inventory.json',
  'scripts/check-emitted-artifact-entrypoints.mjs',
  'scripts/check-emitted-artifact-entrypoint-mutation.mjs',
  'scripts/check-bounded-trace-domain.mjs',
  'scripts/check-formal-implementation-conformance.mjs',
  'test/source-semantic-hash.test.mjs',
  'scripts/formal-implementation-surface.cjs',
  'scripts/check-source-path-portability-mutation.mjs',
  'assurance/red-before/manifest-worktree-source-path-portability.json',
  'scripts/run-assurance.mjs',
  'scripts/consumer-smoke.mjs',
  'scripts/prepare-package.mjs',
  'package.json',
];
function digestFiles(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const content = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/gu, '\n');
    hash.update(`${file}\n${content}\n---\n`);
  }
  return hash.digest('hex');
}
if (process.argv.includes('--check-evidence-binding-only')) {
  if (!fs.existsSync(target))
    throw new Error('Missing assurance/bounded-trace-domain.json. Run npm run assurance:update.');
  const previous = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (JSON.stringify(previous.evidenceFiles) !== JSON.stringify(evidenceFiles))
    throw new Error('Bounded trace evidence file list drifted.');
  const actual = digestFiles(evidenceFiles);
  if (previous.evidenceDigest !== actual)
    throw new Error(
      `Bounded trace evidence digest drifted: expected=${previous.evidenceDigest ?? 'missing'} actual=${actual}`,
    );
  console.log('Bounded trace evidence content binding matches the reviewed report.');
  process.exit(0);
}

const report = await runBoundedRefinementCorpus();
const boundarySamples = await runRuntimeBoundarySamples();
assertRuntimeBoundarySamples(boundarySamples);
const externalSamples = await runExternalTransportSamples();
assertExternalTransportSamples(externalSamples);
const outboxSamples = await runOutboxRefinementSamples();
assertOutboxRefinementSamples(outboxSamples);
const localRunnerSamples = await runLocalRunnerRefinementSamples();
assertLocalRunnerRefinementSamples(localRunnerSamples);
const policySamples = await runPolicyRefinementSamples();
assertPolicyRefinementSamples(policySamples);
const readHistorySamples = await runReadHistorySamples();
assertReadHistorySamples(readHistorySamples);
const storageSamples = await runStorageRefinementSamples();
assertStorageRefinementSamples(storageSamples);
const current = {
  version: 1,
  evidenceFiles,
  evidenceDigest: digestFiles(evidenceFiles),
  domain: Object.fromEntries(
    Object.keys(report.coverage)
      .sort()
      .map((key) => [key, report.coverage[key] > 0]),
  ),
  runtimeBoundary: {
    samples: boundarySamples.length,
    counts: Object.fromEntries(
      ['runner', 'runnerHistory', 'read', 'readAdapter', 'backoff', 'budget', 'cancel'].map(
        (kind) => [kind, boundarySamples.filter((sample) => sample.kind === kind).length],
      ),
    ),
    observationDigest: crypto
      .createHash('sha256')
      .update(JSON.stringify(boundarySamples))
      .digest('hex'),
  },
  readHistoryBoundary: {
    samples: readHistorySamples.length,
    counts: Object.fromEntries(
      [...new Set(readHistorySamples.map((sample) => sample.kind))]
        .sort()
        .map((kind) => [kind, readHistorySamples.filter((sample) => sample.kind === kind).length]),
    ),
    observationDigest: crypto
      .createHash('sha256')
      .update(JSON.stringify(readHistorySamples))
      .digest('hex'),
    historyLimit: readHistorySamples.find((sample) => sample.kind === 'historyTruncation')
      ?.retainedEvents,
    futureCongruenceTraces: readHistorySamples.find((sample) => sample.kind === 'historyCongruence')
      ?.futureTraceCount,
  },
  localRunnerBoundary: {
    samples: localRunnerSamples.length,
    counts: Object.fromEntries(
      [...new Set(localRunnerSamples.map((sample) => sample.kind))]
        .sort()
        .map((kind) => [kind, localRunnerSamples.filter((sample) => sample.kind === kind).length]),
    ),
    observationDigest: crypto
      .createHash('sha256')
      .update(JSON.stringify(localRunnerSamples))
      .digest('hex'),
  },
  policyBoundary: {
    samples: policySamples.length,
    counts: Object.fromEntries(
      [...new Set(policySamples.map((sample) => sample.kind))]
        .sort()
        .map((kind) => [kind, policySamples.filter((sample) => sample.kind === kind).length]),
    ),
    observationDigest: crypto
      .createHash('sha256')
      .update(JSON.stringify(policySamples))
      .digest('hex'),
  },
  outboxScheduler: {
    samples: outboxSamples.length,
    adapters: outboxSamples
      .filter((sample) => sample.kind === 'adapter')
      .map((sample) => sample.adapter)
      .sort(),
    budgetAdapters: outboxSamples
      .filter((sample) => sample.kind === 'adapterBudget')
      .map((sample) => sample.adapter)
      .sort(),
    observationDigest: crypto
      .createHash('sha256')
      .update(JSON.stringify(outboxSamples))
      .digest('hex'),
  },
  externalBoundary: {
    samples: externalSamples.length,
    counts: Object.fromEntries(
      [...new Set(externalSamples.map((sample) => sample.kind))]
        .sort()
        .map((kind) => [kind, externalSamples.filter((sample) => sample.kind === kind).length]),
    ),
    observationDigest: crypto
      .createHash('sha256')
      .update(JSON.stringify(externalSamples))
      .digest('hex'),
  },
  storageBoundary: {
    samples: storageSamples.length,
    counts: Object.fromEntries(
      [...new Set(storageSamples.map((sample) => sample.kind))]
        .sort()
        .map((kind) => [kind, storageSamples.filter((sample) => sample.kind === kind).length]),
    ),
    observationDigest: crypto
      .createHash('sha256')
      .update(JSON.stringify(storageSamples))
      .digest('hex'),
  },
  observed: {
    deterministicScenarios: report.deterministicScenarios,
    fuzzTraces: report.fuzzTraces,
    fuzzStepsPerTrace: report.fuzzStepsPerTrace,
    coverageCounts: report.coverage,
  },
};
if (Object.values(current.domain).some((covered) => !covered))
  throw new Error('Bounded trace domain has uncovered reviewed dimensions.');
const canonicalCurrent = `${JSON.stringify(current, null, 2)}\n`;
if (write) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, canonicalCurrent);
  console.log(
    `Wrote ${path.relative(root, target)} with ${Object.keys(current.domain).length} covered dimensions.`,
  );
} else {
  if (!fs.existsSync(target))
    throw new Error(
      'Missing assurance/bounded-trace-domain.json. Run npm run assurance:update and review it.',
    );
  const committed = fs.readFileSync(target, 'utf8').replace(/\r\n?/gu, '\n');
  if (committed !== canonicalCurrent) {
    throw new Error(
      'Bounded trace report drifted. Run npm run assurance:update and review the complete observed coverage.',
    );
  }
  console.log(
    `Bounded trace domain covers ${Object.keys(current.domain).length} reviewed dimensions across ${report.deterministicScenarios} deterministic scenarios and ${report.fuzzTraces} seeded traces.`,
  );
}
