import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = pkg.scripts ?? {};

const requiredPrefixes = {
  test: 'npm run build && ',
  'test:process': 'node scripts/build-source-binding.mjs && ',
  formal: 'node scripts/formal.mjs',
  'test:consumer': 'npm run build && ',
  bench: 'npm run build && ',
  'assurance:traces': 'node scripts/check-bounded-trace-domain.mjs',
  'assurance:update': 'npm run build && ',
  'assurance:update:ack': 'npm run build && ',
  'test:web': 'npm run build && ',
};
for (const [name, prefix] of Object.entries(requiredPrefixes)) {
  const command = scripts[name];
  if (typeof command !== 'string' || !command.startsWith(prefix))
    throw new Error(`Emitted-artifact entrypoint '${name}' lost its required build/binding guard.`);
}

const formal = fs.readFileSync(path.join(root, 'scripts/formal.mjs'), 'utf8');
const formalGuard = formal.indexOf('assertBuildSourceBinding();');
const formalProducer = formal.indexOf("import('./runtime-boundary-refinement.mjs')");
if (formalGuard < 0 || formalProducer < 0 || formalGuard > formalProducer)
  throw new Error('formal.mjs must verify the bound build before importing compiled observations.');

const traces = fs.readFileSync(path.join(root, 'scripts/check-bounded-trace-domain.mjs'), 'utf8');
const traceGuard = traces.indexOf('assertBuildSourceBinding();');
const traceProducer = traces.indexOf("import('./formal-bounded-refinement-corpus.mjs')");
if (traceGuard < 0 || traceProducer < 0 || traceGuard > traceProducer)
  throw new Error(
    'check-bounded-trace-domain.mjs must verify the bound build before importing compiled traces.',
  );

const assurance = fs.readFileSync(path.join(root, 'scripts/run-assurance.mjs'), 'utf8');
const build = assurance.indexOf("runNpm('single build'");
for (const consumer of [
  "run('implementation traces'",
  "run('real process faults'",
  "run('bounded-domain audit'",
  "run('TLC lifecycle/runtime boundaries + mutation guard'",
  "run('packed consumer'",
]) {
  const index = assurance.indexOf(consumer);
  if (build < 0 || index < 0 || build > index)
    throw new Error(`Full assurance must build before emitted-artifact consumer ${consumer}.`);
}

console.log(
  'All supported emitted-artifact proof entrypoints build first or verify the bound build.',
);
