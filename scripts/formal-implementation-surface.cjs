const ts = require('typescript');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const sourceRoot = path.resolve(root, 'src');
const sourcePrefix = `${path.normalize(sourceRoot)}${path.sep}`;
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
  remote: 'src/remote.ts',
};

function compareExact(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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
      declaration: path.relative(root, propertyDeclaration.getSourceFile().fileName),
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
      declaration: path.relative(root, memberDeclaration.getSourceFile().fileName),
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
        declaration: path.relative(root, declaration.getSourceFile().fileName),
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
        declaration: path.relative(root, memberDeclaration.getSourceFile().fileName),
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
  const file = path.relative(root, declaration.getSourceFile().fileName);
  const rendered = typeText(type, declaration);
  const name =
    symbol.name === '__type' || symbol.name === '__object'
      ? `anonymous@${file}:${declaration.getSourceFile().getLineAndCharacterOfPosition(declaration.getStart()).line + 1}`
      : symbol.name;
  const argumentsLength = (checker.getTypeArguments?.(type) ?? []).length;
  const genericSuffix = argumentsLength ? `<${shortHash(rendered)}>` : '';
  return {
    identity: `${name}${genericSuffix}|${file}|${declaration.pos}|${shortHash(rendered)}`,
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
      source: path.relative(root, owned.declaration.getSourceFile().fileName),
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
        source: path.relative(root, declaration.getSourceFile().fileName),
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
