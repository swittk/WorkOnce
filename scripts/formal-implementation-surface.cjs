const ts = require('typescript');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const sourceRoot = path.resolve(root, 'src');
const sourcePrefix = `${path.normalize(sourceRoot)}${path.sep}`;
if (process.argv.includes('--self-test-source-paths')) {
  const canonical = portableSourcePath(path.join(root, 'node_modules/typescript/lib/lib.es5.d.ts'));
  const sibling = portableSourcePath(
    path.join(
      path.dirname(root),
      'workonce-proof-worktree/node_modules/typescript/lib/lib.es5.d.ts',
    ),
  );
  const sharedInstall = portableSourcePath(
    path.join(path.dirname(root), 'WorkOnces/node_modules/typescript/lib/lib.es5.d.ts'),
  );
  if (canonical !== 'node_modules/typescript/lib/lib.es5.d.ts')
    throw new Error(`Unexpected canonical TypeScript lib source path: ${canonical}`);
  if (sibling !== canonical || sharedInstall !== canonical)
    throw new Error(
      `TypeScript lib source identity depends on worktree/install topology: ${JSON.stringify({ canonical, sibling, sharedInstall })}`,
    );
  if (portableSourcePath(path.join(root, 'src/work.ts')) !== 'src/work.ts')
    throw new Error('Package-owned source identity no longer stays repository-relative.');
  console.log(
    'Compiler source paths are stable across authoritative, sibling-worktree, and shared-install layouts.',
  );
  process.exit(0);
}

const configPath = path.join(root, 'tsconfig.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath);
if (parsed.errors.length) {
  throw new Error(
    parsed.errors
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
      .join('\n'),
  );
}
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const diagnostics = program.getSemanticDiagnostics();
if (diagnostics.length) {
  throw new Error(
    ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }),
  );
}
const checker = program.getTypeChecker();
const formatFlags =
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
const entrypointSources = {
  root: 'src/index.ts',
  storage: 'src/storage.ts',
  memory: 'src/memory.ts',
  sqlite: 'src/sqlite.ts',
  kernel: 'src/kernel.ts',
  conformance: 'src/conformance.ts',
  cas: 'src/cas.ts',
  external: 'src/external.ts',
};

