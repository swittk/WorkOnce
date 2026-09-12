import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';

/** Discover every package TypeScript source file so new public modules cannot evade documentation checks. */
function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

/** Return whether one declaration has an explicit export modifier. */
function isExported(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/** Return whether a class member is part of the externally visible contract. */
function isPublicClassMember(node) {
  return !(
    node.modifiers?.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.PrivateKeyword ||
        modifier.kind === ts.SyntaxKind.ProtectedKeyword,
    ) ?? false
  );
}

/** Return whether one exported top-level declaration requires purpose JSDoc. */
function exportedDeclarationNeedsDoc(node) {
  return (
    isExported(node) &&
    (ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isFunctionDeclaration(node))
  );
}

/** Return whether one direct member of an exported named contract requires purpose JSDoc. */
function exportedMemberNeedsDoc(node) {
  if (ts.isEnumMember(node) || ts.isPropertySignature(node) || ts.isMethodSignature(node))
    return true;
  if (
    (ts.isPropertyDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node)) &&
    isPublicClassMember(node)
  )
    return true;
  return false;
}

/** Return a readable declaration name for documentation failures. */
function declarationName(node) {
  if ('name' in node && node.name) return node.name.getText();
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  return ts.SyntaxKind[node.kind] ?? 'declaration';
}

/** Return whether TypeScript attached a JSDoc block to this declaration. */
function hasDoc(node) {
  return ts.getJSDocCommentsAndTags(node).length > 0;
}

/** Boilerplate phrases that technically satisfy presence while adding no useful purpose information. */
const meaningless = [
  /value carried by/giu,
  /execute this callback/giu,
  /operation exposed by/giu,
  /value for this/giu,
  /does the thing/giu,
];

/** Check one declaration for missing or tautological purpose documentation. */
function checkNode(sourceFile, node, missing, tautological) {
  if (!hasDoc(node)) {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    missing.push(
      `${relative(process.cwd(), sourceFile.fileName)}:${line} ${declarationName(node)}`,
    );
    return;
  }
  for (const doc of ts.getJSDocCommentsAndTags(node)) {
    const text = doc.getText(sourceFile);
    for (const pattern of meaningless) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        const line = sourceFile.getLineAndCharacterOfPosition(doc.getStart(sourceFile)).line + 1;
        tautological.push(
          `${relative(process.cwd(), sourceFile.fileName)}:${line} ${declarationName(node)}`,
        );
      }
    }
  }
}

/** Audit one exported declaration plus only its direct named public contract members. */
function auditExport(sourceFile, root, missing, tautological) {
  if (!exportedDeclarationNeedsDoc(root)) return;
  checkNode(sourceFile, root, missing, tautological);
  if (
    ts.isInterfaceDeclaration(root) ||
    ts.isClassDeclaration(root) ||
    ts.isEnumDeclaration(root)
  ) {
    for (const member of root.members) {
      if (exportedMemberNeedsDoc(member)) checkNode(sourceFile, member, missing, tautological);
    }
  }
}

test('every exported WorkOnce contract has purpose JSDoc', () => {
  const missing = [];
  const tautological = [];
  for (const fileName of sourceFiles('src')) {
    const absolute = resolve(fileName);
    const sourceFile = ts.createSourceFile(
      absolute,
      readFileSync(absolute, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const statement of sourceFile.statements) {
      if (isExported(statement)) auditExport(sourceFile, statement, missing, tautological);
    }
  }
  assert.deepEqual(missing, [], `Missing purpose JSDoc:\n${missing.join('\n')}`);
  assert.deepEqual(tautological, [], `Tautological purpose JSDoc:\n${tautological.join('\n')}`);
});
