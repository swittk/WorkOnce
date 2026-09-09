import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

import { createMutationFileGuard } from './mutation-file-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutationFiles = createMutationFileGuard();
const workPath = path.join(root, 'src/work.ts');
const kernelPath = path.join(root, 'src/kernel.ts');
const originals = new Map([
  [workPath, fs.readFileSync(workPath, 'utf8')],
  [kernelPath, fs.readFileSync(kernelPath, 'utf8')],
]);
function restore() {
  mutationFiles.restoreAll();
}
function expectBindingFailure(label) {
  const result = spawnSync(
    process.execPath,
    ['scripts/check-formal-implementation-conformance.mjs', '--check-read-binding-only'],
    { cwd: root, encoding: 'utf8', env: process.env, timeout: 15_000 },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  requireExpectedProcessFailure(result, `${label} source/model drift mutant unexpectedly passed`);
  assert.match(output, /Bound typed-read\/history semantics changed/u);
  console.log(`Typed-read/history source/model mutation guard rejects ${label}.`);
}

try {
  {
    const original = originals.get(workPath);
    const needle = `  async inspect(key: string): Promise<WorkSnapshot<I, O, R> | undefined> {\n    return (await this.inspectMany([key]))[0];\n  }`;
    const replacement = `  async inspect(key: string): Promise<WorkSnapshot<I, O, R> | undefined> {\n    void key;\n    return (await this.inspectMany([key]))[0];\n  }`;
    assert.equal(
      original.split(needle).length,
      2,
      'typed-read source mutation anchor is stale or not unique',
    );
    mutationFiles.writeFileSync(workPath, original.replace(needle, replacement));
    expectBindingFailure('a changed read method with an unchanged read/history model');
    restore();
  }
  {
    const original = originals.get(kernelPath);
    const needle = '...row.history.slice(-127),';
    assert.equal(
      original.split(needle).length,
      2,
      'history retention source mutation anchor is stale or not unique',
    );
    mutationFiles.writeFileSync(
      kernelPath,
      original.replace(needle, '...row.history.slice(-126),'),
    );
    expectBindingFailure('a changed history-retention rule with an unchanged read/history model');
    restore();
  }
} finally {
  restore();
}
mutationFiles.dispose();