function compareExact(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function portableSourcePath(fileName) {
  const absolute = path.normalize(path.resolve(fileName));
  const typescriptLibMarker = `${path.sep}node_modules${path.sep}typescript${path.sep}lib${path.sep}`;
  const markerIndex = absolute.lastIndexOf(typescriptLibMarker);
  if (markerIndex >= 0) {
    const tail = absolute
      .slice(markerIndex + typescriptLibMarker.length)
      .split(path.sep)
      .join('/');
    return `node_modules/typescript/lib/${tail}`;
  }
  return path.relative(root, absolute).split(path.sep).join('/');
}
function sourceFile(relativePath) {
  const file = program.getSourceFile(path.join(root, relativePath));
  if (!file) throw new Error(`Missing source '${relativePath}'.`);
  return file;
}
function declarationOf(symbol, fallback) {
  return symbol.valueDeclaration ?? symbol.declarations?.[0] ?? fallback;
}
function typeText(type, node) {
  return checker.typeToString(type, node, formatFlags);
}
function signatureShape(signature, fallback) {
  const declaration = signature.declaration ?? fallback;
  return {
    parameters: signature.getParameters().map((parameter) => {
      const node = declarationOf(parameter, declaration);
      return {
        name: parameter.name,
        type: typeText(checker.getTypeOfSymbolAtLocation(parameter, node), node),
        optional: (parameter.flags & ts.SymbolFlags.Optional) !== 0,
      };
    }),
    result: typeText(checker.getReturnTypeOfSignature(signature), declaration),
  };
}
function callableSignatures(type, declaration) {
  const direct = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  const members = type.isUnionOrIntersection()
    ? type.types.flatMap((member) => checker.getSignaturesOfType(member, ts.SignatureKind.Call))
    : [];
  const seen = new Set();
  return [...direct, ...members]
    .map((signature) => signatureShape(signature, declaration))
    .filter((shape) => {
      const key = JSON.stringify(shape);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
function publicClassMembers(exported, constructorType) {
  const instanceMembers = checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(exported));
  const members = [...instanceMembers];
  const names = new Set(instanceMembers.map((member) => member.name));
  for (const member of checker.getPropertiesOfType(constructorType)) {
    const declaration = member.valueDeclaration ?? member.declarations?.[0];
    if (!declaration) continue;
    const flags = ts.getCombinedModifierFlags(declaration);
    if ((flags & ts.ModifierFlags.Static) === 0) continue;
    if ((flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0) continue;
    if (names.has(member.name))
      throw new Error(`Static/instance collision on ${exported.name}.${member.name}`);
    names.add(member.name);
    members.push(member);
  }
  return members;
}
function callableProperties(type, prefix, declaration) {
  const rows = [];
  for (const property of checker.getPropertiesOfType(type)) {
    const propertyDeclaration = declarationOf(property, declaration);
    const propertyFile = path.normalize(path.resolve(propertyDeclaration.getSourceFile().fileName));
    if (!(propertyFile === sourceRoot || propertyFile.startsWith(sourcePrefix))) continue;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, propertyDeclaration);
    const signatures = callableSignatures(propertyType, propertyDeclaration);
    if (!signatures.length) continue;
    rows.push({
      key: `${prefix}.${property.name}`,
      kind: 'callable-property',
      declaration: portableSourcePath(propertyDeclaration.getSourceFile().fileName),
      signatures,
    });
  }
  return rows;
}
function interfaceMethods(exported, declaration, entrypoint) {
  if (!declaration || !ts.isInterfaceDeclaration(declaration)) return [];
  const rows = [];
  const interfaceType = checker.getDeclaredTypeOfSymbol(exported);
  for (const member of checker.getPropertiesOfType(interfaceType)) {
    const memberDeclaration = declarationOf(member, declaration);
    const memberType = checker.getTypeOfSymbolAtLocation(member, memberDeclaration);
    const signatures = callableSignatures(memberType, memberDeclaration);
    if (!signatures.length) continue;
    rows.push({
      key: `${entrypoint}.${exported.name}.${member.name}`,
      kind: 'interface-method',
      declaration: portableSourcePath(memberDeclaration.getSourceFile().fileName),
      signatures,
    });
  }
  return rows;
}
function moduleSurface(relativePath, entrypoint) {
  const source = sourceFile(relativePath);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`Missing module symbol '${relativePath}'.`);
  const callables = [];
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const declaration = declarationOf(exported, source);
    const exportedType = checker.getTypeOfSymbolAtLocation(exported, declaration);
    const calls = checker
      .getSignaturesOfType(exportedType, ts.SignatureKind.Call)
      .map((signature) => signatureShape(signature, declaration));
    const constructors = checker
      .getSignaturesOfType(exportedType, ts.SignatureKind.Construct)
      .map((signature) => signatureShape(signature, declaration));
    callables.push(...interfaceMethods(exported, declaration, entrypoint));
    for (const signature of checker.getSignaturesOfType(exportedType, ts.SignatureKind.Call)) {
      callables.push(
        ...callableProperties(
          checker.getReturnTypeOfSignature(signature),
          `${entrypoint}.${exported.name}`,
          declaration,
        ),
      );
    }
    if (calls.length || constructors.length) {
      callables.push({
        key: `${entrypoint}.${exported.name}`,
        kind: constructors.length ? 'constructor-or-function' : 'function',
        declaration: portableSourcePath(declaration.getSourceFile().fileName),
        callSignatures: calls,
        constructSignatures: constructors,
      });
    }
    if (!constructors.length) continue;
    for (const member of publicClassMembers(exported, exportedType)) {
      const memberDeclaration = declarationOf(member, declaration);
      const flags = ts.getCombinedModifierFlags(memberDeclaration);
      if ((flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0) continue;
      const memberType = checker.getTypeOfSymbolAtLocation(member, memberDeclaration);
      const signatures = checker
        .getSignaturesOfType(memberType, ts.SignatureKind.Call)
        .map((signature) => signatureShape(signature, memberDeclaration));
      if (!signatures.length) continue;
      callables.push({
        key: `${entrypoint}.${exported.name}.${member.name}`,
        kind: 'method',
        declaration: portableSourcePath(memberDeclaration.getSourceFile().fileName),
        signatures,
      });
    }
  }
  return callables.sort((a, b) => compareExact(a.key, b.key));
}
function sourceOwnedDeclarations(symbol) {
  return (symbol?.getDeclarations() ?? []).filter((declaration) => {
    const file = path.normalize(path.resolve(declaration.getSourceFile().fileName));
    return file === sourceRoot || file.startsWith(sourcePrefix);
  });
}
function shortHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}
const declarationOrdinalCache = new WeakMap();
function declarationStableBaseName(declaration) {
  if (
    (ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration) ||
      ts.isClassDeclaration(declaration)) &&
    declaration.name
  )
    return declaration.name.text;
  if (ts.isTypeLiteralNode(declaration) || ts.isMappedTypeNode(declaration)) return '__anonymous__';
  return undefined;
}
function declarationOrdinal(declaration) {
  const cached = declarationOrdinalCache.get(declaration);
  if (cached !== undefined) return cached;
  const source = declaration.getSourceFile();
  const targetName = declarationStableBaseName(declaration);
  if (targetName === undefined) throw new Error('Unsupported package-owned type declaration.');
  const matches = [];
  const visit = (node) => {
    if (declarationStableBaseName(node) === targetName) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  matches.sort((left, right) => left.getStart(source) - right.getStart(source));
  matches.forEach((node, index) => declarationOrdinalCache.set(node, index));
  const ordinal = declarationOrdinalCache.get(declaration);
  if (ordinal === undefined) throw new Error('Could not assign package-owned declaration ordinal.');
  return ordinal;
}
if (process.argv.includes('--self-test-trivia-ordinals')) {
  const fingerprint = (text) => {
    const source = ts.createSourceFile('synthetic.ts', text, ts.ScriptTarget.Latest, true);
    const declarations = [];
    const visit = (node) => {
      if (declarationStableBaseName(node) !== undefined) declarations.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    return declarations.map(
      (declaration) =>
        `${declarationStableBaseName(declaration)}#${declarationOrdinal(declaration)}`,
    );
  };
  const baseline = fingerprint(`
interface Same { value: string }
type Alias = { value: number };
type Again = { value: boolean };
`);
  const withTrivia = fingerprint(`
// leading comment which must not change a public type identity

interface Same { value: string }
/* another comment */
type Alias = { value: number };

// shifted lines and whitespace
type Again = { value: boolean };
`);
  if (JSON.stringify(baseline) !== JSON.stringify(withTrivia)) {
    throw new Error(
      `Declaration ordinal self-test drifted under trivia: ${JSON.stringify({ baseline, withTrivia })}`,
    );
  }
  console.log('Declaration ordinal trivia self-test passed.');
  process.exit(0);
}

function packageTypeIdentity(type) {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  const declarations = sourceOwnedDeclarations(symbol).filter(
    (declaration) =>
      ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration) ||
      ts.isClassDeclaration(declaration) ||
      ts.isTypeLiteralNode(declaration) ||
      ts.isMappedTypeNode(declaration),
  );
  if (!declarations.length) return undefined;
  const declaration = declarations[0];
  const file = portableSourcePath(declaration.getSourceFile().fileName);
  const rendered = typeText(type, declaration);
  const ordinal = declarationOrdinal(declaration);
  const name =
    symbol.name === '__type' || symbol.name === '__object'
      ? `anonymous@${file}#${ordinal}`
      : symbol.name;
  const argumentsLength = (checker.getTypeArguments?.(type) ?? []).length;
  const genericSuffix = argumentsLength ? `<${shortHash(rendered)}>` : '';
  return {
    identity: `${name}${genericSuffix}|${file}|${ordinal}|${shortHash(rendered)}`,
    name: `${name}${genericSuffix}`,
    declaration,
  };
}
function includesFlag(type, flag) {
  return type.isUnion()
    ? type.types.some((member) => (member.flags & flag) !== 0)
    : (type.flags & flag) !== 0;
}

const typeRecords = new Map();
const visitedDirections = new Map();
const recursiveTypeReferences = new Set();
const truncatedTypes = new Set();
const externalIds = new WeakMap();
let nextExternalId = 0;
let maximumTypeDepth = 0;
function externalTypeIdentity(type) {
  if (!externalIds.has(type)) externalIds.set(type, `external:${++nextExternalId}`);
  return externalIds.get(type);
}
function addDirection(record, direction) {
  record.directions = [...new Set([...record.directions, direction])].sort(compareExact);
}
function visitType(type, direction, lineage = new Set(), depth = 0) {
  maximumTypeDepth = Math.max(maximumTypeDepth, depth);
  if (depth > 128) {
    truncatedTypes.add(typeText(type));
    return;
  }
  const owned = packageTypeIdentity(type);
  const rendered = typeText(type, owned?.declaration ?? sourceFile('src/index.ts'));
  if (/\.\.\. [0-9]+ more \.\.\./u.test(rendered)) truncatedTypes.add(owned?.identity ?? rendered);
  const identity = owned?.identity ?? externalTypeIdentity(type);
  if (lineage.has(identity)) {
    recursiveTypeReferences.add(identity);
    return;
  }
  const visited = visitedDirections.get(identity) ?? new Set();
  if (visited.has(direction)) return;
  visited.add(direction);
  visitedDirections.set(identity, visited);
  const nextLineage = new Set(lineage);
  nextLineage.add(identity);
  if (type.isUnionOrIntersection())
    for (const member of type.types) visitType(member, direction, nextLineage, depth + 1);
  for (const argument of checker.getTypeArguments?.(type) ?? [])
    visitType(argument, direction, nextLineage, depth + 1);
  for (const signature of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
    for (const parameter of signature.getParameters()) {
      const node = declarationOf(parameter, signature.declaration ?? sourceFile('src/index.ts'));
      visitType(
        checker.getTypeOfSymbolAtLocation(parameter, node),
        'callback-argument',
        nextLineage,
        depth + 1,
      );
    }
    visitType(
      checker.getReturnTypeOfSignature(signature),
      'callback-result',
      nextLineage,
      depth + 1,
    );
  }
  const stringIndex = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  const numberIndex = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (stringIndex) visitType(stringIndex, direction, nextLineage, depth + 1);
  if (numberIndex && numberIndex !== stringIndex)
    visitType(numberIndex, direction, nextLineage, depth + 1);
  if (!owned) return;
  let record = typeRecords.get(owned.identity);
  if (!record) {
    record = {
      name: owned.name,
      identity: owned.identity,
      source: portableSourcePath(owned.declaration.getSourceFile().fileName),
      directions: [],
      fields: [],
    };
    typeRecords.set(owned.identity, record);
  }
  addDirection(record, direction);
  const byName = new Map(record.fields.map((field) => [field.name, field]));
  for (const property of checker.getPropertiesOfType(type)) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration || ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration))
      continue;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    const renderedProperty = typeText(propertyType, declaration);
    let field = byName.get(property.name);
    if (!field) {
      field = {
        name: property.name,
        type: renderedProperty,
        optional: (property.flags & ts.SymbolFlags.Optional) !== 0,
        allowsUndefined: includesFlag(propertyType, ts.TypeFlags.Undefined),
        allowsNull: includesFlag(propertyType, ts.TypeFlags.Null),
        callable: callableSignatures(propertyType, declaration).length > 0,
        callSignatures: callableSignatures(propertyType, declaration),
        source: portableSourcePath(declaration.getSourceFile().fileName),
        directions: [],
      };
      record.fields.push(field);
      byName.set(property.name, field);
    } else if (field.type !== renderedProperty) {
      throw new Error(
        `Public field '${record.name}.${property.name}' resolved to conflicting types.`,
      );
    }
    addDirection(field, direction);
    visitType(propertyType, direction, nextLineage, depth + 1);
  }
  record.fields.sort((a, b) => compareExact(a.name, b.name));
}
function visitEntrypointTypes(relativePath) {
  const source = sourceFile(relativePath);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) return;
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const declaration = declarationOf(exported, source);
    const exportedType = checker.getTypeOfSymbolAtLocation(exported, declaration);
    if (
      ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration) ||
      ts.isClassDeclaration(declaration)
    ) {
      visitType(checker.getDeclaredTypeOfSymbol(exported), 'exported-type');
    }
    for (const signature of [
      ...checker.getSignaturesOfType(exportedType, ts.SignatureKind.Call),
      ...checker.getSignaturesOfType(exportedType, ts.SignatureKind.Construct),
    ]) {
      for (const parameter of signature.getParameters()) {
        const node = declarationOf(parameter, declaration);
        visitType(checker.getTypeOfSymbolAtLocation(parameter, node), 'input');
      }
      visitType(checker.getReturnTypeOfSignature(signature), 'output');
    }
    if (!checker.getSignaturesOfType(exportedType, ts.SignatureKind.Construct).length) continue;
    for (const member of publicClassMembers(exported, exportedType)) {
      const memberDeclaration = declarationOf(member, declaration);
      const flags = ts.getCombinedModifierFlags(memberDeclaration);
      if ((flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0) continue;
      const memberType = checker.getTypeOfSymbolAtLocation(member, memberDeclaration);
      for (const signature of checker.getSignaturesOfType(memberType, ts.SignatureKind.Call)) {
        for (const parameter of signature.getParameters()) {
          const node = declarationOf(parameter, memberDeclaration);
          visitType(checker.getTypeOfSymbolAtLocation(parameter, node), 'input');
        }
        visitType(checker.getReturnTypeOfSignature(signature), 'output');
      }
    }
  }
}

const entrypoints = Object.fromEntries(
  Object.entries(entrypointSources).map(([name, file]) => [name, moduleSurface(file, name)]),
);
for (const file of Object.values(entrypointSources)) visitEntrypointTypes(file);
const types = [...typeRecords.values()]
  .map((record) => ({
    ...record,
    directions: [...record.directions].sort(compareExact),
    fields: record.fields.map((field) => ({
      ...field,
      directions: [...field.directions].sort(compareExact),
    })),
  }))
  .sort((a, b) => compareExact(a.identity, b.identity));
console.log(
  JSON.stringify(
    {
      entrypoints,
      types,
      diagnostics: {
        maximumTypeDepth,
        recursiveTypeReferences: [...recursiveTypeReferences].sort(compareExact),
        truncatedTypes: [...truncatedTypes].sort(compareExact),
      },
    },
    null,
    2,
  ),
);
