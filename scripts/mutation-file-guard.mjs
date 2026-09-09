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
    for (const [file, original] of originals) {
      if (original === undefined) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, original);
    }
  };
  const terminate = (code) => {
    if (terminating) return;
    terminating = true;
    try {
      restoreAll();
    } finally {
      process.exit(code);
    }
  };
  const onSigint = () => terminate(130);
  const onSigterm = () => terminate(143);
  const onExit = () => restoreAll();
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
      disposed = true;
      restoreAll();
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      process.off('exit', onExit);
    },
  };
}
