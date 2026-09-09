import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactDir = path.join(root, '.artifacts');
const invalidJar = path.join(artifactDir, 'invalid-tlc-classification.jar');
fs.mkdirSync(artifactDir, { recursive: true });
try {
  fs.writeFileSync(invalidJar, 'not a jar');
  const result = spawnSync(process.execPath, ['scripts/formal.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TLA2TOOLS_JAR: invalidJar },
    timeout: 15_000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  requireExpectedProcessFailure(result, 'invalid TLC jar formal-assurance probe');
  assert.match(output, /TLC infrastructure failure \(jvm_or_classpath\)/u);
  assert.doesNotMatch(output, /TLC semantic counterexample/u);
  console.log('Live TLC invalid-jar probe is classified as infrastructure failure, not semantics.');
} finally {
  fs.rmSync(invalidJar, { force: true });
}
