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
  'formal/WorkOncePolicy.tla',
  'formal/WorkOncePolicy.cfg',
  'formal/WorkOnceLocalRunner.tla',
  'formal/WorkOnceLocalRunner.cfg',
  'formal/WorkOnceReadHistory.tla',
  'formal/WorkOnceReadHistory.cfg',
  'formal/WorkOnceStorage.tla',
  'formal/WorkOnceStorage.cfg',
  'formal/WorkOnceExternal.tla',
  'formal/WorkOnceExternal.cfg',
  'formal/WorkOnceOutbox.tla',
  'formal/WorkOnceOutbox.cfg',
  'formal/WorkOnceOutboxBudget.tla',
  'formal/WorkOnceOutboxBudget.cfg',
];
const outboxSourceFiles = [
  'src/work.ts',
  'src/kernel.ts',
  'src/storage.ts',
  'src/memory.ts',
  'src/sqlite.ts',
  'src/cas.ts',
];
const outboxModelFiles = [
  'formal/WorkOnceOutbox.tla',
  'formal/WorkOnceOutbox.cfg',
  'formal/WorkOnceOutboxBudget.tla',
  'formal/WorkOnceOutboxBudget.cfg',
  'formal/WorkOnceContract.tla',
];
const runtimeSourceFiles = ['src/worker.ts', 'src/work.ts'];
const storageSourceFiles = [
  'src/storage.ts',
  'src/storage-validation.ts',
  'src/memory.ts',
  'src/sqlite.ts',
  'src/cas.ts',
  'src/conformance.ts',
];
const storageModelFiles = ['formal/WorkOnceStorage.tla', 'formal/WorkOnceStorage.cfg'];
const policySourceSymbols = {
  'src/work.ts': [
    'WorkRun.retry',
    'WorkRun.wait',
    'WorkRun.defer',
    'WorkRun.settle',
    'WorkQueue.waitPolicy',
    'WorkQueue.settle',
    'WorkQueue.wake',
    'WorkQueue.wakeCurrent',
  ],
  'src/kernel.ts': [
    'integer',
    'add',
    'addTimeCapped',
    'effectiveNow',
    'assertCurrent',
    'changed',
    'replayReceipt',
    'settleRecord',
  ],
  'src/retry-policy.ts': ['exponentialBackoff'],
  'src/outcomes.ts': ['retry', 'wait', 'defer'],
};
const policySourceFiles = Object.keys(policySourceSymbols);
const policyModelFiles = ['formal/WorkOncePolicy.tla', 'formal/WorkOncePolicy.cfg'];
const externalSourceSymbols = {
  'src/external.ts': [
    'ExternalWorkRun.succeed',
    'ExternalWorkRun.retry',
    'ExternalWorkRun.wait',
    'ExternalWorkRun.defer',
    'ExternalWorkRun.fail',
    'validateExternalWorkerOptions',
    'processLease',
    'runExternalAvailable',
    'processExternal',
    'runExternal',
  ],
  'src/work.ts': ['WorkRun.handoff', 'WorkQueue.handoff', 'WorkQueue.serveExternal'],
  'src/worker.ts': ['waitForPoll'],
  'src/kernel.ts': ['integer'],
};
const externalSourceFiles = Object.keys(externalSourceSymbols);
const externalModelFiles = ['formal/WorkOnceExternal.tla', 'formal/WorkOnceExternal.cfg'];
const localRunnerSourceSymbols = {
  'src/worker.ts': [
    'markLocalClaimStartedAt',
    'validateWorkerOptions',
    'waitForPoll',
    'processClaim',
    'processClaims',
    'runWorker',
  ],
  'src/work.ts': [
    'WorkQueue.claim',
    'WorkQueue.runAvailable',
    'WorkQueue.process',
    'WorkQueue.run',
  ],
};
const localRunnerSourceFiles = Object.keys(localRunnerSourceSymbols);
const localRunnerModelFiles = ['formal/WorkOnceLocalRunner.tla', 'formal/WorkOnceLocalRunner.cfg'];
const runtimeModelFiles = [
  'formal/WorkOnceRuntime.tla',
  'formal/WorkOnceRuntime.cfg',
  'formal/WorkOnceContract.tla',
  'formal/WorkOnceLocalRunner.tla',
  'formal/WorkOnceLocalRunner.cfg',
];
const readModelFiles = [
  'formal/WorkOnceContract.tla',
  'formal/WorkOnceReadHistory.tla',
  'formal/WorkOnceReadHistory.cfg',
];
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
const readSourceSymbols = {
  'src/work.ts': readSourceMethods,
  'src/kernel.ts': ['changed'],
};
const readSourceFiles = Object.keys(readSourceSymbols);
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
  'scripts/read-history-refinement.mjs',
  'scripts/check-read-history-mutations.mjs',
  'test/read-history-refinement.test.mjs',
  'formal/WorkOnceReadHistory.tla',
  'formal/WorkOnceReadHistory.cfg',
  'assurance/red-before/read-history-future-congruence.json',
  'scripts/local-runner-refinement.mjs',
  'scripts/check-local-runner-implementation-mutations.mjs',
  'scripts/check-local-runner-source-model-mutation.mjs',
  'test/local-runner-refinement.test.mjs',
  'test/process/local-runner-child.mjs',
  'test/process/local-runner-process.test.mjs',
  'formal/WorkOnceLocalRunner.tla',
  'formal/WorkOnceLocalRunner.cfg',
  'assurance/red-before/local-runner-heartbeat-cause.json',
  'scripts/policy-refinement.mjs',
  'scripts/check-policy-source-model-binding-mutation.mjs',
  'scripts/check-policy-implementation-mutations.mjs',
  'scripts/external-transport-refinement.mjs',
  'scripts/check-external-source-model-mutation.mjs',
  'scripts/check-external-implementation-mutations.mjs',
  'test/external-transport-refinement.test.mjs',
  'test/process/external-effect-child.mjs',
  'test/process/external-effect-process.test.mjs',
  'formal/WorkOnceExternal.tla',
  'formal/WorkOnceExternal.cfg',
  'scripts/outbox-refinement.mjs',
  'scripts/check-outbox-source-model-binding-mutation.mjs',
  'scripts/check-outbox-implementation-mutations.mjs',
  'test/outbox-refinement.test.mjs',
  'test/outbox-cursor-control.test.mjs',
  'test/process/outbox-process.test.mjs',
  'test/process/outbox-child.mjs',
  'formal/WorkOnceOutbox.tla',
  'formal/WorkOnceOutbox.cfg',
  'formal/WorkOnceOutboxBudget.tla',
  'formal/WorkOnceOutboxBudget.cfg',
  'test/process/sqlite-busy-child.mjs',
  'test/process/sqlite-busy-startup.test.mjs',
  'test/storage-contract-hardening.test.mjs',
  'test/storage-refinement.test.mjs',
  'test/process/storage-child.mjs',
  'test/process/storage-process.test.mjs',
  'scripts/check-storage-contract-mutation.mjs',
  'scripts/check-storage-source-model-mutation.mjs',
  'scripts/storage-formal.mjs',
  'scripts/storage-refinement.mjs',
  'formal/WorkOnceStorage.tla',
  'formal/WorkOnceStorage.cfg',
  'assurance/red-before/storage-conformance-baseline.json',
  'scripts/run-assurance.mjs',
  'scripts/consumer-smoke.mjs',
  'scripts/prepare-package.mjs',
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
function sourceSymbolDigest(bindings, label) {
  const found = [];
  const expected = [];
  for (const [relativePath, names] of Object.entries(bindings)) {
    const file = path.join(root, relativePath);
    const text = fs.readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const wanted = new Set(names);
    for (const name of names) expected.push(`${relativePath}:${name}`);
    for (const node of source.statements) {
      if (ts.isFunctionDeclaration(node) && node.name && wanted.has(node.name.text)) {
        const key = `${relativePath}:${node.name.text}`;
        found.push(`${key}\n${semanticTokenString(node.getText(source))}`);
      }
      if (!ts.isClassDeclaration(node) || !node.name) continue;
      const className = node.name.text;
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.name) continue;
        const symbol = `${className}.${member.name.getText(source)}`;
        if (!wanted.has(symbol)) continue;
        const key = `${relativePath}:${symbol}`;
        found.push(`${key}\n${semanticTokenString(member.getText(source))}`);
      }
    }
  }
  const keys = found.map((entry) => entry.slice(0, entry.indexOf('\n'))).sort(compareExact);
  expected.sort(compareExact);
  if (JSON.stringify(keys) !== JSON.stringify(expected))
    throw new Error(
      `${label} source binding drifted: expected=${expected.join(',')} found=${keys.join(',')}`,
    );
  return digest(found.sort(compareExact).join('\n---\n'));
}
function readSurfaceDigest() {
  return sourceSymbolDigest(readSourceSymbols, 'Typed-read/history');
}
function policySurfaceDigest() {
  return sourceSymbolDigest(policySourceSymbols, 'Retry/defer policy');
}
function externalSurfaceDigest() {
  return sourceSymbolDigest(externalSourceSymbols, 'External transport');
}
function localRunnerSurfaceDigest() {
  return sourceSymbolDigest(localRunnerSourceSymbols, 'Local managed runner');
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
  if (fieldName === 'afterId') return ['outboxCursor', 'storageOrdering'];
  if (fieldName === 'outbox') return ['pendingNext', 'childCreated', 'outboxQueue'];
  if (fieldName === 'submissionHash' || fieldName === 'receipt')
    return ['policyReceiptIdentity', 'settlementReplay'];
  if (fieldName === 'afterMs' || fieldName === 'at') return ['available', 'now', 'policyTiming'];
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
    return ['CreateChild', 'AckChild', 'OutboxDispatch', 'OutboxBudgetDispatch'];
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
      const modelActions = modelActionsForKey(row.key);
      const policyRelevant = modelActions.some((action) =>
        ['Retry', 'Defer', 'Wake'].includes(action),
      );
      const localRunnerRelevant = [
        'root.WorkQueue.runAvailable',
        'root.WorkQueue.process',
        'root.WorkQueue.run',
      ].includes(row.key);
      const externalRelevant =
        row.key.startsWith('external.') ||
        [
          'root.runExternalAvailable',
          'root.processExternal',
          'root.runExternal',
          'root.WorkQueue.handoff',
          'root.WorkQueue.serveExternal',
          'root.WorkRun.handoff',
        ].includes(row.key);
      callables.push({
        key: row.key,
        classification,
        signatureHash: signatureHash(row),
        modelActions,
        runtimeContracts,
        evidence: [
          ...evidenceByClassification[classification],
          'test/runtime-boundary-refinement.test.mjs',
          'test/lifecycle-transition-matrix.test.mjs',
          ...(runtimeContracts.includes('ReadAllowed')
            ? ['test/read-boundary-refinement.test.mjs']
            : []),
          ...(policyRelevant ? ['test/policy-refinement.test.mjs'] : []),
          ...(localRunnerRelevant ? ['test/local-runner-refinement.test.mjs'] : []),
          ...(externalRelevant ? ['test/external-transport-refinement.test.mjs'] : []),
          ...(modelActions.includes('OutboxDispatch') ? ['test/outbox-refinement.test.mjs'] : []),
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
        'OutboxDispatch',
        'OutboxBudgetDispatch',
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
      localRunner: {
        spec: 'formal/WorkOnceLocalRunner.tla',
        config: 'formal/WorkOnceLocalRunner.cfg',
        configuredChecks: readConfiguredChecks('formal/WorkOnceLocalRunner.cfg'),
        observationProducer: 'scripts/local-runner-refinement.mjs',
        observationBinding: 'scripts/formal.mjs',
        sourceFiles: localRunnerSourceFiles,
        sourceSymbols: localRunnerSourceSymbols,
        modelFiles: localRunnerModelFiles,
        sourceDigest: localRunnerSurfaceDigest(),
        modelDigest: formalDigest(localRunnerModelFiles),
      },
      reads: {
        contract: 'formal/WorkOnceContract.tla',
        historySpec: 'formal/WorkOnceReadHistory.tla',
        historyConfig: 'formal/WorkOnceReadHistory.cfg',
        historyConfiguredChecks: readConfiguredChecks('formal/WorkOnceReadHistory.cfg'),
        observationProducer: 'scripts/read-boundary-refinement.mjs',
        historyObservationProducer: 'scripts/read-history-refinement.mjs',
        observationBridge: 'scripts/runtime-boundary-refinement.mjs',
        observationBinding: 'scripts/formal.mjs',
        sourceFiles: readSourceFiles,
        sourceMethods: readSourceMethods,
        sourceSymbols: readSourceSymbols,
        sourceDigest: readSurfaceDigest(),
        modelFiles: readModelFiles,
        modelDigest: formalDigest(readModelFiles),
      },
      policy: {
        spec: 'formal/WorkOncePolicy.tla',
        config: 'formal/WorkOncePolicy.cfg',
        configuredChecks: readConfiguredChecks('formal/WorkOncePolicy.cfg'),
        observationProducer: 'scripts/policy-refinement.mjs',
        observationBinding: 'scripts/formal.mjs',
        sourceFiles: policySourceFiles,
        sourceSymbols: policySourceSymbols,
        modelFiles: policyModelFiles,
        sourceDigest: policySurfaceDigest(),
        modelDigest: formalDigest(policyModelFiles),
      },
      outbox: {
        spec: 'formal/WorkOnceOutbox.tla',
        config: 'formal/WorkOnceOutbox.cfg',
        contract: 'formal/WorkOnceContract.tla',
        configuredChecks: readConfiguredChecks('formal/WorkOnceOutbox.cfg'),
        observationProducer: 'scripts/outbox-refinement.mjs',
        observationBinding: 'scripts/formal.mjs',
        mutationInvariant: 'HealthyReachedByThirdPass',
        sourceFiles: outboxSourceFiles,
        modelFiles: outboxModelFiles,
        sourceDigest: semanticSourceDigest(outboxSourceFiles),
        modelDigest: formalDigest(outboxModelFiles),
      },
      outboxBudget: {
        spec: 'formal/WorkOnceOutboxBudget.tla',
        config: 'formal/WorkOnceOutboxBudget.cfg',
        configuredChecks: readConfiguredChecks('formal/WorkOnceOutboxBudget.cfg'),
        mutationInvariant: 'AllReachedByFourth',
      },
      external: {
        spec: 'formal/WorkOnceExternal.tla',
        config: 'formal/WorkOnceExternal.cfg',
        configuredChecks: readConfiguredChecks('formal/WorkOnceExternal.cfg'),
        observationProducer: 'scripts/external-transport-refinement.mjs',
        observationBinding: 'scripts/formal.mjs',
        sourceFiles: externalSourceFiles,
        sourceSymbols: externalSourceSymbols,
        modelFiles: externalModelFiles,
        sourceDigest: externalSurfaceDigest(),
        modelDigest: formalDigest(externalModelFiles),
      },
      storage: {
        spec: 'formal/WorkOnceStorage.tla',
        config: 'formal/WorkOnceStorage.cfg',
        configuredChecks: readConfiguredChecks('formal/WorkOnceStorage.cfg'),
        observationProducer: 'scripts/storage-refinement.mjs',
        observationBinding: 'scripts/storage-formal.mjs',
        sourceFiles: storageSourceFiles,
        modelFiles: storageModelFiles,
        sourceDigest: semanticSourceDigest(storageSourceFiles),
        modelDigest: formalDigest(storageModelFiles),
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
    '## Local managed-runner boundary',
    '',
    `- Spec: \`${manifest.model.localRunner.spec}\``,
    `- Fresh compiled observations: \`${manifest.model.localRunner.observationProducer}\` via \`${manifest.model.localRunner.observationBinding}\``,
    `- Checked invariants: ${manifest.model.localRunner.configuredChecks.map((name) => `\`${name}\``).join(', ')}`,
    `- Bound local-runner source symbols: ${Object.entries(manifest.model.localRunner.sourceSymbols)
      .flatMap(([file, names]) => names.map((name) => `\`${file}:${name}\``))
      .join(', ')}`,
    '',
    '## Typed-read boundary',
    '',
    `- Contract: \`${manifest.model.reads.contract}\``,
    `- Cross-adapter producer: \`${manifest.model.reads.observationProducer}\``,
    `- Bound source methods: ${manifest.model.reads.sourceMethods.map((name) => `\`${name}\``).join(', ')}`,
    `- History spec: \`${manifest.model.reads.historySpec}\` via \`${manifest.model.reads.historyObservationProducer}\``,
    `- History invariants: ${manifest.model.reads.historyConfiguredChecks.map((name) => `\`${name}\``).join(', ')}`,
    '',
    '## Retry/defer policy boundary',
    '',
    `- Spec: \`${manifest.model.policy.spec}\``,
    `- Fresh compiled observations: \`${manifest.model.policy.observationProducer}\` via \`${manifest.model.policy.observationBinding}\``,
    `- Checked invariants: ${manifest.model.policy.configuredChecks.map((name) => `\`${name}\``).join(', ')}`,
    `- Bound policy source symbols: ${Object.entries(manifest.model.policy.sourceSymbols)
      .flatMap(([file, names]) => names.map((name) => `\`${file}:${name}\``))
      .join(', ')}`,
    '',
    '## Outbox scheduler model',
    '',
    `- Spec: \`${manifest.model.outbox.spec}\``,
    `- Fresh compiled observations: \`${manifest.model.outbox.observationProducer}\` via \`${manifest.model.outbox.observationBinding}\``,
    `- Checked invariants: ${manifest.model.outbox.configuredChecks.map((name) => `\`${name}\``).join(', ')}`,
    `- Mutation guard: \`${manifest.model.outbox.mutationInvariant}\``,
    `- Bound scheduler source: ${manifest.model.outbox.sourceFiles.map((name) => `\`${name}\``).join(', ')}`,
    `- Budget spec: \`${manifest.model.outboxBudget.spec}\``,
    `- Budget checked invariants: ${manifest.model.outboxBudget.configuredChecks.map((name) => `\`${name}\``).join(', ')}`,
    `- Budget mutation guard: \`${manifest.model.outboxBudget.mutationInvariant}\``,
    '',
    '## External transport boundary',
    '',
    `- Spec: \`${manifest.model.external.spec}\``,
    `- Fresh compiled observations: \`${manifest.model.external.observationProducer}\` via \`${manifest.model.external.observationBinding}\``,
    `- Checked invariants: ${manifest.model.external.configuredChecks.map((name) => `\`${name}\``).join(', ')}`,
    `- Bound external source symbols: ${Object.entries(manifest.model.external.sourceSymbols)
      .flatMap(([file, names]) => names.map((name) => `\`${file}:${name}\``))
      .join(', ')}`,
    '',
    '## Storage/conformance model',
    '',
    `- Spec: \`${manifest.model.storage.spec}\``,
    `- Fresh compiled observations: \`${manifest.model.storage.observationProducer}\` via \`${manifest.model.storage.observationBinding}\``,
    `- Checked invariants: ${manifest.model.storage.configuredChecks.map((name) => `\`${name}\``).join(', ')}`,
    `- Bound storage source: ${manifest.model.storage.sourceFiles.map((name) => `\`${name}\``).join(', ')}`,
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

function assertSourceModelPairing(previousBinding, currentBinding, message) {
  if (
    previousBinding &&
    previousBinding.sourceDigest !== currentBinding.sourceDigest &&
    previousBinding.modelDigest === currentBinding.modelDigest &&
    !acknowledgePairing
  )
    throw new Error(message);
}

if (process.argv.includes('--check-infrastructure-binding-only')) {
  if (!fs.existsSync(manifestPath))
    throw new Error(
      'Missing assurance/formal-implementation-manifest.json. Run npm run assurance:update and review it.',
    );
  const previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expected = previous.stateMachineBinding?.assuranceInfrastructureDigest;
  const actual = contentDigest(assuranceInfrastructureFiles);
  if (expected !== actual)
    throw new Error(
      `Assurance infrastructure digest drifted: expected=${expected ?? 'missing'} actual=${actual}`,
    );
  console.log('Assurance infrastructure content binding matches the reviewed manifest.');
  process.exit(0);
}

const bindingOnly = process.argv.find((argument) =>
  [
    '--check-read-binding-only',
    '--check-policy-binding-only',
    '--check-local-runner-binding-only',
    '--check-storage-binding-only',
    '--check-external-binding-only',
  ].includes(argument),
);
if (bindingOnly) {
  if (!fs.existsSync(manifestPath))
    throw new Error(
      'Missing assurance/formal-implementation-manifest.json. Run npm run assurance:update and review it.',
    );
  const previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (bindingOnly === '--check-read-binding-only') {
    assertSourceModelPairing(
      previous.model?.reads,
      { sourceDigest: readSurfaceDigest(), modelDigest: formalDigest(readModelFiles) },
      'Bound typed-read/history semantics changed without a read-model semantic change. Update the read/history abstraction or explicitly acknowledge the unchanged abstraction after review.',
    );
  } else if (bindingOnly === '--check-policy-binding-only') {
    assertSourceModelPairing(
      previous.model?.policy,
      { sourceDigest: policySurfaceDigest(), modelDigest: formalDigest(policyModelFiles) },
      'Bound retry/defer policy semantics changed without a WorkOncePolicy semantic change. Update the policy model or explicitly acknowledge the unchanged abstraction after review.',
    );
  } else if (bindingOnly === '--check-local-runner-binding-only') {
    assertSourceModelPairing(
      previous.model?.localRunner,
      {
        sourceDigest: localRunnerSurfaceDigest(),
        modelDigest: formalDigest(localRunnerModelFiles),
      },
      'Bound local managed-runner semantics changed without a WorkOnceLocalRunner semantic change. Update the local-runner model or explicitly acknowledge the unchanged abstraction after review.',
    );
  } else if (bindingOnly === '--check-external-binding-only') {
    assertSourceModelPairing(
      previous.model?.external,
      { sourceDigest: externalSurfaceDigest(), modelDigest: formalDigest(externalModelFiles) },
      'Bound external transport semantics changed without a WorkOnceExternal semantic change. Update the external model or explicitly acknowledge the unchanged abstraction after review.',
    );
  } else {
    assertSourceModelPairing(
      previous.model?.storage,
      {
        sourceDigest: semanticSourceDigest(storageSourceFiles),
        modelDigest: formalDigest(storageModelFiles),
      },
      'Bound storage/conformance semantics changed without a WorkOnceStorage formal change. Update the storage abstraction or explicitly acknowledge the unchanged abstraction after review.',
    );
  }
  console.log(`Source/model binding matches for ${bindingOnly}.`);
  process.exit(0);
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
  assertSourceModelPairing(
    previous?.model?.localRunner,
    current.model.localRunner,
    'Bound local managed-runner semantics changed without a WorkOnceLocalRunner semantic change. Update the local-runner model or explicitly acknowledge the unchanged abstraction after review.',
  );
  assertSourceModelPairing(
    previous?.model?.policy,
    current.model.policy,
    'Bound retry/defer policy semantics changed without a WorkOncePolicy semantic change. Update the policy model or explicitly acknowledge the unchanged abstraction after review.',
  );
  assertSourceModelPairing(
    previous?.model?.reads,
    current.model.reads,
    'Bound typed-read/history semantics changed without a read-model semantic change. Update the read/history abstraction or explicitly acknowledge the unchanged abstraction after review.',
  );
  assertSourceModelPairing(
    previous?.model?.runtime,
    current.model.runtime,
    'Bound managed-runner semantics changed without a WorkOnceRuntime/contract semantic change. Update the runtime model or explicitly acknowledge the unchanged abstraction after review.',
  );
  assertSourceModelPairing(
    previous?.model?.external,
    current.model.external,
    'Bound external transport semantics changed without a WorkOnceExternal semantic change. Update the external model or explicitly acknowledge the unchanged abstraction after review.',
  );
  assertSourceModelPairing(
    previous?.model?.storage,
    current.model.storage,
    'Bound storage/conformance semantics changed without a WorkOnceStorage formal change. Update the storage abstraction or explicitly acknowledge the unchanged abstraction after review.',
  );
  if (
    previous?.model?.outbox?.sourceDigest &&
    previous.model.outbox.sourceDigest !== current.model.outbox.sourceDigest &&
    previous.model.outbox.modelDigest === current.model.outbox.modelDigest &&
    !acknowledgePairing
  ) {
    throw new Error(
      'Bound outbox scheduler semantics changed without an outbox model semantic change. Update the outbox abstraction or explicitly acknowledge the unchanged abstraction after review.',
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
