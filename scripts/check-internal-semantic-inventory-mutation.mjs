import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'src/worker.ts');
const inventoryPath = path.join(root, 'assurance/internal-semantic-inventory.json');
const source = fs.readFileSync(sourcePath, 'utf8');
const inventoryText = fs.readFileSync(inventoryPath, 'utf8');

function run() {
  return spawnSync(process.execPath, ['scripts/check-internal-semantic-inventory.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
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
    `${source.slice(0, brace + 1)}\n  let internalSemanticInventoryMutant = 0;\n  internalSemanticInventoryMutant += 1;\n${source.slice(brace + 1)}`,
  );
  const sourceMutant = run();
  assert.notEqual(sourceMutant.status, 0, 'new mutable runner state unexpectedly passed inventory');
  assert.match(output(sourceMutant), /Internal semantic inventory drifted/u);
} finally {
  fs.writeFileSync(sourcePath, source);
}

try {
  const inventory = JSON.parse(inventoryText);
  inventory.entries[0].families = [];
  fs.writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  const classificationMutant = run();
  assert.notEqual(
    classificationMutant.status,
    0,
    'unclassified inventory cell unexpectedly passed',
  );
  assert.match(output(classificationMutant), /has no proof family/u);
} finally {
  fs.writeFileSync(inventoryPath, inventoryText);
}

console.log('Internal semantic inventory rejects new hidden mutable state and unclassified cells.');
