import fs from 'node:fs';

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
      remember(file);
      fs.writeFileSync(file, data, options);
    },
    appendFileSync(file, data, options) {
      remember(file);
      fs.appendFileSync(file, data, options);
    },
    restoreAll,
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
