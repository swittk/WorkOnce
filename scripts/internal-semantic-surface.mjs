import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function normalize(text) {
  return text.replace(/\s+/gu, ' ').trim();
}
function digest(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}
function contextName(node) {
  let current = node.parent;
  while (current) {
    if (ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current))
      return current.name?.getText() ?? '<anonymous>';
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent)) return parent.name.getText();
      if (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent))
        return parent.name.getText();
      return '<callback>';
    }
    if (ts.isConstructorDeclaration(current)) return 'constructor';
    current = current.parent;
  }
  return '<module>';
}
function callName(node) {
  if (!ts.isCallExpression(node)) return undefined;
  return normalize(node.expression.getText());
}
function newName(node) {
  if (!ts.isNewExpression(node)) return undefined;
  return normalize(node.expression.getText());
}
function constructKind(node) {
  if (
    ts.isPropertyDeclaration(node) &&
    !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)
  )
    return 'mutable_property';
  if (ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.Let) !== 0)
    return 'mutable_let';
  if (ts.isWhileStatement(node)) return 'while_loop';
  if (ts.isDoStatement(node)) return 'do_loop';
  if (ts.isForStatement(node)) return 'for_loop';
  if (ts.isForOfStatement(node)) return 'for_of_loop';
  if (ts.isForInStatement(node)) return 'for_in_loop';
  const created = newName(node);
  if (created && ['Map', 'Set', 'AbortController'].includes(created)) return `new_${created}`;
  const called = callName(node);
  if (
    called &&
    (called === 'setTimeout' ||
      called === 'Promise.race' ||
      called === 'Promise.all' ||
      called === 'Promise.allSettled' ||
      called.endsWith('.sort') ||
      called.endsWith('.slice'))
  )
    return `call_${called}`;
  return undefined;
}

export function discoverInternalSemanticSurface() {
  const srcDir = path.join(root, 'src');
  const files = fs
    .readdirSync(srcDir)
    .filter((name) => name.endsWith('.ts'))
    .sort();
  const entries = [];
  const occurrences = new Map();
  for (const name of files) {
    const relative = `src/${name}`;
    const text = fs.readFileSync(path.join(root, relative), 'utf8');
    const source = ts.createSourceFile(
      relative,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    function visit(node) {
      const kind = constructKind(node);
      if (kind) {
        const excerpt = normalize(node.getText(source)).slice(0, 240);
        const context = contextName(node);
        const key = `${relative}\0${context}\0${kind}\0${excerpt}`;
        const occurrence = (occurrences.get(key) ?? 0) + 1;
        occurrences.set(key, occurrence);
        entries.push({
          id: `${relative}:${context}:${kind}:${digest(key)}:${occurrence}`,
          path: relative,
          context,
          kind,
          excerpt,
        });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(discoverInternalSemanticSurface(), null, 2)}\n`);
}
