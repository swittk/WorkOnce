import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverTypeScriptFiles,
  semanticTextDigest,
} from '../scripts/internal-semantic-surface.mjs';

test('internal semantic fingerprints preserve syntax-significant whitespace and line terminators', () => {
  assert.notEqual(semanticTextDigest('/a b/u'), semanticTextDigest('/a  b/u'));
  assert.notEqual(semanticTextDigest('return\nvalue'), semanticTextDigest('return value'));
  assert.equal(semanticTextDigest('x\r\ny'), semanticTextDigest('x\ny'));
});

test('internal semantic source discovery includes nested TypeScript files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workonce-internal-semantic-'));
  try {
    fs.mkdirSync(path.join(directory, 'nested'));
    fs.writeFileSync(path.join(directory, 'root.ts'), 'export const root = 1;\n');
    fs.writeFileSync(path.join(directory, 'nested', 'child.ts'), 'export const child = 1;\n');
    fs.writeFileSync(path.join(directory, 'nested', 'ignored.js'), 'export const ignored = 1;\n');
    assert.deepEqual(discoverTypeScriptFiles(directory), ['nested/child.ts', 'root.ts']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
