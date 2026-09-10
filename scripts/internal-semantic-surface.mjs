import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function normalizeName(text) {
  return text.replace(/\s+/gu, ' ').trim();
}
export function semanticTextDigest(text) {
  return digest(text.replace(/\r\n?/gu, '\n').trim());
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
  return normalizeName(node.expression.getText());
}
function newName(node) {
  if (!ts.isNewExpression(node)) return undefined;
  return normalizeName(node.expression.getText());
}
const mutatingMethodNames = new Set([
  'add',
  'clear',
  'copyWithin',
  'delete',
  'fill',
  'pop',
  'push',
  'reverse',
  'set',
  'shift',
  'splice',
  'unshift',
]);
function isPropertyTarget(node) {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

function constructKind(node) {
  if (
    ts.isPropertyDeclaration(node) &&
    !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)
  )
    return 'mutable_property';
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
    isPropertyTarget(node.left)
  )
    return 'property_assignment';
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken) &&
    isPropertyTarget(node.operand)
  )
    return 'property_update';
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    mutatingMethodNames.has(node.expression.name.text)
  )
    return `call_mutator_${node.expression.name.text}`;
  if (ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.Let) !== 0)
    return 'mutable_let';
  if (ts.isWhileStatement(node)) return 'while_loop';
  if (ts.isDoStatement(node)) return 'do_loop';
  if (ts.isForStatement(node)) return 'for_loop';
  if (ts.isForOfStatement(node)) return 'for_of_loop';
  if (ts.isForInStatement(node)) return 'for_in_loop';
  const created = newName(node);
  if (created && ['Map', 'Set', 'WeakMap', 'WeakSet', 'AbortController'].includes(created))
    return `new_${created}`;
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

function compareExact(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function discoverTypeScriptFiles(directory, prefix = '') {
  const files = [];
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareExact(left.name, right.name));
  for (const entry of entries) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory())
      files.push(...discoverTypeScriptFiles(path.join(directory, entry.name), `${relative}/`));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(relative);
  }
  return files;
}

export function discoverInternalSemanticSurface() {
  const srcDir = path.join(root, 'src');
  const files = discoverTypeScriptFiles(srcDir);
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
        const full = node.getText(source).replace(/\r\n?/gu, '\n').trim();
        const excerpt = full.slice(0, 240);
        const textDigest = semanticTextDigest(full);
        const context = contextName(node);
        const key = `${relative}\0${context}\0${kind}\0${textDigest}`;
        const occurrence = (occurrences.get(key) ?? 0) + 1;
        occurrences.set(key, occurrence);
        entries.push({
          id: `${relative}:${context}:${kind}:${digest(key)}:${occurrence}`,
          path: relative,
          context,
          kind,
          excerpt,
          textDigest,
        });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return entries.sort((a, b) => compareExact(a.id, b.id));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(discoverInternalSemanticSurface(), null, 2)}\n`);
}
