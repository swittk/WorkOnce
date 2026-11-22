import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverInternalSemanticTopology,
  unclassifiedCallSurfaceDigest,
} from './internal-semantic-surface.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventoryPath = path.join(root, 'assurance/internal-semantic-inventory.json');
const allowedFamilies = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
const write = process.argv.includes('--write');

function classifyRetentionTopology(entry) {
  if (
    (entry.path === 'src/cas.ts' &&
      /expectedIncarnation|supportsRetention|delete/u.test(entry.excerpt)) ||
    (entry.path === 'src/memory.ts' && /expiresAt|rows\.delete/u.test(entry.excerpt)) ||
    (entry.path === 'src/sqlite.ts' && /expires_at|expiresAt/u.test(entry.excerpt)) ||
    (entry.path === 'src/storage-validation.ts' &&
      /retention|incarnation|expires/u.test(entry.excerpt))
  )
    return {
      families: ['G'],
      reason:
        'Finite-retention comparison, indexed expiry, validation, and physical deletion are storage-family G temporal semantics.',
    };
  if (entry.path === 'src/external.ts' && /incarnation/u.test(entry.excerpt))
    return {
      families: ['D'],
      reason:
        'External claim identity now includes creation incarnation; external-executor family D owns stale lease isolation.',
    };
  if (entry.path === 'src/kernel.ts' && entry.context === 'expiresAt')
    return {
      families: ['A', 'G'],
      reason:
        'Terminal expiry derives from lifecycle state and storage time; lifecycle family A and storage family G share this boundary.',
    };
  if (
    entry.path === 'src/kernel.ts' &&
    entry.context === 'settleRecord' &&
    /incarnation|outcome\.next/u.test(entry.excerpt)
  )
    return entry.kind === 'property_assignment'
      ? {
          families: ['A', 'F'],
          reason:
            'Settlement receipt incarnation binds lifecycle ownership and retry replay identity across families A and F.',
        }
      : {
          families: ['A', 'B', 'F'],
          reason:
            'Settlement validates lifecycle, retry policy, and durable finite follow-up intent across families A, B, and F.',
        };
  if (
    entry.path === 'src/work.ts' &&
    entry.context === 'claim' &&
    /incarnation/u.test(entry.excerpt)
  )
    return {
      families: ['A'],
      reason:
        'Claim scanning now fences candidate incarnation as part of durable lifecycle ownership in family A.',
    };
  if (entry.path === 'src/work.ts' && entry.context === 'dispatch' && entry.kind === 'for_of_loop')
    return {
      families: ['B'],
      reason:
        'Dispatch iteration and acknowledgement include parent incarnation fencing; continuation family B owns this topology.',
    };
  if (entry.path === 'src/work.ts' && ['pruneExpired', 'runPruner'].includes(entry.context))
    return {
      families: ['A', 'G'],
      reason:
        'Bounded pruning coordinates terminal lifecycle eligibility with atomic storage deletion across families A and G.',
    };
  if (
    entry.path === 'src/work.ts' &&
    entry.context === 'constructor' &&
    entry.kind === 'property_assignment' &&
    entry.excerpt === "this.name = 'WorkRetentionError'"
  )
    return {
      families: ['A', 'G'],
      reason:
        'The ES2018-compatible batch deletion error retains all failed retention attempts for observable recovery without stopping healthy work.',
    };
  if (
    entry.path === 'src/work.ts' &&
    ((entry.context === 'request' && /retention/u.test(entry.excerpt)) ||
      (['retry', 'rerun', 'restart'].includes(entry.context) &&
        /checkedIncarnation/u.test(entry.excerpt)))
  )
    return {
      families: ['A'],
      reason:
        'Request retention and incarnation-checked generation resets are durable lifecycle identity semantics in family A.',
    };
  if (
    entry.path === 'src/conformance.ts' &&
    entry.kind === 'call_Promise.all' &&
    /first\.heartbeat\(run\.ref\).*second\.heartbeat\(run\.ref\)/su.test(entry.excerpt)
  )
    return {
      families: ['A', 'G'],
      reason:
        'Simultaneous heartbeat conformance tests lifecycle ownership and durable atomic renewal across independent handles.',
    };
  if (
    entry.path === 'src/conformance.ts' &&
    entry.kind === 'call_Promise.allSettled' &&
    /old\.settle\(old\.succeed\(\)\).*second\.claim/su.test(entry.excerpt)
  )
    return {
      families: ['A', 'G', 'I'],
      reason:
        'Competing late settlement and timed takeover are an executable atomic winner witness for lifecycle, storage and assurance infrastructure.',
    };
  if (
    entry.path === 'src/conformance.ts' &&
    entry.kind === 'mutable_let' &&
    entry.excerpt === 'let dropped = false;'
  )
    return {
      families: ['A', 'B', 'G'],
      reason:
        'The injected lost-ack flag makes terminal receipt replay and follow-up delivery observable without altering the backing store.',
    };
  if (
    entry.path === 'src/conformance.ts' &&
    entry.context === 'atomic' &&
    entry.kind === 'identifier_assignment' &&
    entry.excerpt === 'dropped = true'
  )
    return {
      families: ['A', 'B', 'G'],
      reason:
        'The test drops exactly one acknowledgement after an atomic success commit to verify durable receipt and continuation recovery.',
    };
  return undefined;
}

