import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { acquireTlcWorkspace, createTlcWorkspace } from '../scripts/tlc-workspace.mjs';
import { requireSuccessfulProcess } from '../scripts/subprocess-outcome.mjs';

test('concurrent TLC invocations receive disjoint generated-module namespaces', () => {
  const first = createTlcWorkspace('isolation');
  const second = createTlcWorkspace('isolation');
  try {
    assert.notEqual(first, second);
    const sameName = 'WorkOnceExternalSamplesMutant.tla';
    writeFileSync(join(first, sameName), 'FIRST');
    writeFileSync(join(second, sameName), 'SECOND');
    assert.equal(readFileSync(join(first, sameName), 'utf8'), 'FIRST');
    assert.equal(readFileSync(join(second, sameName), 'utf8'), 'SECOND');
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test('inherited TLC workspace must stay inside the private artifact root', () => {
  const outside = mkdtempSync(join(tmpdir(), 'workonce-untrusted-tlc-'));
  const marker = join(outside, 'keep.txt');
  writeFileSync(marker, 'KEEP');
  const previous = process.env.WORKONCE_TLC_ARTIFACT_DIR;
  try {
    process.env.WORKONCE_TLC_ARTIFACT_DIR = outside;
    assert.throws(() => acquireTlcWorkspace('unsafe'), /private descendant of \.artifacts\/tlc/u);
    assert.equal(readFileSync(marker, 'utf8'), 'KEEP');
    assert.equal(existsSync(outside), true);
  } finally {
    if (previous === undefined) delete process.env.WORKONCE_TLC_ARTIFACT_DIR;
    else process.env.WORKONCE_TLC_ARTIFACT_DIR = previous;
    rmSync(outside, { recursive: true, force: true });
  }
});

test('inherited TLC workspace accepts a parent-created private descendant', () => {
  const workspace = createTlcWorkspace('parent');
  const previous = process.env.WORKONCE_TLC_ARTIFACT_DIR;
  try {
    process.env.WORKONCE_TLC_ARTIFACT_DIR = workspace;
    assert.equal(acquireTlcWorkspace('child'), workspace);
  } finally {
    if (previous === undefined) delete process.env.WORKONCE_TLC_ARTIFACT_DIR;
    else process.env.WORKONCE_TLC_ARTIFACT_DIR = previous;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('successful child preserves an inherited parent-owned TLC workspace', () => {
  const workspace = createTlcWorkspace('parent-owned');
  const marker = join(workspace, 'parent-marker.txt');
  writeFileSync(marker, 'KEEP');
  try {
    const helperUrl = new URL('../scripts/tlc-workspace.mjs', import.meta.url).href;
    const code = `
      import { acquireTlcWorkspace, cleanupTlcWorkspaceOnSuccess } from ${JSON.stringify(helperUrl)};
      const workspace = acquireTlcWorkspace('child');
      cleanupTlcWorkspaceOnSuccess(workspace);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: process.cwd(),
      env: { ...process.env, WORKONCE_TLC_ARTIFACT_DIR: workspace },
      encoding: 'utf8',
      timeout: 15_000,
    });
    requireSuccessfulProcess(result, 'tlc workspace cleanup child');
    assert.equal(readFileSync(marker, 'utf8'), 'KEEP');
    assert.equal(existsSync(workspace), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
