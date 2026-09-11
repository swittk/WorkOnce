import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createMutationFileGuard } from '../scripts/mutation-file-guard.mjs';

async function waitForReady(child) {
  let output = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('mutation guard child did not become ready')),
      5000,
    );
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('ready\n')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (!output.includes('ready\n')) {
        clearTimeout(timeout);
        reject(new Error(`mutation guard child exited early: ${String(code)} ${String(signal)}`));
      }
    });
  });
}

for (const [signal, expectedCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  test(`mutation file guard restores original bytes on ${signal}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workonce-mutation-guard-'));
    const target = join(directory, 'tracked.txt');
    writeFileSync(target, 'original\n');
    const guardModule = new URL('../scripts/mutation-file-guard.mjs', import.meta.url).href;
    const code = `
      import { createMutationFileGuard } from ${JSON.stringify(guardModule)};
      const guard = createMutationFileGuard();
      guard.writeFileSync(process.env.WORKONCE_MUTATION_TARGET, 'mutated\\n');
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: process.cwd(),
      env: { ...process.env, WORKONCE_MUTATION_TARGET: target },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitForReady(child);
      assert.equal(readFileSync(target, 'utf8'), 'mutated\n');
      child.kill(signal);
      const [exitCode, exitSignal] = await once(child, 'exit', {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(exitSignal, null);
      assert.equal(exitCode, expectedCode);
      assert.equal(readFileSync(target, 'utf8'), 'original\n');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) }).catch(
          () => undefined,
        );
        child.kill('SIGKILL');
        await exited;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('mutation file guard synchronously reports a signal-path restore failure to piped stderr', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-mutation-signal-failure-'));
  const target = join(directory, 'tracked.txt');
  writeFileSync(target, 'original\n');
  const guardModule = new URL('../scripts/mutation-file-guard.mjs', import.meta.url).href;
  const code = `
    import { createMutationFileGuard } from ${JSON.stringify(guardModule)};
    const guard = createMutationFileGuard();
    guard.writeFileSync(process.env.WORKONCE_MUTATION_TARGET, 'mutated\\n');
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: process.cwd(),
    env: { ...process.env, WORKONCE_MUTATION_TARGET: target },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    await waitForReady(child);
    rmSync(target);
    mkdirSync(target);
    child.kill('SIGTERM');
    const [exitCode, exitSignal] = await once(child, 'exit', {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(exitSignal, null);
    assert.equal(exitCode, 143);
    assert.match(stderr, /Failed to restore mutation target/u);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) }).catch(
        () => undefined,
      );
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mutation file guard restores original bytes on unhandled exit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-mutation-exit-'));
  const target = join(directory, 'tracked.txt');
  writeFileSync(target, 'original\n');
  const guardModule = new URL('../scripts/mutation-file-guard.mjs', import.meta.url).href;
  const code = `
    import { createMutationFileGuard } from ${JSON.stringify(guardModule)};
    const guard = createMutationFileGuard();
    guard.writeFileSync(process.env.WORKONCE_MUTATION_TARGET, 'mutated\\n');
    throw new Error('checker failed before dispose');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: process.cwd(),
    env: { ...process.env, WORKONCE_MUTATION_TARGET: target },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const [exitCode] = await once(child, 'exit', { signal: AbortSignal.timeout(5000) });
    assert.notEqual(exitCode, 0);
    assert.equal(readFileSync(target, 'utf8'), 'original\n');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) }).catch(
        () => undefined,
      );
      child.kill('SIGKILL');
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mutation file guard restores remembered files during normal disposal', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-mutation-dispose-'));
  const existing = join(directory, 'existing.txt');
  const created = join(directory, 'created.txt');
  writeFileSync(existing, 'original\n');
  const guard = createMutationFileGuard();
  try {
    guard.writeFileSync(existing, 'mutated\n');
    guard.writeFileSync(created, 'new\n');
    assert.equal(readFileSync(existing, 'utf8'), 'mutated\n');
    assert.equal(existsSync(created), true);
    guard.dispose();
    assert.equal(readFileSync(existing, 'utf8'), 'original\n');
    assert.equal(existsSync(created), false);
  } finally {
    guard.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mutation file guard restores later files even when an earlier restore fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workonce-mutation-partial-restore-'));
  const blocked = join(directory, 'blocked.txt');
  const later = join(directory, 'later.txt');
  writeFileSync(blocked, 'blocked-original\n');
  writeFileSync(later, 'later-original\n');
  const guard = createMutationFileGuard();
  try {
    guard.writeFileSync(blocked, 'blocked-mutated\n');
    guard.writeFileSync(later, 'later-mutated\n');
    rmSync(blocked);
    mkdirSync(blocked);
    assert.throws(
      () => guard.restoreAll(),
      (error) =>
        error instanceof AggregateError && /could not restore every target/u.test(error.message),
    );
    assert.equal(readFileSync(later, 'utf8'), 'later-original\n');
    rmSync(blocked, { recursive: true, force: true });
    writeFileSync(blocked, 'blocked-original\n');
    guard.dispose();
  } finally {
    try {
      guard.dispose();
    } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});
