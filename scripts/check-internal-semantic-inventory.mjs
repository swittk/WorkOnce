import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverInternalSemanticSurface } from './internal-semantic-surface.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventoryPath = path.join(root, 'assurance/internal-semantic-inventory.json');
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
const allowedFamilies = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);

if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.entries))
  throw new Error('Internal semantic inventory has an unsupported schema.');

const reviewed = new Map();
for (const entry of inventory.entries) {
  if (!entry || typeof entry.id !== 'string' || reviewed.has(entry.id))
    throw new Error(`Internal semantic inventory has a duplicate/invalid id: ${entry?.id}`);
  if (entry.classification !== 'APPLICABLE')
    throw new Error(`Internal semantic inventory entry ${entry.id} is not explicitly classified.`);
  if (!Array.isArray(entry.families) || entry.families.length === 0)
    throw new Error(`Internal semantic inventory entry ${entry.id} has no proof family.`);
  for (const family of entry.families) {
    if (!allowedFamilies.has(family))
      throw new Error(
        `Internal semantic inventory entry ${entry.id} has invalid family ${family}.`,
      );
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20)
    throw new Error(`Internal semantic inventory entry ${entry.id} lacks a concrete reason.`);
  reviewed.set(entry.id, entry);
}

const observed = discoverInternalSemanticSurface();
const observedIds = new Set(observed.map((entry) => entry.id));
const additions = observed.filter((entry) => !reviewed.has(entry.id));
const removals = inventory.entries.filter((entry) => !observedIds.has(entry.id));
const mismatches = [];
for (const entry of observed) {
  const expected = reviewed.get(entry.id);
  if (!expected) continue;
  for (const field of ['path', 'context', 'kind', 'excerpt', 'textDigest']) {
    if (expected[field] !== entry[field]) mismatches.push(`${entry.id}:${field}`);
  }
}

if (additions.length || removals.length || mismatches.length) {
  const describe = (entry) => `${entry.id} (${entry.path} ${entry.context} ${entry.kind})`;
  throw new Error(
    [
      'Internal semantic inventory drifted; classify new/changed library-owned temporal topology before assurance can pass.',
      additions.length ? `added=${additions.map(describe).join('; ')}` : '',
      removals.length ? `removed=${removals.map(describe).join('; ')}` : '',
      mismatches.length ? `changed=${mismatches.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

const familyCounts = {};
for (const entry of inventory.entries) {
  for (const family of entry.families) familyCounts[family] = (familyCounts[family] ?? 0) + 1;
}
console.log(
  `Internal semantic topology: ${observed.length} constructs explicitly classified; families=${JSON.stringify(familyCounts)}.`,
);
