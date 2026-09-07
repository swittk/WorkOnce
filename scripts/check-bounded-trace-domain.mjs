import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBoundedRefinementCorpus } from './formal-bounded-refinement-corpus.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'assurance/bounded-trace-domain.json');
const write = process.argv.includes('--write');
const evidenceFiles = [
  'scripts/formal-bounded-refinement-corpus.mjs',
  'test/formal-bounded-refinement.test.mjs',
];
function digestFiles(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files)
    hash.update(`${file}\n${fs.readFileSync(path.join(root, file), 'utf8')}\n---\n`);
  return hash.digest('hex');
}
const report = await runBoundedRefinementCorpus();
const current = {
  version: 1,
  evidenceFiles,
  evidenceDigest: digestFiles(evidenceFiles),
  domain: Object.fromEntries(
    Object.keys(report.coverage)
      .sort()
      .map((key) => [key, report.coverage[key] > 0]),
  ),
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
  const committed = fs.readFileSync(target, 'utf8');
  if (committed !== canonicalCurrent) {
    throw new Error(
      'Bounded trace report drifted. Run npm run assurance:update and review the complete observed coverage.',
    );
  }
  console.log(
    `Bounded trace domain covers ${Object.keys(current.domain).length} reviewed dimensions across ${report.deterministicScenarios} deterministic scenarios and ${report.fuzzTraces} seeded traces.`,
  );
}
