import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'src/work.ts');
const original = fs.readFileSync(target, 'utf8');
const needle = `  async inspect(key: string): Promise<WorkSnapshot<I, O, R> | undefined> {\n    return (await this.inspectMany([key]))[0];\n  }`;
const replacement = `  async inspect(key: string): Promise<WorkSnapshot<I, O, R> | undefined> {\n    void key;\n    return (await this.inspectMany([key]))[0];\n  }`;
assert.equal(original.includes(needle), true, 'typed-read source mutation anchor is stale');
try {
  fs.writeFileSync(target, original.replace(needle, replacement));
  const result = spawnSync(
    process.execPath,
    ['scripts/check-formal-implementation-conformance.mjs', '--check-read-binding-only'],
    { cwd: root, encoding: 'utf8', env: process.env, timeout: 15_000 },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.notEqual(result.status, 0, 'typed-read source/model drift mutant unexpectedly passed');
  assert.match(output, /Bound typed-read\/definition-fence semantics changed/u);
  console.log(
    'Typed-read source/model mutation guard rejects a changed read method with an unchanged read contract.',
  );
} finally {
  fs.writeFileSync(target, original);
}
