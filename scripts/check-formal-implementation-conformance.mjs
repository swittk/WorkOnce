import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const manifestPath = path.join(root, 'assurance/formal-implementation-manifest.json');
const reportPath = path.join(root, 'formal/FORMAL_COVERAGE_GAPS.md');
const write = process.argv.includes('--write');
const acknowledgePairing = process.argv.includes('--ack-source-model-review');
const semanticSourceFiles = [
  'src/model.ts',
  'src/kernel.ts',
  'src/outcomes.ts',
  'src/work.ts',
  'src/worker.ts',
  'src/storage.ts',
  'src/storage-validation.ts',
  'src/memory.ts',
  'src/sqlite.ts',
  'src/cas.ts',
  'src/conformance.ts',
  'src/external.ts',
  'src/retry-policy.ts',
];
const modelFiles = [
  'formal/WorkOnce.tla',
  'formal/WorkOnce.cfg',
  'formal/WorkOnceContract.tla',
  'formal/WorkOnceRuntime.tla',
  'formal/WorkOnceRuntime.cfg',
];
const runtimeSourceFiles = ['src/worker.ts', 'src/work.ts'];
const runtimeModelFiles = [
  'formal/WorkOnceRuntime.tla',
  'formal/WorkOnceRuntime.cfg',
  'formal/WorkOnceContract.tla',
];
const readModelFiles = ['formal/WorkOnceContract.tla'];
const readSourceMethods = [
  'WorkItem.inspect',
  'WorkQueue.key',
  'WorkQueue.item',
  'WorkQueue.inspect',
  'WorkQueue.inspectId',
  'WorkQueue.inspectMany',
  'WorkQueue.history',
  'WorkQueue.requireRow',
  'WorkQueue.assertDefinition',
  'WorkQueue.snapshot',
];
const assuranceInfrastructureFiles = [
  'scripts/check-formal-implementation-conformance.mjs',
  'scripts/formal-implementation-surface.cjs',
  'scripts/check-bounded-trace-domain.mjs',
  'scripts/formal.mjs',
  'scripts/runtime-boundary-refinement.mjs',
  'scripts/formal-bounded-refinement-corpus.mjs',
  'scripts/build-source-binding.mjs',
  'scripts/check-build-source-binding-mutation.mjs',
  'scripts/check-assurance-infrastructure-binding-mutation.mjs',
  'scripts/check-emitted-artifact-entrypoints.mjs',
  'scripts/check-emitted-artifact-entrypoint-mutation.mjs',
  'scripts/read-boundary-refinement.mjs',
  'scripts/check-read-boundary-mutation.mjs',
  'scripts/check-read-source-model-binding-mutation.mjs',
  'scripts/check-read-contract-mutation.mjs',
  'scripts/run-assurance.mjs',
  'package.json',
];
const expectedEntrypoints = [
  'root',
  'storage',
  'memory',
  'sqlite',
  'kernel',
  'conformance',
  'cas',
  'external',
];
const evidenceByClassification = {
  'abstract-semantic': ['test/formal-bounded-refinement.test.mjs', 'test/conformance.test.mjs'],
  'identity-retry-semantic': [
    'test/formal-bounded-refinement.test.mjs',
    'test/edge-regressions.test.mjs',
  ],
  'policy-callback': [
    'test/cas.test.mjs',
    'test/continuation-policy.test.mjs',
    'test/readable-api.test.mjs',
  ],
  'worker-runtime': [
    'test/worker.test.mjs',
    'test/external.test.mjs',
    'test/handoff.test.mjs',
    'test/edge-regressions.test.mjs',
  ],
  'storage-boundary': [
    'test/cas.test.mjs',
    'test/conformance.test.mjs',
    'test/edge-regressions.test.mjs',
    'test/process/sqlite-process.test.mjs',
  ],
  'ergonomic-wrapper': ['test/item.test.mjs', 'test/types/api.ts'],
  observational: ['test/inspection.test.mjs', 'test/types/api.ts'],
  'opaque-payload': ['test/terminal-receipt.test.mjs', 'test/conformance.test.mjs'],
  'assurance-infrastructure': ['test/conformance.test.mjs'],
};

