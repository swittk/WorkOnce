import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireTlcWorkspace, createTlcWorkspace } from '../scripts/tlc-workspace.mjs';

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
