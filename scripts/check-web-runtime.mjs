import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const entry = path.join(dist, 'index.js');
const maxRawBytes = 96 * 1024;
const maxGzipBytes = 24 * 1024;
const seen = new Set();
const stack = [entry];
const parts = [];
const importPattern = /(?:from\s+|import\s*)['"]([^'"]+)['"]/gu;
while (stack.length) {
  const file = stack.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const text = fs.readFileSync(file, 'utf8');
  parts.push(Buffer.from(text));
  for (const match of text.matchAll(importPattern)) {
    const specifier = match[1];
    if (specifier.startsWith('node:'))
      throw new Error(`Default WorkOnce graph imports Node builtin ${specifier}`);
    if (!specifier.startsWith('.'))
      throw new Error(`Default WorkOnce graph imports runtime dependency ${specifier}`);
    const resolved = path.resolve(path.dirname(file), specifier);
    if (!resolved.startsWith(`${dist}${path.sep}`))
      throw new Error(`Default WorkOnce import escapes dist: ${specifier}`);
    stack.push(resolved);
  }
}
const raw = parts.reduce((sum, part) => sum + part.length, 0);
const gzip = zlib.gzipSync(Buffer.concat(parts), { level: 9 }).length;
if (raw > maxRawBytes)
  throw new Error(`Default WorkOnce runtime grew to ${raw} bytes; budget is ${maxRawBytes}`);
if (gzip > maxGzipBytes)
  throw new Error(`Default WorkOnce runtime gzip grew to ${gzip} bytes; budget is ${maxGzipBytes}`);
console.log(
  JSON.stringify({
    webWorker: 'passed',
    target: 'ES2018',
    files: seen.size,
    rawBytes: raw,
    gzipBytes: gzip,
  }),
);
