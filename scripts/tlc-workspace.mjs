import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const baseDirectory = resolve('.artifacts/tlc');

function safeLabel(label) {
  return String(label).replace(/[^A-Za-z0-9._-]+/gu, '-');
}

/** Create one private generated-module/metadir root for a TLC proof invocation. */
export function createTlcWorkspace(label = 'tlc') {
  mkdirSync(baseDirectory, { recursive: true });
  return mkdtempSync(resolve(baseDirectory, `${safeLabel(label)}-`));
}

function insideBase(target) {
  const relativePath = relative(baseDirectory, target);
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

/** Use a parent-provided private TLC workspace or allocate one for this process. */
export function acquireTlcWorkspace(label = 'tlc') {
  const inherited = process.env.WORKONCE_TLC_ARTIFACT_DIR;
  if (!inherited) return createTlcWorkspace(label);
  const workspace = resolve(inherited);
  if (!insideBase(workspace))
    throw new Error('WORKONCE_TLC_ARTIFACT_DIR must be a private descendant of .artifacts/tlc');
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

/** Remove only this invocation's workspace on success; retain failed workspaces for diagnosis. */
export function cleanupTlcWorkspaceOnSuccess(workspace) {
  process.once('exit', (code) => {
    if (code === 0) rmSync(workspace, { recursive: true, force: true });
  });
}
