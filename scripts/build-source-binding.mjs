import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stampPath = path.join(root, '.artifacts/build-source-binding.json');
const configFiles = ['tsconfig.json', 'tsconfig.cjs.json'];

function sourceFiles() {
  const found = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.ts'))
        found.push(path.relative(root, absolute));
    }
  };
  visit(path.join(root, 'src'));
  return [...found, ...configFiles].sort();
}

function sourceDigest(files = sourceFiles()) {
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
  return { version: 1, files, sourceDigest: sourceDigest(files) };
}

export function writeBuildSourceBinding() {
  const binding = currentBuildSourceBinding();
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  fs.writeFileSync(stampPath, `${JSON.stringify(binding, null, 2)}\n`);
  return binding;
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
  const sameFiles =
    stored?.version === current.version &&
    Array.isArray(stored.files) &&
    JSON.stringify(stored.files) === JSON.stringify(current.files);
  if (!sameFiles || stored.sourceDigest !== current.sourceDigest) {
    throw new Error(
      'Stale compiled WorkOnce build does not match current TypeScript sources; run npm run build.',
    );
  }
  return current;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--write')) {
    const binding = writeBuildSourceBinding();
    if (process.argv.includes('--verbose'))
      console.log(`Bound compiled WorkOnce output to ${binding.files.length} source/config files.`);
  } else {
    assertBuildSourceBinding();
    console.log('Compiled WorkOnce output matches current TypeScript sources.');
  }
}