function compareExact(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compareExact(a, b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}
function canonicalText(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}
function semanticSourceDigest(files) {
  const chunks = [];
  for (const relativePath of [...files].sort(compareExact)) {
    const text = fs.readFileSync(path.join(root, relativePath), 'utf8');
    const scanner = ts.createScanner(
      ts.ScriptTarget.Latest,
      false,
      ts.LanguageVariant.Standard,
      text,
    );
    const tokens = [];
    for (;;) {
      const token = scanner.scan();
      if (token === ts.SyntaxKind.EndOfFileToken) break;
      if (token >= ts.SyntaxKind.FirstTriviaToken && token <= ts.SyntaxKind.LastTriviaToken)
        continue;
      tokens.push(`${token}:${scanner.getTokenText()}`);
    }
    chunks.push(`${relativePath}\n${tokens.join('\n')}`);
  }
  return digest(chunks.join('\n---\n'));
}
function formalDigest(files) {
  const chunks = [];
  for (const relativePath of [...files].sort(compareExact)) {
    const normalized = fs
      .readFileSync(path.join(root, relativePath), 'utf8')
      .replace(/\(\*[\s\S]*?\*\)/gu, '')
      .replace(/\\\*.*$/gmu, '')
      .replace(/\s+/gu, ' ')
      .trim();
    chunks.push(`${relativePath}\n${normalized}`);
  }
  return digest(chunks.join('\n---\n'));
}
function contentDigest(files) {
  const chunks = [];
  for (const relativePath of [...files].sort(compareExact)) {
    const normalized = fs
      .readFileSync(path.join(root, relativePath), 'utf8')
      .replace(/\r\n?/gu, '\n');
    chunks.push(`${relativePath}\n${normalized}`);
  }
  return digest(chunks.join('\n---\n'));
}
function semanticTokenString(text) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  const tokens = [];
  for (;;) {
    const token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) break;
    if (token >= ts.SyntaxKind.FirstTriviaToken && token <= ts.SyntaxKind.LastTriviaToken) continue;
    tokens.push(`${token}:${scanner.getTokenText()}`);
  }
  return tokens.join('\n');
}
function readSurfaceDigest() {
  const file = path.join(root, 'src/work.ts');
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const wanted = new Set(readSourceMethods);
  const found = [];
  for (const node of source.statements) {
    if (!ts.isClassDeclaration(node) || !node.name) continue;
    const className = node.name.text;
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member) || !member.name) continue;
      const key = `${className}.${member.name.getText(source)}`;
      if (wanted.has(key)) found.push(`${key}\n${semanticTokenString(member.getText(source))}`);
    }
  }
  const keys = found.map((entry) => entry.slice(0, entry.indexOf('\n'))).sort(compareExact);
  const expected = [...wanted].sort(compareExact);
  if (JSON.stringify(keys) !== JSON.stringify(expected))
    throw new Error(
      `Typed-read source binding drifted: expected=${expected.join(',')} found=${keys.join(',')}`,
    );
  return digest(found.sort(compareExact).join('\n---\n'));
}

