import fs from 'node:fs';
import assert from 'node:assert/strict';
import { requireExpectedProcessFailure, requireSuccessfulProcess } from './subprocess-outcome.mjs';

/** Track mutation targets and restore their original bytes if the checker is interrupted. */
export function createMutationFileGuard() {
  const originals = new Map();
  let terminating = false;
  let disposed = false;
  const remember = (file) => {
    if (originals.has(file)) return;
    originals.set(file, fs.existsSync(file) ? fs.readFileSync(file) : undefined);
  };
  const restoreAll = () => {
    const failures = [];
    for (const [file, original] of originals) {
      try {
        if (original === undefined) fs.rmSync(file, { force: true });
        else fs.writeFileSync(file, original);
      } catch (error) {
        failures.push(new Error(`Failed to restore mutation target ${file}`, { cause: error }));
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Mutation file guard could not restore every target');
  };
  const restoreFailureDiagnostic = (error) => {
    const primary = error instanceof Error ? (error.stack ?? error.message) : String(error);
    if (!(error instanceof AggregateError)) return primary;
    return [primary, ...error.errors.map(restoreFailureDiagnostic)].join('\n');
  };
  const reportRestoreFailure = (error) => {
    fs.writeSync(2, `${restoreFailureDiagnostic(error)}\n`);
  };
  const assertActive = () => {
    if (disposed) throw new Error('Mutation file guard is disposed');
  };
  const terminate = (code) => {
    if (terminating) return;
    terminating = true;
    try {
      restoreAll();
    } catch (error) {
      reportRestoreFailure(error);
    } finally {
      process.exit(code);
    }
  };
  const onSigint = () => terminate(130);
  const onSigterm = () => terminate(143);
  const onExit = () => {
    try {
      restoreAll();
    } catch (error) {
      reportRestoreFailure(error);
      process.exitCode = process.exitCode || 1;
    }
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  process.once('exit', onExit);
  return {
    writeFileSync(file, data, options) {
      assertActive();
      remember(file);
      fs.writeFileSync(file, data, options);
    },
    appendFileSync(file, data, options) {
      assertActive();
      remember(file);
      fs.appendFileSync(file, data, options);
    },
    restoreAll() {
      assertActive();
      restoreAll();
    },
    dispose() {
      if (disposed) return;
      restoreAll();
      disposed = true;
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      process.off('exit', onExit);
    },
  };
}

/**
 * Credit an implementation mutation only when the exact same witness first passes
 * against its original bytes. Callers stage the mutation before this operation;
 * both baseline failure and mutant failure restore every original target.
 */
export function requireCausalMutationFailure(originals, run, context, pattern) {
  const mutants = new Map();
  let changed = false;
  for (const [file, original] of originals) {
    const mutant = fs.readFileSync(file);
    mutants.set(file, mutant);
    if (!mutant.equals(Buffer.from(original))) changed = true;
  }
  assert.ok(changed, `${context} did not change implementation bytes`);
  const restore = (contents) => {
    const errors = [];
    for (const [file, bytes] of contents) {
      try {
        fs.writeFileSync(file, bytes);
      } catch (error) {
        errors.push(
          new Error(`Failed to restore causal mutation target ${file}`, { cause: error }),
        );
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Causal mutation restoration failed');
  };
  try {
    restore(originals);
    requireSuccessfulProcess(run(), `baseline ${context}`);
    restore(mutants);
    return requireExpectedProcessFailure(run(), `${context} mutant`, pattern);
  } finally {
    restore(originals);
  }
}
