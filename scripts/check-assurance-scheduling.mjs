import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = fs.readFileSync(path.join(root, 'scripts/run-assurance.mjs'), 'utf8');
const formalText = fs.readFileSync(path.join(root, 'scripts/formal.mjs'), 'utf8');
const shardModes = [...formalText.matchAll(/runShard\('(--[a-z-]+)'\)/gu)]
  .map((match) => match[1])
  .sort();
assert.deepEqual(
  shardModes,
  ['--non-runtime-only', '--runtime-only'],
  `formal.mjs must use exactly the reviewed two shards; got ${shardModes.join(', ')}`,
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
for (const block of blocks) {
  assert.equal(
    block.text.includes('implementation traces') && block.text.includes('real process faults'),
    false,
    'Implementation traces and real process faults must not be co-scheduled; expanded process tests can cancel under that contention.',
  );
}
console.log(
  'Assurance scheduling serializes mutating guards/process-fault contention and caps TLC overlap at the reviewed two-shard formal runner.',
);
