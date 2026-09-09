import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const processScript = packageJson.scripts?.['test:process'] ?? '';
const text = fs.readFileSync(path.join(root, 'scripts/run-assurance.mjs'), 'utf8');
const formalText = fs.readFileSync(path.join(root, 'scripts/formal.mjs'), 'utf8');
const lifecycleFormalText = fs.readFileSync(
  path.join(root, 'scripts/lifecycle-formal.mjs'),
  'utf8',
);
const storageFormalText = fs.readFileSync(path.join(root, 'scripts/storage-formal.mjs'), 'utf8');
const shardModes = [...formalText.matchAll(/runShard\('(--[a-z-]+)'\)/gu)]
  .map((match) => match[1])
  .sort();
assert.deepEqual(
  shardModes,
  ['--non-runtime-only', '--runtime-only'],
  `formal.mjs must use exactly the reviewed two shards; got ${shardModes.join(', ')}`,
);
assert.equal(
  formalText.includes(
    'if (runtimeOnly) {\n  const { runExternalTransportSamples, assertExternalTransportSamples } = await import(',
  ),
  true,
  'External formal family must stay on the reviewed lighter runtime shard.',
);

function parallelBlocks(source) {
  const blocks = [];
  let cursor = 0;
  const marker = 'runParallel([';
  while ((cursor = source.indexOf(marker, cursor)) !== -1) {
    const start = cursor;
    let i = cursor + marker.length;
    let depth = 1;
    let quote;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (; i < source.length && depth > 0; i++) {
      const ch = source[i];
      const next = source[i + 1];
      if (lineComment) {
        if (ch === '\n') lineComment = false;
        continue;
      }
      if (blockComment) {
        if (ch === '*' && next === '/') {
          blockComment = false;
          i += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) quote = undefined;
        continue;
      }
      if (ch === '/' && next === '/') {
        lineComment = true;
        i += 1;
        continue;
      }
      if (ch === '/' && next === '*') {
        blockComment = true;
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '[') depth += 1;
      else if (ch === ']') depth -= 1;
    }
    assert.equal(depth, 0, 'Unbalanced runParallel array in assurance runner.');
    blocks.push({ start, end: i, text: source.slice(start, i) });
    cursor = i;
  }
  return blocks;
}

const blocks = parallelBlocks(text);
assert.match(
  text,
  /name !== 'lifecycle-proof-controls\.test\.mjs'/u,
  'The source-mutating lifecycle proof wrapper must stay out of the read-only unit-test parallel batch.',
);
for (const [label, script] of [
  ['lifecycle proof binding', 'scripts/check-lifecycle-proof-binding.mjs'],
  ['lifecycle source/model mutation guard', 'scripts/check-lifecycle-source-model-mutation.mjs'],
  [
    'lifecycle implementation mutation guards',
    'scripts/check-lifecycle-implementation-mutations.mjs',
  ],
]) {
  const start = text.indexOf(`run('${label}'`);
  assert.notEqual(start, -1, `${label} must remain an explicit serialized full-assurance control`);
  assert.equal(
    text.slice(start, start + 260).includes(`'${script}'`),
    true,
    `${label} must execute ${script}`,
  );
}
const implementationBlocks = blocks.filter((block) =>
  block.text.includes("'implementation traces'"),
);
assert.equal(
  implementationBlocks.length,
  1,
  'Expected implementation traces in exactly one read-only parallel group.',
);
assert.equal(
  implementationBlocks[0].text.includes("'public mapping'"),
  true,
  'Read-only implementation traces must overlap the public mapping batch for assurance performance.',
);
assert.match(
  processScript,
  /node --test --test-concurrency=1 test\/process\/\*\.test\.mjs/u,
  'test:process must serialize real process-fault files; CI concurrency can starve short lease/IPC crash fixtures.',
);
assert.match(
  text,
  /process\.env\.WORKONCE_TLC_WORKERS = tlcWorkers/u,
  'Full assurance must publish its load-aware TLC worker budget to every proof child.',
);
for (const [name, source] of [
  ['formal', formalText],
  ['lifecycle-formal', lifecycleFormalText],
  ['storage-formal', storageFormalText],
]) {
  assert.match(
    source,
    /Number\(process\.env\.WORKONCE_TLC_WORKERS\)/u,
    `${name} must consume the bounded TLC worker budget from the assurance runner`,
  );
}

assert.match(
  text,
  /'type-contract tests'[\s\S]{0,240}?'node_modules\/typescript\/bin\/tsc'[\s\S]{0,160}?'tsconfig\.tests\.json'/u,
  'Assurance must retain the dedicated type-contract test compile when the main source compile is provided by the build.',
);
assert.match(
  text,
  /runNpm\('single build', \['run', 'build'\]\)/u,
  'Assurance must retain the main source build/typecheck exactly once before emitted-artifact consumers.',
);

const mutatingParallel = blocks.flatMap((block) =>
  [...block.text.matchAll(/scripts\/[A-Za-z0-9._/-]*mutation[A-Za-z0-9._/-]*\.mjs/gu)].map(
    (match) => match[0],
  ),
);
assert.deepEqual(
  mutatingParallel,
  [],
  `Source/dist-mutating assurance guards must not run in runParallel: ${mutatingParallel.join(', ')}`,
);
const storageBlocks = blocks.filter((block) => block.text.includes('scripts/storage-formal.mjs'));
assert.equal(storageBlocks.length, 1, 'Expected exactly one storage-formal parallel group.');
assert.equal(
  storageBlocks[0].text.includes('scripts/formal.mjs'),
  false,
  'storage-formal and formal.mjs must never be co-scheduled in one parallel group',
);
const formalRun = text.indexOf(
  "run('TLC lifecycle/runtime/read/policy boundaries + mutation guards'",
);
assert.notEqual(formalRun, -1, 'Expected one serialized top-level formal.mjs run.');
assert.equal(
  formalRun > storageBlocks[0].end,
  true,
  'formal.mjs must start only after the storage-formal parallel batch has completed',
);
const workspaceAudit = text.indexOf("'scripts/check-tlc-workspace-isolation.mjs'");
assert.notEqual(
  workspaceAudit,
  -1,
  'Expected the TLC workspace isolation audit in full assurance.',
);
assert.equal(
  workspaceAudit < storageBlocks[0].start,
  true,
  'TLC workspace isolation must be audited before any formal family runs',
);
for (const block of blocks) {
  assert.equal(
    block.text.includes('real process faults'),
    false,
    'Real process faults must run outside runParallel; constrained runners can starve crash-fixture IPC under compiler contention.',
  );
}
assert.match(
  text,
  /run\('real process faults',[\s\S]{0,180}'--test-concurrency',[\s\S]{0,80}'3'/u,
  'HPSERVER full assurance must cap process-fault file concurrency at three.',
);
console.log(
  'Assurance scheduling preserves split source/type-contract checks, serializes mutating guards/process faults and cross-family TLC, while private workspaces isolate independent proof invocations.',
);
