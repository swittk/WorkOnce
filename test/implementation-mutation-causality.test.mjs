import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireCompletedProcess } from '../scripts/subprocess-outcome.mjs';
import { requireCausalMutationFailure } from '../scripts/mutation-file-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// These intentionally wrong expectations fail on the real, unmodified runtime.
// The mutation checker must not credit that pre-existing failure as its own kill.
for (const [family, anchor, replacement] of [
  [
    'lifecycle',
    "e=>e?.code==='stale_attempt','stale fence must reject old renew'",
    "e=>e?.code==='not_a_supported_error','stale fence must reject old renew'",
  ],
  [
    'external',
    "assert.equal(handlers,0,'pre-aborted external lease must not enter its handler');",
    "assert.equal(handlers,-1,'pre-aborted external lease must not enter its handler');",
  ],
]) {
  test(`${family} mutation checker refuses an already-failing real runtime witness`, () => {
    const sourcePath = path.join(root, `scripts/check-${family}-implementation-mutations.mjs`);
    const source = fs.readFileSync(sourcePath, 'utf8');
    assert.equal(source.split(anchor).length, 2, 'bad-witness probe must have one anchor');
    const directory = fs.mkdtempSync(path.join(root, '.artifacts/causality-probe-'));
    try {
      const generated = source
        .replace(anchor, replacement)
        .replace(
          "path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')",
          JSON.stringify(root),
        )
        .replace(
          /from '(\.\/[^']+)'/gu,
          (_match, relative) =>
            `from '${new URL(relative, new URL(`../scripts/check-${family}-implementation-mutations.mjs`, import.meta.url)).href}'`,
        );
      const probe = path.join(directory, 'checker.mjs');
      fs.writeFileSync(probe, generated);
      const result = spawnSync(process.execPath, [probe], {
        cwd: root,
        encoding: 'utf8',
        timeout: 20_000,
      });
      const output = requireCompletedProcess(result, `${family} bad-witness probe`);
      assert.notEqual(
        result.status,
        0,
        'an already-broken witness must never earn mutation credit',
      );
      assert.match(output, /baseline .* exited with status 1/u);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const mode of ['causal', 'broken-baseline', 'unrelated-failure', 'timeout', 'unchanged']) {
  test(`causal mutation restores all targets and rejects ${mode} false credit`, () => {
    const directory = fs.mkdtempSync(path.join(root, '.artifacts/causality-helper-'));
    const first = path.join(directory, 'first.js');
    const second = path.join(directory, 'second.js');
    const originals = new Map([
      [first, 'original-a'],
      [second, 'original-b'],
    ]);
    fs.writeFileSync(first, mode === 'unchanged' ? 'original-a' : 'mutant-a');
    fs.writeFileSync(second, 'original-b');
    const seen = [];
    const run = () => {
      const bytes = fs.readFileSync(first, 'utf8');
      seen.push(bytes);
      assert.equal(fs.readFileSync(second, 'utf8'), 'original-b');
      const baseline = bytes === 'original-a';
      if (mode === 'timeout' && !baseline)
        return {
          status: null,
          signal: 'SIGTERM',
          error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
        };
      return {
        status: baseline && mode !== 'broken-baseline' ? 0 : 1,
        stdout: !baseline && mode === 'unrelated-failure' ? 'wrong cause' : 'intended witness',
        stderr: '',
        signal: null,
      };
    };
    try {
      const probe = () =>
        requireCausalMutationFailure(originals, run, 'probe', /intended witness/u);
      if (mode === 'causal') assert.doesNotThrow(probe);
      else
        assert.throws(
          probe,
          {
            'broken-baseline': /baseline probe exited with status 1/u,
            'unrelated-failure': /failed for an unrelated reason/u,
            timeout: /failed to execute \(ETIMEDOUT\)/u,
            unchanged: /did not change implementation bytes/u,
          }[mode],
        );
      assert.deepEqual(
        seen,
        mode === 'unchanged'
          ? []
          : mode === 'broken-baseline'
            ? ['original-a']
            : ['original-a', 'mutant-a'],
      );
      for (const [file, original] of originals)
        assert.equal(fs.readFileSync(file, 'utf8'), original);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
