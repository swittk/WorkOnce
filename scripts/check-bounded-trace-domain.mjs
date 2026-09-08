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
const { runPolicyRefinementSamples, assertPolicyRefinementSamples } = await import(
  './policy-refinement.mjs'
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
  'test/runtime-boundary-refinement.test.mjs',
  'test/lifecycle-transition-matrix.test.mjs',
  'scripts/policy-refinement.mjs',
  'test/policy-refinement.test.mjs',
  'test/process/policy-child.mjs',
  'test/process/policy-process.test.mjs',
  'formal/WorkOncePolicy.tla',
  'formal/WorkOncePolicy.cfg',
  'scripts/check-policy-source-model-binding-mutation.mjs',
  'scripts/check-policy-implementation-mutations.mjs',
  'scripts/formal.mjs',
  'scripts/build-source-binding.mjs',
  'scripts/check-build-source-binding-mutation.mjs',
  'scripts/check-assurance-infrastructure-binding-mutation.mjs',
  'scripts/check-emitted-artifact-entrypoints.mjs',
  'scripts/check-emitted-artifact-entrypoint-mutation.mjs',
  'scripts/check-bounded-trace-domain.mjs',
  'scripts/check-formal-implementation-conformance.mjs',
  'scripts/formal-implementation-surface.cjs',
  'scripts/run-assurance.mjs',
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
const report = await runBoundedRefinementCorpus();
const boundarySamples = await runRuntimeBoundarySamples();
assertRuntimeBoundarySamples(boundarySamples);
const policySamples = await runPolicyRefinementSamples();
assertPolicyRefinementSamples(policySamples);
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
    lifecycleAdapterCases: 600,
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
