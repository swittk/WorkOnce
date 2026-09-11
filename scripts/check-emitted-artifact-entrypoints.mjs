import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function assertEmittedArtifactEntrypoints() {
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
      throw new Error(
        `Emitted-artifact entrypoint '${name}' lost its required build/binding guard.`,
      );
  }

  function parseModule(relative) {
    const filePath = path.join(root, relative);
    const text = fs.readFileSync(filePath, 'utf8');
    return {
      filePath,
      text,
      sourceFile: ts.createSourceFile(
        filePath,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      ),
    };
  }
  function isIdentifierCall(node, name) {
    return (
      ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name
    );
  }
  function topLevelCallPositions(sourceFile, name) {
    const positions = [];
    for (const statement of sourceFile.statements) {
      if (!ts.isExpressionStatement(statement) || !isIdentifierCall(statement.expression, name))
        continue;
      positions.push(statement.expression.getStart(sourceFile));
    }
    return positions;
  }
  function isStaticallyUnreachable(node) {
    let child = node;
    for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
      if (ts.isIfStatement(parent)) {
        if (parent.thenStatement === child && parent.expression.kind === ts.SyntaxKind.FalseKeyword)
          return true;
        if (parent.elseStatement === child && parent.expression.kind === ts.SyntaxKind.TrueKeyword)
          return true;
      }
      if (
        ts.isWhileStatement(parent) &&
        parent.statement === child &&
        parent.expression.kind === ts.SyntaxKind.FalseKeyword
      )
        return true;
    }
    return false;
  }
  function isFunctionBoundary(node) {
    return (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    );
  }
  function immediatelyInvokedFunctionCall(boundary) {
    let expression = boundary;
    let parent = boundary.parent;
    while (parent && ts.isParenthesizedExpression(parent)) {
      expression = parent;
      parent = parent.parent;
    }
    return parent && ts.isCallExpression(parent) && parent.expression === expression
      ? parent
      : undefined;
  }
  function executesDuringModuleInitialization(node, sourceFile) {
    if (isStaticallyUnreachable(node)) return false;
    for (let parent = node.parent; parent && parent !== sourceFile; parent = parent.parent) {
      if (!isFunctionBoundary(parent)) continue;
      if (!immediatelyInvokedFunctionCall(parent)) return false;
    }
    return true;
  }
  function staticImportCount(sourceFile, specifier) {
    let count = 0;
    for (const statement of sourceFile.statements)
      if (ts.isImportDeclaration(statement) && literalText(statement.moduleSpecifier) === specifier)
        count += 1;
    return count;
  }
  function moduleInitializationDynamicImportPositions(sourceFile, specifier) {
    const positions = [];
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        literalText(node.arguments[0]) === specifier &&
        executesDuringModuleInitialization(node, sourceFile)
      )
        positions.push(node.getStart(sourceFile));
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return positions;
  }
  function isReuseCondition(node, sourceFile) {
    return (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      node.left.getText(sourceFile) === 'process.env.WORKONCE_REUSE_BOUND_BUILD' &&
      literalText(node.right) === '1'
    );
  }
  function reuseGuardPositions(sourceFile) {
    const positions = [];
    for (const statement of sourceFile.statements) {
      if (!ts.isIfStatement(statement) || !isReuseCondition(statement.expression, sourceFile))
        continue;
      const body = ts.isBlock(statement.thenStatement)
        ? statement.thenStatement.statements
        : [statement.thenStatement];
      for (const child of body) {
        if (
          !ts.isExpressionStatement(child) ||
          !isIdentifierCall(child.expression, 'assertBuildSourceBinding')
        )
          continue;
        positions.push(child.expression.getStart(sourceFile));
      }
    }
    return positions;
  }
  function reuseEnvironmentAssignments(sourceFile) {
    let count = 0;
    function visit(node) {
      if (
        ts.isPropertyAssignment(node) &&
        ((ts.isIdentifier(node.name) && node.name.text === 'WORKONCE_REUSE_BOUND_BUILD') ||
          (ts.isStringLiteral(node.name) && node.name.text === 'WORKONCE_REUSE_BOUND_BUILD')) &&
        literalText(node.initializer) === '1' &&
        !isStaticallyUnreachable(node)
      )
        count += 1;
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return count;
  }

  if (scripts.prepare !== 'node scripts/prepare-package.mjs')
    throw new Error('Package prepare must route through the source-bound build guard.');
  const prepareModule = parseModule('scripts/prepare-package.mjs');
  const prepareGuards = reuseGuardPositions(prepareModule.sourceFile);
  if (prepareGuards.length !== 1)
    throw new Error('prepare-package.mjs may reuse dist only after verifying the bound build.');
  const consumerSmokeModule = parseModule('scripts/consumer-smoke.mjs');
  if (reuseEnvironmentAssignments(consumerSmokeModule.sourceFile) !== 1)
    throw new Error('Packed consumer must explicitly request source-bound prepare reuse.');

  const formalModule = parseModule('scripts/formal.mjs');
  const formalGuards = topLevelCallPositions(formalModule.sourceFile, 'assertBuildSourceBinding');
  const formalProducerSpecifier = './runtime-boundary-refinement.mjs';
  const formalStaticProducers = staticImportCount(formalModule.sourceFile, formalProducerSpecifier);
  const formalProducers = moduleInitializationDynamicImportPositions(
    formalModule.sourceFile,
    formalProducerSpecifier,
  );
  if (
    formalGuards.length !== 1 ||
    formalStaticProducers !== 0 ||
    formalProducers.length !== 1 ||
    formalGuards[0] > formalProducers[0]
  )
    throw new Error(
      'formal.mjs must verify the bound build before importing compiled observations.',
    );

  const tracesModule = parseModule('scripts/check-bounded-trace-domain.mjs');
  const traceGuards = topLevelCallPositions(tracesModule.sourceFile, 'assertBuildSourceBinding');
  const traceProducerSpecifier = './formal-bounded-refinement-corpus.mjs';
  const traceStaticProducers = staticImportCount(tracesModule.sourceFile, traceProducerSpecifier);
  const traceProducers = moduleInitializationDynamicImportPositions(
    tracesModule.sourceFile,
    traceProducerSpecifier,
  );
  if (
    traceGuards.length !== 1 ||
    traceStaticProducers !== 0 ||
    traceProducers.length !== 1 ||
    traceGuards[0] > traceProducers[0]
  )
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
  const buildPositions = [];
  const buildBatchEnds = [];
  const stepPositions = new Map();
  function recordStep(label, position) {
    const positions = stepPositions.get(label) ?? [];
    positions.push(position);
    stepPositions.set(label, positions);
  }
  function literalText(node) {
    return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      ? node.text
      : undefined;
  }
  function inspectCall(node) {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    const name = node.expression.text;
    if (name === 'runParallel' && ts.isArrayLiteralExpression(node.arguments[0])) {
      let containsBuild = false;
      for (const entry of node.arguments[0].elements) {
        if (
          ts.isCallExpression(entry) &&
          ts.isIdentifier(entry.expression) &&
          entry.expression.text === 'npmParallelEntry' &&
          literalText(entry.arguments[0]) === 'single build'
        )
          containsBuild = true;
        if (!ts.isArrayLiteralExpression(entry)) continue;
        const label = literalText(entry.elements[0]);
        if (label) recordStep(label, entry.getStart(sourceFile));
      }
      if (containsBuild) buildBatchEnds.push(node.getEnd());
      return;
    }
    if (name === 'run') {
      const label = literalText(node.arguments[0]);
      if (label) recordStep(label, node.getStart(sourceFile));
      return;
    }
    if (name !== 'npmParallelEntry') return;
    const label = literalText(node.arguments[0]);
    if (!label) return;
    if (label === 'single build') {
      buildPositions.push(node.getStart(sourceFile));
      return;
    }
    recordStep(label, node.getStart(sourceFile));
  }
  function visit(node) {
    inspectCall(node);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (buildPositions.length !== 1 || buildBatchEnds.length !== 1)
    throw new Error(
      `Full assurance must execute exactly one build barrier; found ${buildPositions.length} build steps in ${buildBatchEnds.length} build batches.`,
    );
  const [buildBatchEnd] = buildBatchEnds;
  const preBuildExemptions = new Set(['format', 'type-contract tests']);
  for (const [step, positions] of stepPositions) {
    if (positions.length !== 1)
      throw new Error(
        `Full assurance step '${step}' must execute exactly once; found ${positions.length}.`,
      );
    if (positions[0] < buildBatchEnd && !preBuildExemptions.has(step))
      throw new Error(
        `Full assurance step '${step}' executes before the single build without a reviewed pre-build exemption.`,
      );
  }
  for (const exemption of preBuildExemptions) {
    const positions = stepPositions.get(exemption) ?? [];
    if (positions.length !== 1 || positions[0] >= buildBatchEnd)
      throw new Error(
        `Reviewed pre-build exemption '${exemption}' is stale or no longer pre-build.`,
      );
  }

  console.log(
    'All supported emitted-artifact proof entrypoints build first or verify the bound build.',
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  assertEmittedArtifactEntrypoints();