function surface() {
  const result = spawnSync(process.execPath, ['scripts/formal-implementation-surface.cjs'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(result.stderr || `surface extractor exited ${result.status}`);
  return JSON.parse(result.stdout);
}
function readConfiguredChecksFromText(cfg) {
  const tokens = [];
  let list = false;
  const stopKeywords = new Set([
    'SPECIFICATION',
    'CONSTANT',
    'CONSTANTS',
    'CHECK_DEADLOCK',
    'CONSTRAINT',
    'CONSTRAINTS',
    'ACTION_CONSTRAINT',
    'ACTION_CONSTRAINTS',
    'INIT',
    'NEXT',
    'SYMMETRY',
    'VIEW',
    'ALIAS',
  ]);
  const addNames = (text) => {
    const names = text.trim().split(/\s+/u).filter(Boolean);
    if (names.length === 0) return false;
    for (const name of names) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
        throw new Error(`Invalid configured formal token '${name}'.`);
      tokens.push(name);
    }
    return true;
  };
  for (const raw of cfg.split(/\r?\n/u)) {
    const line = raw.split('\\*')[0].trim();
    if (!line) continue;
    const directive = /^(INVARIANT|INVARIANTS|PROPERTY|PROPERTIES)\b(.*)$/u.exec(line);
    if (directive) {
      const rest = directive[2].trim();
      list = true;
      if (rest.length > 0) addNames(rest);
      continue;
    }
    const first = line.split(/\s+/u, 1)[0];
    if (stopKeywords.has(first)) {
      list = false;
      continue;
    }
    if (list) {
      if (!addNames(line)) throw new Error(`Invalid configured formal check list line '${line}'.`);
      continue;
    }
  }
  return [...new Set(tokens)].sort(compareExact);
}
function readConfiguredChecks(file = 'formal/WorkOnce.cfg') {
  return readConfiguredChecksFromText(fs.readFileSync(path.join(root, file), 'utf8'));
}
if (process.argv.includes('--self-test-config-checks')) {
  const parsed = readConfiguredChecksFromText(`
INVARIANT TypeOK OneOwner
  InlineContinued
PROPERTIES
  EventuallyDone
  ALWAYS_OK
CONSTRAINT StateBound
ACTION_CONSTRAINT StepBound
INIT Init
NEXT Next
SYMMETRY Symmetry
VIEW View
ALIAS Alias
INVARIANTS
  FinalSafety
CHECK_DEADLOCK FALSE
`);
  const expected = [
    'ALWAYS_OK',
    'EventuallyDone',
    'FinalSafety',
    'InlineContinued',
    'OneOwner',
    'TypeOK',
  ];
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    throw new Error(`Configured-check parser self-test failed: ${JSON.stringify(parsed)}`);
  }
  let rejected = false;
  try {
    readConfiguredChecksFromText('INVARIANTS\nBad,Token\n');
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('Configured-check parser accepted invalid list content.');
  console.log('Configured-check parser self-test passed.');
  process.exit(0);
}
function callableClassification(key) {
  if (key === 'root.exponentialBackoff') return 'policy-callback';
  if (key.startsWith('cas.') || key.startsWith('sqlite.') || key.startsWith('memory.'))
    return 'storage-boundary';
  if (key.startsWith('conformance.')) return 'assurance-infrastructure';
  if (/\.(?:run|runAvailable|process|handoff)$/.test(key) || key.startsWith('external.'))
    return 'worker-runtime';
  if (/\.(?:inspect|inspectId|inspectMany|history|toJSON|key|request|item)$/.test(key))
    return 'observational';
  if (/WorkItem\./.test(key) || key === 'root.createWorkOnce') return 'ergonomic-wrapper';
  return 'abstract-semantic';
}
function callableFieldClassification(typeName, fieldName) {
  if (
    typeName.startsWith('WorkDefinition') &&
    ['executionLimits', 'limits', 'retry', 'wait', 'defer', 'thenDo', 'next', 'key'].includes(
      fieldName,
    )
  )
    return 'policy-callback';
  if (typeName.startsWith('WorkDefinition') && fieldName === 'perform') return 'worker-runtime';
  if (typeName === 'WorkerOptions' && fieldName === 'onError') return 'worker-runtime';
  if (fieldName === 'now') return 'storage-boundary';
  if (fieldName === 'check') return 'policy-callback';
  if (['atomic', 'getMany', 'query', 'compareExchange'].includes(fieldName))
    return 'storage-boundary';
  return 'abstract-semantic';
}
function fieldClassification(typeName, fieldName, callable) {
  if (callable) return callableFieldClassification(typeName, fieldName);
  if (['input', 'result'].includes(fieldName)) return 'opaque-payload';
  if (
    ['WorkerOptions', 'ExternalWorkerOptions'].includes(typeName) &&
    ['idleMs', 'heartbeatMs'].includes(fieldName)
  )
    return 'worker-runtime';
  if (
    typeName === 'ExponentialBackoffOptions' &&
    ['initialDelayMs', 'maxDelayMs', 'multiplier'].includes(fieldName)
  )
    return 'abstract-semantic';
  if (
    /^(?:id|key|scope|kind|definition|version|workId|generation|fence|workerId|number|revision|attempts|retries|deferrals|attempt|operationId|expectedRevision|expectedGeneration|submissionHash)$/u.test(
      fieldName,
    )
  )
    return 'identity-retry-semantic';
  if (/^(?:onError|signal|concurrency|status|error|activeAttempt)$/u.test(fieldName))
    return 'worker-runtime';
  if (
    /^(?:state|phase|cause|reason|manualRetry|stoppedBy|outcome|thenDo|next|outbox|receipt|pendingFollowups|retry|maxRetries|type)$/u.test(
      fieldName,
    )
  )
    return 'abstract-semantic';
  if (
    /^(?:createdAt|updatedAt|firstStartedAt|availableAt|leaseUntil|startedAt|completedAt|failedAt|cancelledAt|observedAt|elapsedMs|at|afterMs|validUntil|leaseMs|maxAttempts|maxElapsedMs|maxDeferrals|limit)$/u.test(
      fieldName,
    )
  )
    return 'abstract-semantic';
  if (
    /^(?:store|select|afterId|maxConflicts|busyTimeoutMs)$/u.test(fieldName) ||
    typeName.startsWith('StoreChange') ||
    typeName === 'ConformanceFixture'
  )
    return 'storage-boundary';
  if (/^(?:history|action|snapshot|queue|ref)$/u.test(fieldName)) return 'observational';
  return 'observational';
}
function modelConceptsForField(typeName, fieldName, classification) {
  if (classification === 'opaque-payload') return ['opaquePayload'];
  if (classification === 'storage-boundary') return ['storageAtomicity'];
  if (classification === 'worker-runtime') return ['pc', 'active', 'fatalPresent', 'aborted'];
  if (
    typeName === 'ExponentialBackoffOptions' &&
    ['initialDelayMs', 'maxDelayMs', 'multiplier'].includes(fieldName)
  )
    return ['BackoffDelay'];
  if (classification === 'observational') return ['observationOnly'];
  if (classification === 'policy-callback') {
    if (fieldName === 'retry') return ['retries', 'available', 'manualRetryAllowed'];
    if (fieldName === 'wait' || fieldName === 'defer') return ['deferrals', 'available'];
    if (fieldName === 'executionLimits' || fieldName === 'limits')
      return ['attempts', 'Deadline', 'deferrals', 'lease'];
    if (fieldName === 'thenDo' || fieldName === 'next') return ['pendingNext', 'childCreated'];
    if (fieldName === 'check') return ['manualRetryAllowed', 'generation'];
    return ['identity'];
  }
  if (/^(?:state|phase|type|outcome)$/u.test(fieldName)) return ['state'];
  if (fieldName === 'cause') return ['waitCause'];
  if (fieldName === 'stoppedBy') return ['stopReason'];
  if (fieldName === 'manualRetry') return ['manualRetryAllowed'];
  if (/^(?:fence|attempt)$/u.test(fieldName)) return ['fence', 'tokens'];
  if (/^(?:workerId|activeAttempt)$/u.test(fieldName)) return ['owner', 'tokens'];
  if (/^(?:generation|expectedGeneration)$/u.test(fieldName)) return ['generation'];
  if (/^(?:leaseUntil|leaseMs|validUntil)$/u.test(fieldName)) return ['lease'];
  if (/^(?:availableAt|afterMs|at)$/u.test(fieldName)) return ['available', 'now'];
  if (/^(?:attempts|maxAttempts)$/u.test(fieldName)) return ['attempts'];
  if (/^(?:retries|maxRetries|retry)$/u.test(fieldName)) return ['retries'];
  if (/^(?:deferrals|maxDeferrals)$/u.test(fieldName)) return ['deferrals'];
  if (/^(?:firstStartedAt|maxElapsedMs|elapsedMs)$/u.test(fieldName))
    return ['firstStarted', 'Deadline'];
  if (/^(?:thenDo|next|outbox|pendingFollowups)$/u.test(fieldName))
    return ['pendingNext', 'childCreated'];
  if (/^(?:reason)$/u.test(fieldName)) return ['stopReason', 'waitCause'];
  if (
    /^(?:id|key|scope|kind|definition|version|workId|revision|submissionHash|number|operationId|expectedRevision)$/u.test(
      fieldName,
    )
  )
    return ['identity'];
  if (
    /^(?:createdAt|updatedAt|startedAt|completedAt|failedAt|cancelledAt|observedAt)$/u.test(
      fieldName,
    )
  )
    return ['now'];
  return ['observationOnly'];
}
function modelActionsForKey(key) {
  if (key === 'root.retry' || key === 'root.WorkRun.retry') return ['Retry'];
  if (
    key === 'root.wait' ||
    key === 'root.defer' ||
    key === 'root.WorkRun.wait' ||
    key === 'root.WorkRun.defer'
  )
    return ['Defer'];
  if (key === 'root.succeed' || key === 'root.WorkRun.succeed') return ['Success'];
  if (key === 'root.fail' || key === 'root.WorkRun.fail') return ['Fail'];
  if (
    key === 'root.WorkQueue.retry' ||
    key === 'root.WorkItem.retry' ||
    key === 'kernel.retryRecord'
  )
    return ['ManualRetry'];
  if (
    key === 'root.WorkQueue.rerun' ||
    key === 'root.WorkItem.rerun' ||
    key === 'kernel.rerunRecord'
  )
    return ['Rerun'];
  if (key.endsWith('.restart')) return ['ManualRetry', 'Rerun'];
  if (key.endsWith('.claim') || key === 'kernel.claimRecord')
    return ['Claim', 'ExhaustAttempts', 'ExhaustDeadline'];
  if (key.endsWith('.heartbeat') || key.endsWith('.renew') || key === 'kernel.renewRecord')
    return ['Renew'];
  if (key.endsWith('.settle') || key === 'kernel.settleRecord')
    return ['Success', 'Fail', 'Retry', 'Defer'];
  if (key.endsWith('.cancel') || key.endsWith('.cancelCurrent') || key === 'kernel.cancelRecord')
    return ['Cancel'];
  if (key.endsWith('.wake') || key.endsWith('.wakeCurrent')) return ['Wake'];
  if (key.endsWith('.dispatch') || key.endsWith('.runDispatcher'))
    return ['CreateChild', 'AckChild'];
  if (
    key === 'root.WorkQueue.runAvailable' ||
    key === 'root.WorkQueue.process' ||
    key === 'root.WorkQueue.run'
  )
    return ['Claim', 'Renew', 'Success', 'Fail', 'Retry', 'Defer'];
  if (key === 'root.WorkQueue.handoff')
    return ['Claim', 'Renew', 'Success', 'Fail', 'Retry', 'Defer'];
  if (key === 'root.WorkQueue.serveExternal')
    return ['Claim', 'Renew', 'Success', 'Fail', 'Retry', 'Defer'];
  if (/^(?:root|external)\.(?:runExternalAvailable|processExternal|runExternal)$/u.test(key))
    return ['Claim', 'Renew', 'Success', 'Fail', 'Retry', 'Defer'];
  if (/ExternalWorkService\.(?:claim|heartbeat|settle)$/u.test(key)) {
    if (key.endsWith('.claim')) return ['Claim', 'ExhaustAttempts', 'ExhaustDeadline'];
    if (key.endsWith('.heartbeat')) return ['Renew'];
    return ['Success', 'Fail', 'Retry', 'Defer'];
  }
  if (/^(?:root|external)\.ExternalWorkRun\.succeed$/u.test(key)) return ['Success'];
  if (/^(?:root|external)\.ExternalWorkRun\.fail$/u.test(key)) return ['Fail'];
  if (/^(?:root|external)\.ExternalWorkRun\.retry$/u.test(key)) return ['Retry'];
  if (/^(?:root|external)\.ExternalWorkRun\.(?:wait|defer)$/u.test(key)) return ['Defer'];
  if (key === 'root.exponentialBackoff') return ['Retry'];
  return [];
}
function runtimeContractsForKey(key) {
  if (/^(?:root|external)\.runExternal$/u.test(key) || key === 'root.WorkQueue.run')
    return [
      'RunnerRejects',
      'ClaimReply',
      'ObserveHandled',
      'ObserveFatal',
      'ActiveDone',
      'Finish',
    ];
  if (/\.(?:inspect|inspectId|inspectMany|history)$/u.test(key)) return ['ReadAllowed'];
  if (key === 'root.exponentialBackoff') return ['BackoffDelay'];
  if (key === 'conformance.runConformance') return ['BoundarySampleOK'];
  return [];
}
function modelActionsForField(typeName, fieldName) {
  if (typeName.startsWith('WorkDefinition')) {
    if (fieldName === 'retry') return ['Retry'];
    if (fieldName === 'wait' || fieldName === 'defer') return ['Defer'];
    if (fieldName === 'perform') return ['Claim', 'Renew', 'Success', 'Fail', 'Retry', 'Defer'];
    if (fieldName === 'thenDo' || fieldName === 'next') return ['CreateChild'];
  }
  return [];
}
function signatureHash(row) {
  return digest(
    canonicalText({
      callSignatures: row.callSignatures ?? row.signatures ?? [],
      constructSignatures: row.constructSignatures ?? [],
    }),
  );
}

function buildManifest(live) {
  const callables = [];
  for (const entrypoint of Object.keys(live.entrypoints).sort(compareExact)) {
    for (const row of live.entrypoints[entrypoint]) {
      const classification = callableClassification(row.key);
      const runtimeContracts = runtimeContractsForKey(row.key);
      callables.push({
        key: row.key,
        classification,
        signatureHash: signatureHash(row),
        modelActions: modelActionsForKey(row.key),
        runtimeContracts,
        evidence: [
          ...evidenceByClassification[classification],
          'test/runtime-boundary-refinement.test.mjs',
          'test/lifecycle-transition-matrix.test.mjs',
          ...(runtimeContracts.includes('ReadAllowed')
            ? ['test/read-boundary-refinement.test.mjs']
            : []),
        ],
      });
    }
  }
  const fields = [];
  const callableFields = [];
  for (const type of live.types) {
    for (const field of type.fields) {
      const classification = fieldClassification(type.name, field.name, field.callable);
      const row = {
        key: `${type.identity}#${field.name}`,
        typeName: type.name,
        field: field.name,
        source: field.source,
        directions: field.directions,
        classification,
        typeHash: digest(field.type),
        optional: field.optional,
        allowsUndefined: field.allowsUndefined,
        allowsNull: field.allowsNull,
        callable: field.callable,
        modelConcepts: modelConceptsForField(type.name, field.name, classification),
        evidence: evidenceByClassification[classification],
      };
      fields.push(row);
      if (field.callable)
        callableFields.push({
          ...row,
          signatureHash: digest(canonicalText(field.callSignatures)),
          modelActions: modelActionsForField(type.name, field.name),
          evidence: evidenceByClassification[classification],
        });
    }
  }
  const types = live.types.map((type) => ({
    identity: type.identity,
    name: type.name,
    source: type.source,
    directions: type.directions,
    shapeHash: digest(
      canonicalText(
        type.fields.map((field) => ({
          name: field.name,
          type: field.type,
          optional: field.optional,
          allowsUndefined: field.allowsUndefined,
          allowsNull: field.allowsNull,
          callable: field.callable,
        })),
      ),
    ),
  }));
  return canonical({
    schemaVersion: 1,
    model: {
      spec: 'formal/WorkOnce.tla',
      config: 'formal/WorkOnce.cfg',
      actions: [
        'Claim',
        'Renew',
        'Success',
        'Fail',
        'Retry',
        'Defer',
        'Cancel',
        'Wake',
        'ManualRetry',
        'Rerun',
        'ExhaustAttempts',
        'ExhaustDeadline',
        'CreateChild',
        'AckChild',
        'Tick',
      ],
      configuredChecks: readConfiguredChecks(),
      runtime: {
        spec: 'formal/WorkOnceRuntime.tla',
        config: 'formal/WorkOnceRuntime.cfg',
        contract: 'formal/WorkOnceContract.tla',
        configuredChecks: readConfiguredChecks('formal/WorkOnceRuntime.cfg'),
        observationProducer: 'scripts/runtime-boundary-refinement.mjs',
        observationBinding: 'scripts/formal.mjs',
        sourceFiles: runtimeSourceFiles,
        modelFiles: runtimeModelFiles,
        sourceDigest: semanticSourceDigest(runtimeSourceFiles),
        modelDigest: formalDigest(runtimeModelFiles),
      },
      reads: {
        contract: 'formal/WorkOnceContract.tla',
        observationProducer: 'scripts/read-boundary-refinement.mjs',
        observationBridge: 'scripts/runtime-boundary-refinement.mjs',
        sourceMethods: readSourceMethods,
        sourceDigest: readSurfaceDigest(),
        modelFiles: readModelFiles,
        modelDigest: formalDigest(readModelFiles),
      },
    },
    entrypoints: expectedEntrypoints,
    callables,
    callableFields,
    types,
    fields,
    diagnostics: live.diagnostics,
    stateMachineBinding: {
      sourceFiles: semanticSourceFiles,
      modelFiles,
      sourceDigest: semanticSourceDigest(semanticSourceFiles),
      modelDigest: formalDigest(modelFiles),
      assuranceInfrastructureFiles,
      assuranceInfrastructureDigest: contentDigest(assuranceInfrastructureFiles),
    },
  });
}
function compareRows(previous, current, label) {
  const a = canonicalText(previous);
  const b = canonicalText(current);
  if (a !== b)
    throw new Error(
      `${label} drifted. Run npm run assurance:update, review every changed public mapping, and commit the manifest with the semantic change.`,
    );
}
function renderReport(manifest) {
  const lines = [
    '# Formal implementation coverage',
    '',
    `- Public callables: **${manifest.callables.length}**`,
    `- Callable policy/storage fields: **${manifest.callableFields.length}**`,
    `- Reachable package-owned types: **${manifest.types.length}**`,
    `- Reachable package-owned fields: **${manifest.fields.length}**`,
    `- Maximum recursive type depth: **${manifest.diagnostics.maximumTypeDepth}**`,
    `- Truncated public types: **${manifest.diagnostics.truncatedTypes.length}**`,
    '',
    '## Model actions',
    '',
  ];
  for (const action of manifest.model.actions) {
    const owners = [...manifest.callables, ...manifest.callableFields]
      .filter((row) => row.modelActions?.includes(action))
      .map((row) => row.key);
    lines.push(
      `- \`${action}\`: ${owners.length ? owners.map((owner) => `\`${owner}\``).join(', ') : '**internal/time-only action**'}`,
    );
  }
  lines.push(
    '',
    '## Runtime boundary model',
    '',
    `- Spec: \`${manifest.model.runtime.spec}\``,
    `- Fresh compiled observations: \`${manifest.model.runtime.observationProducer}\` via \`${manifest.model.runtime.observationBinding}\``,
    `- Checked invariants: ${manifest.model.runtime.configuredChecks.map((name) => `\`${name}\``).join(', ')}`,
    `- Bound runner source: ${manifest.model.runtime.sourceFiles.map((name) => `\`${name}\``).join(', ')}`,
    '',
  );
  for (const row of manifest.callables) {
    if (row.runtimeContracts.length)
      lines.push(
        `- \`${row.key}\`: ${row.runtimeContracts.map((name) => `\`${name}\``).join(', ')}`,
      );
  }
  lines.push(
    '',
    '## Typed-read boundary',
    '',
    `- Contract: \`${manifest.model.reads.contract}\``,
    `- Cross-adapter producer: \`${manifest.model.reads.observationProducer}\``,
    `- Bound source methods: ${manifest.model.reads.sourceMethods.map((name) => `\`${name}\``).join(', ')}`,
    '',
    '## Assurance infrastructure binding',
    '',
    `- Bound proof/checker files: **${manifest.stateMachineBinding.assuranceInfrastructureFiles.length}**`,
    `- Content digest: \`${manifest.stateMachineBinding.assuranceInfrastructureDigest}\``,
    '',
    '## Coverage rule',
    '',
    'The manifest is compiler-discovered. Any new public callable, reachable package-owned input/output/callback field, signature/type change, configured TLA invariant, or bound source/model semantic change fails assurance until this file and the machine-reviewed manifest are deliberately updated.',
    '',
  );
  return `${lines.join('\n').trimEnd()}\n`;
}