function writeReviewedInventory() {
  const previous = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  const topology = discoverInternalSemanticTopology();
  const previousById = new Map(previous.entries.map((entry) => [entry.id, entry]));
  const carriedByGroup = new Map();
  for (const entry of previous.entries) {
    const key = `${entry.path}\0${entry.context}\0${entry.kind}`;
    const group = carriedByGroup.get(key) ?? [];
    group.push(entry);
    carriedByGroup.set(key, group);
  }
  for (const group of carriedByGroup.values())
    group.sort((left, right) => left.ordinal - right.ordinal);
  const used = new Set();
  const entries = topology.entries.map((entry) => {
    let reviewed = previousById.get(entry.id);
    if (reviewed) used.add(reviewed.id);
    let classification = classifyRetentionTopology(entry);
    if (!reviewed && !classification) {
      const key = `${entry.path}\0${entry.context}\0${entry.kind}`;
      reviewed = (carriedByGroup.get(key) ?? []).find((candidate) => !used.has(candidate.id));
      if (reviewed) used.add(reviewed.id);
    }
    classification ??= reviewed
      ? { families: reviewed.families, reason: reviewed.reason }
      : undefined;
    if (!classification)
      throw new Error(
        `No deliberate topology classification for ${entry.path}:${entry.context}:${entry.kind}`,
      );
    return {
      ...entry,
      families: classification.families,
      classification: 'APPLICABLE',
      reason: classification.reason,
    };
  });
  const value = {
    ...previous,
    unclassifiedCallSurface: {
      count: topology.unclassifiedCalls.length,
      digest: unclassifiedCallSurfaceDigest(topology.unclassifiedCalls),
    },
    entries,
  };
  fs.writeFileSync(inventoryPath, `${JSON.stringify(value, null, 2)}\n`);
  console.log(
    `Wrote assurance/internal-semantic-inventory.json with ${entries.length} deliberately classified constructs.`,
  );
}

export function assertInternalSemanticInventory() {
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.entries))
    throw new Error('Internal semantic inventory has an unsupported schema.');
  if (
    !inventory.unclassifiedCallSurface ||
    !Number.isSafeInteger(inventory.unclassifiedCallSurface.count) ||
    typeof inventory.unclassifiedCallSurface.digest !== 'string'
  )
    throw new Error('Internal semantic inventory lacks its fail-closed unclassified-call surface.');

  const reviewed = new Map();
  for (const entry of inventory.entries) {
    if (!entry || typeof entry.id !== 'string' || reviewed.has(entry.id))
      throw new Error(`Internal semantic inventory has a duplicate/invalid id: ${entry?.id}`);
    if (entry.classification !== 'APPLICABLE')
      throw new Error(
        `Internal semantic inventory entry ${entry.id} is not explicitly classified.`,
      );
    if (!Number.isSafeInteger(entry.ordinal) || entry.ordinal < 1)
      throw new Error(`Internal semantic inventory entry ${entry.id} lacks a semantic ordinal.`);
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

  const topology = discoverInternalSemanticTopology();
  const observed = topology.entries;
  const observedIds = new Set(observed.map((entry) => entry.id));
  const additions = observed.filter((entry) => !reviewed.has(entry.id));
  const removals = inventory.entries.filter((entry) => !observedIds.has(entry.id));
  const mismatches = [];
  for (const entry of observed) {
    const expected = reviewed.get(entry.id);
    if (!expected) continue;
    for (const field of ['path', 'context', 'kind', 'ordinal', 'excerpt', 'textDigest']) {
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

  const unclassifiedCallSurface = {
    count: topology.unclassifiedCalls.length,
    digest: unclassifiedCallSurfaceDigest(topology.unclassifiedCalls),
  };
  if (
    inventory.unclassifiedCallSurface.count !== unclassifiedCallSurface.count ||
    inventory.unclassifiedCallSurface.digest !== unclassifiedCallSurface.digest
  )
    throw new Error(
      `Internal semantic unclassified call surface drifted; review every new/changed call before refreshing the inventory. expected=${JSON.stringify(inventory.unclassifiedCallSurface)} observed=${JSON.stringify(unclassifiedCallSurface)}`,
    );

  const familyCounts = {};
  for (const entry of inventory.entries) {
    for (const family of entry.families) familyCounts[family] = (familyCounts[family] ?? 0) + 1;
  }
  console.log(
    `Internal semantic topology: ${observed.length} constructs explicitly classified; families=${JSON.stringify(familyCounts)}.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (write) writeReviewedInventory();
  assertInternalSemanticInventory();
}
