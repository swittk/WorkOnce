import { lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const baseDirectory = resolve('.artifacts/tlc');
const ownedWorkspaces = new Set();

function safeLabel(label) {
  return String(label).replace(/[^A-Za-z0-9._-]+/gu, '-');
}

/** Create one private generated-module/metadir root for a TLC proof invocation. */
export function createTlcWorkspace(label = 'tlc') {
  mkdirSync(baseDirectory, { recursive: true });
  const workspace = mkdtempSync(resolve(baseDirectory, `${safeLabel(label)}-`));
  ownedWorkspaces.add(workspace);
  return workspace;
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

function rejectSymlinkAncestors(target) {
  const relativePath = relative(baseDirectory, target);
  let current = baseDirectory;
  for (const segment of relativePath.split(sep)) {
    current = resolve(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error('WORKONCE_TLC_ARTIFACT_DIR must not traverse symbolic links');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

/** Use a parent-provided private TLC workspace or allocate one for this process. */
export function acquireTlcWorkspace(label = 'tlc') {
  const inherited = process.env.WORKONCE_TLC_ARTIFACT_DIR;
  if (!inherited) return createTlcWorkspace(label);
  const workspace = resolve(inherited);
  if (!insideBase(workspace))
    throw new Error('WORKONCE_TLC_ARTIFACT_DIR must be a private descendant of .artifacts/tlc');
  rejectSymlinkAncestors(workspace);
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

/** Remove only this invocation's workspace on success; retain failed workspaces for diagnosis. */
export function cleanupTlcWorkspaceOnSuccess(workspace) {
  if (!ownedWorkspaces.has(workspace)) return;
  process.once('exit', (code) => {
    if (code === 0) rmSync(workspace, { recursive: true, force: true });
  });
}
