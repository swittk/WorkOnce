import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticTextDigest } from '../scripts/internal-semantic-surface.mjs';

test('internal semantic fingerprints preserve syntax-significant whitespace and line terminators', () => {
  assert.notEqual(semanticTextDigest('/a b/u'), semanticTextDigest('/a  b/u'));
  assert.notEqual(semanticTextDigest('return\nvalue'), semanticTextDigest('return value'));
  assert.equal(semanticTextDigest('x\r\ny'), semanticTextDigest('x\ny'));
});
