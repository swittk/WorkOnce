import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stampPath = path.join(root, '.artifacts/build-source-binding.json');
const buildInputFiles = [
  'tsconfig.json',
  'tsconfig.cjs.json',
  'package.json',
  'scripts/cjs-package.mjs',
];
const artifactRoots = ['dist', 'dist-cjs'];

function recursiveFiles(directory, accept = () => true) {
  const found = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && accept(entry.name, absolute))
        found.push(path.relative(root, absolute));
    }
  };
  visit(directory);
  return found;
}

function sourceFiles() {
  return [
    ...recursiveFiles(path.join(root, 'src'), (name) => name.endsWith('.ts')),
    ...buildInputFiles,
  ].sort();
}

function artifactFiles() {
  const found = [];
  for (const relativeRoot of artifactRoots) {
    const absoluteRoot = path.join(root, relativeRoot);
    if (!fs.existsSync(absoluteRoot))
      throw new Error(`Compiled WorkOnce artifact directory is missing: ${relativeRoot}`);
    found.push(...recursiveFiles(absoluteRoot));
  }
  return found.sort();
}

function digestFiles(files) {
  const hash = crypto.createHash('sha256');
  for (const relative of files) {
    const content = fs.readFileSync(path.join(root, relative));
    hash.update(relative);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function currentBuildSourceBinding() {
  const files = sourceFiles();
  const artifacts = artifactFiles();
  return {
    version: 2,
    files,
    sourceDigest: digestFiles(files),
    artifactFiles: artifacts,
    artifactDigest: digestFiles(artifacts),
  };
}

export function writeBuildSourceBinding() {
  const binding = currentBuildSourceBinding();
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  fs.writeFileSync(stampPath, `${JSON.stringify(binding, null, 2)}\n`);
  return binding;
}

function sameList(left, right) {
  return Array.isArray(left) && JSON.stringify(left) === JSON.stringify(right);
}

export function assertBuildSourceBinding() {
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  } catch {
    throw new Error(
      'Compiled WorkOnce build has no valid source binding; run npm run build first.',
    );
  }
  const current = currentBuildSourceBinding();
  if (
    stored?.version !== current.version ||
    !sameList(stored.files, current.files) ||
    stored.sourceDigest !== current.sourceDigest
  ) {
    throw new Error(
      'Stale compiled WorkOnce build does not match current TypeScript sources; run npm run build.',
    );
  }
  if (
    !sameList(stored.artifactFiles, current.artifactFiles) ||
    stored.artifactDigest !== current.artifactDigest
  ) {
    throw new Error(
      'Compiled WorkOnce artifacts changed after the bound build; run npm run build before using emitted-artifact proofs.',
    );
  }
  return current;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--write')) {
    const binding = writeBuildSourceBinding();
    if (process.argv.includes('--verbose'))
      console.log(
        `Bound compiled WorkOnce output to ${binding.files.length} source/config files and ${binding.artifactFiles.length} emitted files.`,
      );
  } else {
    assertBuildSourceBinding();
    console.log(
      'Compiled WorkOnce output and emitted artifacts match the bound TypeScript sources.',
    );
  }
}
