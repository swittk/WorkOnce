import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'src/worker.ts');
const workSourcePath = path.join(root, 'src/work.ts');
const inventoryPath = path.join(root, 'assurance/internal-semantic-inventory.json');
const source = fs.readFileSync(sourcePath, 'utf8');
const workSource = fs.readFileSync(workSourcePath, 'utf8');
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
  fs.writeFileSync(
    sourcePath,
    `${source.slice(0, brace + 1)}\n  let internalSemanticInventoryMutant = 0;\n  internalSemanticInventoryMutant += 1;\n  const internalSemanticWeakMapMutant = new WeakMap<object, number>();\n  internalSemanticWeakMapMutant.set({}, 1);\n  const internalSemanticQueueMutant: number[] = [];\n  internalSemanticQueueMutant.push(1);\n  const internalSemanticPropertyMutant = { value: 0 };\n  internalSemanticPropertyMutant.value = 1;\n${source.slice(brace + 1)}`,
  );
  const sourceMutant = run();
  requireExpectedProcessFailure(
    sourceMutant,
    'new mutable runner state unexpectedly passed inventory',
  );
  const sourceOutput = output(sourceMutant);
  assert.match(sourceOutput, /Internal semantic inventory drifted/u);
  assert.match(sourceOutput, /mutable_let/u);
  assert.match(sourceOutput, /new_WeakMap/u);
  assert.match(sourceOutput, /call_mutator_(?:set|push)/u);
  assert.match(sourceOutput, /property_assignment/u);
} finally {
  fs.writeFileSync(sourcePath, source);
}

try {
  const classAnchor = 'export class WorkRun<I, O, R extends string> {';
  assert.ok(workSource.includes(classAnchor), 'WorkRun class anchor is missing');
  fs.writeFileSync(
    workSourcePath,
    workSource.replace(classAnchor, `${classAnchor}\n  internalSemanticMutablePropertyMutant = 0;`),
  );
  const propertyMutant = run();
  requireExpectedProcessFailure(
    propertyMutant,
    'new mutable class property unexpectedly passed inventory',
  );
  assert.match(output(propertyMutant), /Internal semantic inventory drifted/u);
} finally {
  fs.writeFileSync(workSourcePath, workSource);
}

try {
  const inventory = JSON.parse(inventoryText);
  inventory.entries[0].families = [];
  fs.writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  const classificationMutant = run();
  requireExpectedProcessFailure(
    classificationMutant,
    'unclassified inventory cell unexpectedly passed',
  );
  assert.match(output(classificationMutant), /has no proof family/u);
} finally {
  fs.writeFileSync(inventoryPath, inventoryText);
}

console.log(
  'Internal semantic inventory rejects new mutable locals/properties/containers/updates and unclassified cells.',
);