const live = surface();
for (const entrypoint of expectedEntrypoints)
  if (!(entrypoint in live.entrypoints))
    throw new Error(`Missing reviewed entrypoint '${entrypoint}'.`);
if (live.diagnostics.truncatedTypes.length)
  throw new Error(`Public type traversal truncated: ${live.diagnostics.truncatedTypes.join(', ')}`);
const current = buildManifest(live);
for (const row of [...current.callables, ...current.callableFields, ...current.fields]) {
  if (!row.evidence?.length)
    throw new Error(`Public mapping '${row.key}' has no executable evidence.`);
  for (const evidence of row.evidence)
    if (!fs.existsSync(path.join(root, evidence)))
      throw new Error(`Public mapping '${row.key}' references missing evidence '${evidence}'.`);
  if ('modelConcepts' in row && !row.modelConcepts.length)
    throw new Error(`Public field '${row.key}' has no reviewed model/abstraction concept.`);
}
const previous = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : undefined;
if (write) {
  if (
    previous?.model?.reads &&
    previous.model.reads.sourceDigest !== current.model.reads.sourceDigest &&
    previous.model.reads.modelDigest === current.model.reads.modelDigest &&
    !acknowledgePairing
  ) {
    throw new Error(
      'Bound typed-read/definition-fence semantics changed without a read-contract semantic change. Update the read abstraction or explicitly acknowledge the unchanged abstraction after review.',
    );
  }
  if (
    previous?.model?.runtime &&
    previous.model.runtime.sourceDigest !== current.model.runtime.sourceDigest &&
    previous.model.runtime.modelDigest === current.model.runtime.modelDigest &&
    !acknowledgePairing
  ) {
    throw new Error(
      'Bound managed-runner semantics changed without a WorkOnceRuntime/contract semantic change. Update the runtime model or explicitly acknowledge the unchanged abstraction after review.',
    );
  }
  if (
    previous &&
    previous.stateMachineBinding.sourceDigest !== current.stateMachineBinding.sourceDigest &&
    previous.stateMachineBinding.modelDigest === current.stateMachineBinding.modelDigest &&
    !acknowledgePairing
  ) {
    throw new Error(
      'Bound WorkOnce semantics changed without a TLA/CFG semantic change. Update the model or rerun with --ack-source-model-review only after reviewing why the abstract machine deliberately stays unchanged.',
    );
  }
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, canonicalText(current));
  fs.writeFileSync(reportPath, renderReport(current));
  console.log(
    `Wrote ${path.relative(root, manifestPath)} with ${current.callables.length} callables, ${current.callableFields.length} callable fields, ${current.fields.length} fields.`,
  );
} else {
  if (!previous)
    throw new Error(
      'Missing assurance/formal-implementation-manifest.json. Run npm run assurance:update and review it.',
    );
  compareRows(previous, current, 'Formal implementation manifest');
  const expectedReport = renderReport(current);
  const actualReport = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : '';
  if (actualReport !== expectedReport) {
    throw new Error(
      `${path.relative(root, reportPath)} drifted. Run npm run assurance:update and commit the regenerated report.`,
    );
  }
  console.log(
    `Formal implementation manifest matches ${current.callables.length} callables, ${current.callableFields.length} callable fields, ${current.fields.length} fields.`,
  );
}
