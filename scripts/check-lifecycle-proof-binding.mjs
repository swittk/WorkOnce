import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'assurance/lifecycle-proof-binding.json');
const write = process.argv.includes('--write');
const sourceFiles = [
  'src/model.ts',
  'src/kernel.ts',
  'src/outcomes.ts',
  'src/work.ts',
  'src/storage.ts',
  'src/storage-validation.ts',
  'src/memory.ts',
  'src/sqlite.ts',
  'src/cas.ts',
];
const modelFiles = [
  'formal/WorkOnce.tla',
  'formal/WorkOnce.cfg',
  'formal/WorkOnceLifecycleTemporal.tla',
  'formal/WorkOnceLifecycleTemporal.cfg',
  'formal/WorkOnceClaimScan.tla',
  'formal/WorkOnceClaimScan.cfg',
  'formal/WorkOnceLifecycleContract.tla',
];
const evidenceFiles = [
  'scripts/lifecycle-refinement.mjs',
  'scripts/refinement-sample-schema.mjs',
  'scripts/lifecycle-formal.mjs',
  'scripts/tlc-workspace.mjs',
  'test/tlc-workspace.test.mjs',
  'scripts/check-lifecycle-proof-binding.mjs',
  'scripts/check-lifecycle-source-model-mutation.mjs',
  'scripts/check-lifecycle-implementation-mutations.mjs',
  'test/lifecycle-refinement.test.mjs',
  'test/lifecycle-formal.test.mjs',
  'test/lifecycle-proof-controls.test.mjs',
  'test/process/lifecycle-child.mjs',
  'test/process/lifecycle-process.test.mjs',
  'test/process/child-ipc-inbox.mjs',
  'test/process/sqlite-process.test.mjs',
];
function digest(files) {
  const hash = crypto.createHash('sha256');
  const mutantFile = process.env.WORKONCE_LIFECYCLE_BINDING_MUTANT;
  for (const file of files) {
    let text = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n?/gu, '\n');
    if (mutantFile === file) text += '\n/* lifecycle binding mutation */\n';
    hash.update(`${file}\n${text}\n---\n`);
  }
  return hash.digest('hex');
}
const value = {
  version: 1,
  sourceFiles,
  modelFiles,
  evidenceFiles,
  sourceDigest: digest(sourceFiles),
  modelDigest: digest(modelFiles),
  evidenceDigest: digest(evidenceFiles),
};
if (write) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  console.log('Wrote assurance/lifecycle-proof-binding.json.');
} else {
  if (!fs.existsSync(target)) throw new Error('Missing assurance/lifecycle-proof-binding.json');
  const committed = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (committed.sourceDigest !== value.sourceDigest && committed.modelDigest === value.modelDigest)
    throw new Error(
      'Lifecycle source/model binding drifted: lifecycle source changed with unchanged A model.',
    );
  if (committed.modelDigest !== value.modelDigest && committed.sourceDigest === value.sourceDigest)
    throw new Error(
      'Lifecycle model binding drifted: A model changed with unchanged lifecycle source review.',
    );
  if (committed.evidenceDigest !== value.evidenceDigest)
    throw new Error('Lifecycle proof evidence binding drifted.');
  if (JSON.stringify(committed) !== JSON.stringify(value))
    throw new Error('Lifecycle proof binding drifted.');
  console.log('Lifecycle source/model and proof-evidence binding matches committed review.');
}
