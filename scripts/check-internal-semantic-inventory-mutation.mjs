import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

import { createMutationFileGuard } from './mutation-file-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutationFiles = createMutationFileGuard();
const sourcePath = path.join(root, 'src/worker.ts');
const workSourcePath = path.join(root, 'src/work.ts');
const externalSourcePath = path.join(root, 'src/external.ts');
const modelSourcePath = path.join(root, 'src/model.ts');
const inventoryPath = path.join(root, 'assurance/internal-semantic-inventory.json');
const source = fs.readFileSync(sourcePath, 'utf8');
const workSource = fs.readFileSync(workSourcePath, 'utf8');
const externalSource = fs.readFileSync(externalSourcePath, 'utf8');
const modelSource = fs.readFileSync(modelSourcePath, 'utf8');
const inventoryText = fs.readFileSync(inventoryPath, 'utf8');

function run() {
  return spawnSync(process.execPath, ['scripts/check-internal-semantic-inventory.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 15_000,
  });
}
function output(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

try {
  const needle = 'export async function runWorker';
  const index = source.indexOf(needle);
  assert.notEqual(index, -1, 'runWorker source anchor is missing');
  const bodyAnchor = '): Promise<void> {';
  const signatureEnd = source.indexOf(bodyAnchor, index);
  assert.notEqual(signatureEnd, -1, 'runWorker body anchor is missing');
  const brace = signatureEnd + bodyAnchor.length - 1;
  mutationFiles.writeFileSync(
    sourcePath,
    `${source.slice(0, brace + 1)}
  let internalSemanticInventoryMutant = 0;
  internalSemanticInventoryMutant += 1;
  queueMicrotask(() => {});
  Object.assign({}, { mutant: true });
  const internalSemanticWeakMapMutant = new WeakMap<object, number>();
  internalSemanticWeakMapMutant.set({}, 1);
  const internalSemanticQueueMutant: number[] = [];
  internalSemanticQueueMutant.push(1);
  const internalSemanticPropertyMutant = { value: 0 };
  internalSemanticPropertyMutant.value = 1;
${source.slice(brace + 1)}`,
  );
  const classAnchor = 'export class WorkRun<I, O, R extends string> {';
  assert.ok(workSource.includes(classAnchor), 'WorkRun class anchor is missing');
  mutationFiles.writeFileSync(
    workSourcePath,
    workSource.replace(
      classAnchor,
      `${classAnchor}
  internalSemanticMutablePropertyMutant = 0;`,
    ),
  );
  const sourceMutant = run();
  requireExpectedProcessFailure(
    sourceMutant,
    'new mutable runner/class state unexpectedly passed inventory',
  );
  const sourceOutput = output(sourceMutant);
  assert.match(sourceOutput, /Internal semantic inventory drifted/u);
  assert.match(sourceOutput, /mutable_let/u);
  assert.match(sourceOutput, /new_WeakMap/u);
  assert.match(sourceOutput, /call_mutator_set/u);
  assert.match(sourceOutput, /call_mutator_push/u);
  assert.match(sourceOutput, /property_assignment/u);
  assert.match(sourceOutput, /mutable_property/u);
  assert.match(sourceOutput, /call_queueMicrotask/u);
  assert.match(sourceOutput, /call_mutator_Object\.assign/u);
} finally {
  mutationFiles.restoreAll();
}

try {
  mutationFiles.writeFileSync(
    modelSourcePath,
    `${modelSource}\nfunction internalSemanticUnknownCallMutant(): void { internalSemanticCompletelyNewCall(); }\n`,
  );
  const unclassifiedCallMutant = run();
  requireExpectedProcessFailure(
    unclassifiedCallMutant,
    'new unclassified call unexpectedly bypassed internal semantic inventory',
  );
  assert.match(output(unclassifiedCallMutant), /unclassified call surface drifted/u);
} finally {
  mutationFiles.restoreAll();
}

try {
  const suffixAnchor = '          active.delete(pending);';
  assert.equal(
    externalSource.split(suffixAnchor).length,
    2,
    'long internal-semantic construct suffix anchor must be unique',
  );
  mutationFiles.writeFileSync(
    externalSourcePath,
    externalSource.replace(suffixAnchor, `${suffixAnchor} // full-text-digest-mutant`),
  );
  const suffixMutant = run();
  requireExpectedProcessFailure(
    suffixMutant,
    'semantic edit beyond the human-readable excerpt unexpectedly passed inventory',
  );
  assert.match(output(suffixMutant), /Internal semantic inventory drifted/u);
} finally {
  mutationFiles.restoreAll();
}

try {
  const inventory = JSON.parse(inventoryText);
  assert.ok(
    Array.isArray(inventory.entries) && inventory.entries.length > 0,
    'internal semantic inventory entries anchor is missing',
  );
  inventory.entries[0].families = [];
  mutationFiles.writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  const classificationMutant = run();
  requireExpectedProcessFailure(
    classificationMutant,
    'unclassified inventory cell unexpectedly passed',
  );
  assert.match(output(classificationMutant), /has no proof family/u);
} finally {
  mutationFiles.restoreAll();
}

console.log(
  'Internal semantic inventory rejects new mutable locals/properties/containers/updates and unclassified cells.',
);
mutationFiles.dispose();
