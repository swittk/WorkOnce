import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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

const assurancePath = path.join(root, 'scripts/run-assurance.mjs');
const assurance = fs.readFileSync(assurancePath, 'utf8');
const sourceFile = ts.createSourceFile(
  assurancePath,
  assurance,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
let build = -1;
const consumerPositions = new Map();
function recordConsumer(label, position) {
  const positions = consumerPositions.get(label) ?? [];
  positions.push(position);
  consumerPositions.set(label, positions);
}
function literalText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}
function inspectCall(node) {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
  const name = node.expression.text;
  if (name === 'runNpm' && literalText(node.arguments[0]) === 'single build') {
    build = node.getStart(sourceFile);
    return;
  }
  if (name === 'run') {
    const label = literalText(node.arguments[0]);
    if (label) recordConsumer(label, node.getStart(sourceFile));
    return;
  }
  if (name !== 'runParallel' || !ts.isArrayLiteralExpression(node.arguments[0])) return;
  for (const entry of node.arguments[0].elements) {
    if (!ts.isArrayLiteralExpression(entry)) continue;
    const label = literalText(entry.elements[0]);
    if (label) recordConsumer(label, entry.getStart(sourceFile));
  }
}
function visit(node) {
  inspectCall(node);
  ts.forEachChild(node, visit);
}
visit(sourceFile);
if (build < 0) throw new Error('Full assurance lost its single build step.');
for (const consumer of [
  'implementation traces',
  'real process faults',
  'bounded-domain audit',
  'TLC lifecycle/runtime boundaries + mutation guard',
  'packed consumer',
]) {
  const positions = consumerPositions.get(consumer) ?? [];
  if (positions.length !== 1)
    throw new Error(
      `Full assurance must execute emitted-artifact consumer '${consumer}' exactly once; found ${positions.length}.`,
    );
  if (positions[0] < build)
    throw new Error(
      `Full assurance emitted-artifact consumer '${consumer}' runs before the single build.`,
    );
}

console.log(
  'All supported emitted-artifact proof entrypoints build first or verify the bound build.',
);
