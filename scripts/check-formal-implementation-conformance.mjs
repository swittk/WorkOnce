import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireSuccessfulProcess } from './subprocess-outcome.mjs';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const sourceDigestSchema = 'typescript-ast-printer-directives-v3';
const formalDigestSchema = 'tla-lexical-string-safe-v2';
const semanticPrinter = ts.createPrinter({
  removeComments: true,
  newLine: ts.NewLineKind.LineFeed,
});
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
  'formal/WorkOnceLifecycleTemporal.tla',
  'formal/WorkOnceLifecycleTemporal.cfg',
  'formal/WorkOnceClaimScan.tla',
  'formal/WorkOnceClaimScan.cfg',
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
    'validateClaimBatch',
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
const semanticEnvironmentFiles = [
  'tsconfig.json',
  'tsconfig.cjs.json',
  'tsconfig.tests.json',
  'tsconfig.webworker.json',
  'package.json',
  'package-lock.json',
];
const redBeforeEvidenceFiles = fs
  .readdirSync(path.join(root, 'assurance/red-before'))
  .filter((name) => name.endsWith('.json'))
  .map((name) => `assurance/red-before/${name}`)
  .sort();

function normalizedRedBeforeItems(record) {
  if (Array.isArray(record.findings)) return record.findings;
  if (Array.isArray(record.defects)) return record.defects;
  if (typeof record.defect === 'string')
    return [{ kind: record.kind ?? record.classification ?? 'defect' }];
  if (record.runtimeSemanticBug && typeof record.runtimeSemanticBug === 'object')
    return [record.runtimeSemanticBug];
  if (typeof record.summary === 'string')
    return [{ kind: record.kind ?? record.classification ?? 'summary' }];
  if (typeof record.classification === 'string') return [{ kind: record.classification }];
  if (Array.isArray(record.classification)) return record.classification.map((kind) => ({ kind }));
  return [];
}

function assertRedBeforeEvidenceCorpus() {
  if (redBeforeEvidenceFiles.length === 0)
    throw new Error('Red-before evidence corpus is unexpectedly empty.');
  for (const relative of redBeforeEvidenceFiles) {
    const record = JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record))
      throw new Error(`Red-before evidence ${relative} must be a JSON object.`);
    const discriminator =
      record.family ??
      record.classification ??
      record.kind ??
      (Number.isSafeInteger(record.reviewId) ? 'review' : undefined);
    if (typeof discriminator !== 'string' || discriminator.length === 0)
      throw new Error(
        `Red-before evidence ${relative} lacks a family/classification/kind/review discriminator.`,
      );
    const items = normalizedRedBeforeItems(record);
    if (
      items.length === 0 ||
      items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))
    )
      throw new Error(`Red-before evidence ${relative} has no normalized evidence items.`);
  }
}
assertRedBeforeEvidenceCorpus();

function assertFirstFatalRedBeforeEvidence() {
  const evidencePath = path.join(root, 'assurance/red-before/review-5150143046-first-fatal.json');
  const record = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const finding = record.findings?.[0];
  const red = finding?.redBefore;
  if (
    record.schemaVersion !== 1 ||
    record.family !== 'managed-runner-first-fatal-preservation' ||
    record.reviewId !== 5150143046 ||
    record.findings?.length !== 1 ||
    finding.commentId !== 3964968470 ||
    finding.streakRelevant !== true ||
    typeof red?.publicPath !== 'string' ||
    !red.publicPath.includes('run({concurrency:2}') ||
    red.firstFailure !== 'first-fatal-A' ||
    red.secondFailure !== 'second-fatal-B' ||
    red.returnedFailure !== 'second-fatal-B' ||
    red.returnedFirst !== false ||
    red.returnedSecond !== true ||
    red.probeExitCode !== 17
  )
    throw new Error(
      'First-fatal red-before evidence no longer proves the supported concurrent-run failure-order defect.',
    );
}
assertFirstFatalRedBeforeEvidence();

const assuranceInfrastructureFiles = [
  'scripts/check-formal-implementation-conformance.mjs',
  'test/source-semantic-hash.test.mjs',
  'scripts/formal-implementation-surface.cjs',
  'scripts/check-bounded-trace-domain.mjs',
  'scripts/formal.mjs',
  'scripts/runtime-boundary-refinement.mjs',
  'scripts/formal-bounded-refinement-corpus.mjs',
  'scripts/build-source-binding.mjs',
  'scripts/check-build-source-binding-mutation.mjs',
  'scripts/check-build-input-binding-mutation.mjs',
  'scripts/check-assurance-infrastructure-binding-mutation.mjs',
  'scripts/check-assurance-scheduling.mjs',
  'scripts/check-lifecycle-proof-binding.mjs',
  'scripts/check-lifecycle-source-model-mutation.mjs',
  'scripts/check-lifecycle-implementation-mutations.mjs',
  'scripts/check-alias-contract-mutation.mjs',
  'scripts/check-source-path-portability-mutation.mjs',
  'assurance/red-before/manifest-worktree-source-path-portability.json',
  'scripts/check-assurance-scheduling-mutation.mjs',
  'assurance/red-before/formal-shard-cross-family-tlc-concurrency.json',
  'assurance/red-before/review-5149212380-conformance-batch.json',
  'assurance/red-before/review-a5a23d8-formal-surface-gaps.json',
  'assurance/red-before/review-5152274957-formal-assurance-gaps.json',
  'assurance/red-before/mutation-guard-cross-contamination.json',
  'assurance/red-before/process-fault-test-concurrency.json',
  'assurance/red-before/unbound-assurance-runner.json',
  'scripts/tlc-outcome.mjs',
  'scripts/subprocess-outcome.mjs',
  'test/subprocess-outcome.test.mjs',
  'scripts/check-assurance-verdict-integrity.mjs',
  'scripts/mutation-file-guard.mjs',
  'scripts/refinement-sample-schema.mjs',
  'scripts/refinement-sqlite-fixture.mjs',
  'scripts/check-assurance-verdict-integrity-mutation.mjs',
  'assurance/red-before/review-5148224210-assurance-verdict-integrity.json',
  'scripts/tlc-workspace.mjs',
  'test/tlc-workspace.test.mjs',
  'scripts/check-tlc-workspace-isolation.mjs',
  'scripts/check-tlc-workspace-isolation-mutation.mjs',
  'assurance/red-before/tlc-cross-invocation-workspace-collision.json',
  'scripts/check-tlc-outcome-classification.mjs',
  'scripts/check-formal-config-coverage-mutation.mjs',
  'scripts/internal-semantic-surface.mjs',
  'test/internal-semantic-surface.test.mjs',
  'scripts/check-internal-semantic-inventory.mjs',
  'scripts/check-internal-semantic-inventory-mutation.mjs',
  'assurance/internal-semantic-inventory.json',
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
  'test/process/child-ipc-inbox.mjs',
  'formal/WorkOnceLocalRunner.tla',
  'formal/WorkOnceLocalRunner.cfg',
  'assurance/red-before/local-runner-heartbeat-cause.json',
  'assurance/red-before/review-5150143046-first-fatal.json',
  'assurance/red-before/tlc-infrastructure-classification.json',
  'assurance/red-before/internal-mutable-property-topology.json',
  'assurance/red-before/internal-mutable-container-updates.json',
  'assurance/red-before/source-semantic-hash-collision.json',
  'assurance/red-before/formal-semantic-hash-collision.json',
  'assurance/red-before/compiler-directive-semantic-hash.json',
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
  ...semanticEnvironmentFiles,
  'assurance/red-before/compiler-config-semantic-binding.json',
];
for (const evidenceFile of redBeforeEvidenceFiles)
  if (!assuranceInfrastructureFiles.includes(evidenceFile))
    assuranceInfrastructureFiles.push(evidenceFile);
const uniqueAssuranceInfrastructureFiles = [...new Set(assuranceInfrastructureFiles)];
if (uniqueAssuranceInfrastructureFiles.length !== assuranceInfrastructureFiles.length)
  throw new Error('assuranceInfrastructureFiles contains duplicate bound paths.');
assuranceInfrastructureFiles.length = 0;
assuranceInfrastructureFiles.push(...uniqueAssuranceInfrastructureFiles.sort(compareExact));

function assertAssuranceRunnerScriptsBound() {
  const runnerPath = path.join(root, 'scripts/run-assurance.mjs');
  const runnerText = fs.readFileSync(runnerPath, 'utf8');
  const source = ts.createSourceFile(
    runnerPath,
    runnerText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const invoked = new Set();
  function visit(node) {
    if (ts.isStringLiteralLike(node) && /^scripts\/[A-Za-z0-9._/-]+\.(?:mjs|cjs)$/u.test(node.text))
      invoked.add(node.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const unbound = [...invoked]
    .filter((file) => !assuranceInfrastructureFiles.includes(file))
    .sort();
  if (unbound.length)
    throw new Error(`Full assurance invokes unbound proof/checker scripts: ${unbound.join(', ')}`);
}
assertAssuranceRunnerScriptsBound();

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
function parseSemanticSource(file, text, scriptKind = ts.ScriptKind.TS) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);
  if (source.parseDiagnostics.length) {
    const detail = source.parseDiagnostics
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
      .join('; ');
    throw new Error(`Cannot bind syntactically invalid semantic source ${file}: ${detail}`);
  }
  return source;
}
function normalizedCompilerMetadataValue(value) {
  if (Array.isArray(value)) return value.map(normalizedCompilerMetadataValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['pos', 'end', 'range', 'kind', 'hasTrailingNewLine'].includes(key))
      .sort(([a], [b]) => compareExact(a, b))
      .map(([key, child]) => [key, normalizedCompilerMetadataValue(child)]),
  );
}
function directiveTargetTokenOrdinal(source, end) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source.text,
  );
  let ordinal = 0;
  for (;;) {
    const token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) return 'eof';
    if (token >= ts.SyntaxKind.FirstTriviaToken && token <= ts.SyntaxKind.LastTriviaToken) continue;
    if (scanner.getTokenPos() >= end) return ordinal;
    ordinal++;
  }
}
function compilerSemanticMetadata(source) {
  const commentDirectives = (source.commentDirectives ?? []).map((directive) => ({
    type: directive.type,
    targetTokenOrdinal: directiveTargetTokenOrdinal(source, directive.range.end),
  }));
  const pragmas = [...source.pragmas.entries()]
    .sort(([a], [b]) => compareExact(a, b))
    .map(([name, value]) => [name, normalizedCompilerMetadataValue(value)]);
  return canonicalText({
    commentDirectives,
    pragmas,
    referencedFiles: source.referencedFiles.map((value) => normalizedCompilerMetadataValue(value)),
    typeReferenceDirectives: source.typeReferenceDirectives.map((value) =>
      normalizedCompilerMetadataValue(value),
    ),
    libReferenceDirectives: source.libReferenceDirectives.map((value) =>
      normalizedCompilerMetadataValue(value),
    ),
    amdDependencies: source.amdDependencies.map((value) => normalizedCompilerMetadataValue(value)),
    hasNoDefaultLib: source.hasNoDefaultLib,
  }).trimEnd();
}
function legacyAstPrinterText(file, text, scriptKind = ts.ScriptKind.TS) {
  return semanticPrinter
    .printFile(parseSemanticSource(file, text, scriptKind))
    .replace(/\r\n?/gu, '\n')
    .trimEnd();
}
function semanticSyntaxText(file, text, scriptKind = ts.ScriptKind.TS) {
  const source = parseSemanticSource(file, text, scriptKind);
  const printed = semanticPrinter.printFile(source).replace(/\r\n?/gu, '\n').trimEnd();
  return `${printed}\n/* compiler-semantic-metadata */\n${compilerSemanticMetadata(source)}`;
}
function semanticNodeText(node, source) {
  const printed = semanticPrinter
    .printNode(ts.EmitHint.Unspecified, node, source)
    .replace(/\r\n?/gu, '\n')
    .trim();
  return `${printed}\n/* compiler-semantic-metadata */\n${compilerSemanticMetadata(source)}`;
}
function semanticSourceDigest(files) {
  const chunks = [];
  for (const relativePath of [...files].sort(compareExact)) {
    const text = fs.readFileSync(path.join(root, relativePath), 'utf8');
    chunks.push(`${relativePath}\n${semanticSyntaxText(relativePath, text)}`);
  }
  return digest(chunks.join('\n---\n'));
}
const tlaMultiCharacterSymbols = [
  '<=>',
  '|->',
  '=>',
  '==',
  '<=',
  '>=',
  '/=',
  '->',
  '~>',
  '..',
  '<<',
  '>>',
  '[]',
  '<>',
  ':>',
  '@@',
  '/\\',
  '\\/',
].sort((a, b) => b.length - a.length || compareExact(a, b));
function tlaSemanticTokens(text) {
  const normalized = text.replace(/\r\n?/gu, '\n');
  const tokens = [];
  let index = 0;
  let separated = true;
  let previousKind;
  const push = (kind, value) => {
    const adjacency =
      !separated && previousKind === 'symbol' && kind === 'symbol' ? 'adjacent:' : '';
    tokens.push(`${adjacency}${kind}:${value}`);
    previousKind = kind;
    separated = false;
  };
  while (index < normalized.length) {
    const char = normalized[index];
    if (/\s/u.test(char)) {
      separated = true;
      index++;
      continue;
    }
    if (normalized.startsWith('\\*', index)) {
      separated = true;
      index += 2;
      while (index < normalized.length && normalized[index] !== '\n') index++;
      continue;
    }
    if (normalized.startsWith('(*', index)) {
      separated = true;
      index += 2;
      let depth = 1;
      while (index < normalized.length && depth > 0) {
        if (normalized.startsWith('(*', index)) {
          depth++;
          index += 2;
        } else if (normalized.startsWith('*)', index)) {
          depth--;
          index += 2;
        } else {
          index++;
        }
      }
      if (depth !== 0) throw new Error('Unterminated TLA block comment in semantic digest input.');
      continue;
    }
    if (char === '"') {
      const start = index++;
      let closed = false;
      while (index < normalized.length) {
        const current = normalized[index++];
        if (current === '\\') {
          if (index >= normalized.length)
            throw new Error('Unterminated TLA string escape in semantic digest input.');
          index++;
          continue;
        }
        if (current === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error('Unterminated TLA string in semantic digest input.');
      push('string', normalized.slice(start, index));
      continue;
    }
    if (/[A-Za-z_$]/u.test(char)) {
      const start = index++;
      while (index < normalized.length && /[A-Za-z0-9_$]/u.test(normalized[index])) index++;
      push('word', normalized.slice(start, index));
      continue;
    }
    if (/[0-9]/u.test(char)) {
      const start = index++;
      while (index < normalized.length && /[0-9]/u.test(normalized[index])) index++;
      if (
        normalized[index] === '.' &&
        index + 1 < normalized.length &&
        /[0-9]/u.test(normalized[index + 1])
      ) {
        index++;
        while (index < normalized.length && /[0-9]/u.test(normalized[index])) index++;
      }
      push('number', normalized.slice(start, index));
      continue;
    }
    if (char === '\\') {
      const start = index++;
      if (index < normalized.length && /[A-Za-z]/u.test(normalized[index])) {
        while (index < normalized.length && /[A-Za-z]/u.test(normalized[index])) index++;
      } else if (index < normalized.length) {
        index++;
      }
      push('symbol', normalized.slice(start, index));
      continue;
    }
    const multi = tlaMultiCharacterSymbols.find((symbol) => normalized.startsWith(symbol, index));
    if (multi) {
      push('symbol', multi);
      index += multi.length;
      continue;
    }
    push('symbol', char);
    index++;
  }
  return tokens.join('\n');
}
function legacyFormalText(text) {
  return text
    .replace(/\(\*[\s\S]*?\*\)/gu, '')
    .replace(/\\\*.*$/gmu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}
function formalSemanticText(text) {
  return tlaSemanticTokens(text);
}
function formalDigest(files) {
  const chunks = [];
  for (const relativePath of [...files].sort(compareExact)) {
    const text = fs.readFileSync(path.join(root, relativePath), 'utf8');
    chunks.push(`${relativePath}\n${formalSemanticText(text)}`);
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
  return semanticSyntaxText('semantic-hash-canary.ts', text);
}
function semanticMethodString(text) {
  const source = parseSemanticSource(
    'semantic-method-hash-canary.ts',
    `class SemanticHashCanary { ${text} }`,
  );
  const declaration = source.statements.find((node) => ts.isClassDeclaration(node));
  const member = declaration?.members[0];
  if (!member) throw new Error('Semantic method hash canary did not parse one class member.');
  return semanticNodeText(member, source);
}
function legacyTriviaStrippedTokens(text) {
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
function assertSemanticHashFidelity() {
  const behaviorPairs = [
    [
      'return-linebreak',
      'function f():number|undefined { return 7; }',
      'function f():number|undefined { return\n7; }',
    ],
    [
      'postfix-linebreak',
      'function f(){let a=1,b=2; a\n++b; return [a,b];}',
      'function f(){let a=1,b=2; a++\nb; return [a,b];}',
    ],
    [
      'regexp-significant-whitespace',
      "function f(){return /a b/.test('a b');}",
      "function f(){return /a  b/.test('a b');}",
    ],
    [
      'template-tail-whitespace',
      'function f(){return `${1} a b`;}',
      'function f(){return `${1} a  b`; }',
    ],
  ];
  for (const [name, before, after] of behaviorPairs) {
    if (semanticTokenString(before) === semanticTokenString(after))
      throw new Error(`Semantic source hash collapsed behavior-changing ${name} canary.`);
  }
  const commentBefore = 'function f(){return 7;}';
  const commentAfter = 'function f(){/* harmless */return 7;}';
  if (semanticTokenString(commentBefore) !== semanticTokenString(commentAfter))
    throw new Error('Semantic source hash treats comment-only trivia as a semantic change.');

  const directivePlain = 'const value: number = "wrong";';
  const directiveVariants = [
    ['ts-ignore', '// @ts-ignore\nconst value: number = "wrong";'],
    ['ts-expect-error', '// @ts-expect-error\nconst value: number = "wrong";'],
    ['ts-nocheck', '// @ts-nocheck\nconst value: number = "wrong";'],
    ['reference-lib', '/// <reference lib="es2022" />\nconst value: number = "wrong";'],
  ];
  for (const [name, variant] of directiveVariants) {
    if (semanticTokenString(directivePlain) === semanticTokenString(variant))
      throw new Error(
        `Semantic source hash collapsed compiler-semantic ${name} directive metadata.`,
      );
    if (
      legacyAstPrinterText('directive-plain.ts', directivePlain) !==
      legacyAstPrinterText(`directive-${name}.ts`, variant)
    )
      throw new Error(
        `Compiler-directive mutation control no longer reproduces ${name} AST-printer collision.`,
      );
  }
  const directiveFirst = '// @ts-ignore\nconst a: number = "wrong";\nconst b: number = "wrong";';
  const directiveSecond = 'const a: number = "wrong";\n// @ts-ignore\nconst b: number = "wrong";';
  if (semanticTokenString(directiveFirst) === semanticTokenString(directiveSecond))
    throw new Error(
      'Semantic source hash collapsed a compiler directive moved to a different target.',
    );
  if (
    legacyAstPrinterText('directive-first.ts', directiveFirst) !==
    legacyAstPrinterText('directive-second.ts', directiveSecond)
  )
    throw new Error(
      'Compiler-directive target mutation control no longer reproduces AST-printer collision.',
    );

  const methodPairs = [
    [
      'method-return-linebreak',
      'f():number|undefined { return 7; }',
      'f():number|undefined { return\n7; }',
    ],
    [
      'method-postfix-linebreak',
      'f(){let a=1,b=2; a\n++b; return [a,b];}',
      'f(){let a=1,b=2; a++\nb; return [a,b];}',
    ],
  ];
  for (const [name, before, after] of methodPairs) {
    if (semanticMethodString(before) === semanticMethodString(after))
      throw new Error(`Semantic symbol hash collapsed behavior-changing ${name} canary.`);
  }

  const legacyCollisions = behaviorPairs.filter(
    ([, before, after]) => legacyTriviaStrippedTokens(before) === legacyTriviaStrippedTokens(after),
  );
  if (!legacyCollisions.some(([name]) => name === 'return-linebreak'))
    throw new Error(
      'Semantic hash mutation control no longer reproduces the legacy return-ASI collision.',
    );
  if (!legacyCollisions.some(([name]) => name === 'postfix-linebreak'))
    throw new Error(
      'Semantic hash mutation control no longer reproduces the legacy postfix-ASI collision.',
    );
  if (!legacyCollisions.some(([name]) => name === 'regexp-significant-whitespace'))
    throw new Error(
      'Semantic hash mutation control no longer reproduces the legacy regexp collision.',
    );

  const formalPass = `---- MODULE HashCanary ----
VARIABLE x
Init == x = "a  b"
Next == UNCHANGED x
Inv == x = "a  b"
====`;
  const formalFail = `---- MODULE HashCanary ----
VARIABLE x
Init == x = "a b"
Next == UNCHANGED x
Inv == x = "a  b"
====`;
  if (formalSemanticText(formalPass) === formalSemanticText(formalFail))
    throw new Error('Formal model hash collapsed significant whitespace inside a TLA string.');
  if (legacyFormalText(formalPass) !== legacyFormalText(formalFail))
    throw new Error(
      'Formal hash mutation control no longer reproduces the legacy string collision.',
    );

  const formalCompact = `---- MODULE C ----
VARIABLE x,y
Init==x=1/\\y=2
Next==UNCHANGED <<x,y>>
====`;
  const formalFormatted = `---- MODULE C ----
VARIABLE x, y
Init == x = 1 /\\ y = 2
Next == UNCHANGED << x, y >>
====`;
  if (formalSemanticText(formalCompact) !== formalSemanticText(formalFormatted))
    throw new Error('Formal model hash treats ordinary token-separating whitespace as semantic.');

  const formalCommentFree = `---- MODULE C ----
VARIABLE x
Init == x = 1
====`;
  const formalComments = `---- MODULE C ----
(* outer (* nested *) comment *)
VARIABLE x \\* line comment
Init == x = 1
====`;
  if (formalSemanticText(formalCommentFree) !== formalSemanticText(formalComments))
    throw new Error('Formal model hash treats comment-only TLA trivia as semantic.');

  const markerString = `---- MODULE C ----
VARIABLE x
Init == x = "(* not a comment *) \\* still string"
====`;
  const changedMarkerString = `---- MODULE C ----
VARIABLE x
Init == x = "(* not a comment *)  \\* still string"
====`;
  if (formalSemanticText(markerString) === formalSemanticText(changedMarkerString))
    throw new Error('Formal model hash erased string bytes that resemble TLA comments.');
}
assertSemanticHashFidelity();
if (process.argv.includes('--self-test-source-hash')) {
  let schemaReviewRejected = false;
  try {
    assertDigestSchemaReview(
      { model: { sourceDigestSchema: 'legacy-source-v1', formalDigestSchema } },
      { model: { sourceDigestSchema, formalDigestSchema } },
    );
  } catch (error) {
    schemaReviewRejected = /Semantic digest schema changed/u.test(String(error));
  }
  if (!schemaReviewRejected)
    throw new Error(
      'Semantic digest schema review fence accepted an unacknowledged schema change.',
    );
  console.log(
    'Semantic source/model hashes preserve TypeScript ASI/regexp/template/compiler directives and TLA string/operator structure, ignore ordinary comments/trivia, reject both legacy digest mutants, and reject the AST-printer-only compiler-directive mutant.',
  );
  process.exit(0);
}
function sourceSymbolDigest(bindings, label) {
  const found = [];
  const expected = [];
  for (const [relativePath, names] of Object.entries(bindings)) {
    const file = path.join(root, relativePath);
    const text = fs.readFileSync(file, 'utf8');
    const source = parseSemanticSource(file, text);
    const wanted = new Set(names);
    for (const name of names) expected.push(`${relativePath}:${name}`);
    for (const node of source.statements) {
      if (ts.isFunctionDeclaration(node) && node.name && wanted.has(node.name.text)) {
        const key = `${relativePath}:${node.name.text}`;
        found.push(`${key}\n${semanticNodeText(node, source)}`);
      }
      if (!ts.isClassDeclaration(node) || !node.name) continue;
      const className = node.name.text;
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.name) continue;
        const symbol = `${className}.${member.name.getText(source)}`;
        if (!wanted.has(symbol)) continue;
        const key = `${relativePath}:${symbol}`;
        found.push(`${key}\n${semanticNodeText(member, source)}`);
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
    timeout: 30_000,
  });
  requireSuccessfulProcess(result, 'formal implementation surface extractor');
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
      sourceDigestSchema,
      formalDigestSchema,
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
      lifecycleTemporal: {
        spec: 'formal/WorkOnceLifecycleTemporal.tla',
        config: 'formal/WorkOnceLifecycleTemporal.cfg',
        configuredChecks: readConfiguredChecks('formal/WorkOnceLifecycleTemporal.cfg'),
        observationBinding: 'scripts/lifecycle-formal.mjs',
      },
      claimScan: {
        spec: 'formal/WorkOnceClaimScan.tla',
        config: 'formal/WorkOnceClaimScan.cfg',
        configuredChecks: readConfiguredChecks('formal/WorkOnceClaimScan.cfg'),
        observationBinding: 'scripts/lifecycle-formal.mjs',
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
      sourceDigestSchema,
      formalDigestSchema,
      sourceFiles: semanticSourceFiles,
      modelFiles,
      sourceDigest: semanticSourceDigest(semanticSourceFiles),
      modelDigest: formalDigest(modelFiles),
      semanticEnvironmentFiles,
      semanticEnvironmentDigest: contentDigest(semanticEnvironmentFiles),
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
    '## Lifecycle temporal model',
    '',
    `- Spec: \`${manifest.model.lifecycleTemporal.spec}\``,
    `- Checked invariants: ${manifest.model.lifecycleTemporal.configuredChecks.map((name) => `\`${name}\``).join(', ')}`,
    `- TLC + mutation binding: \`${manifest.model.lifecycleTemporal.observationBinding}\``,
    '',
    '## Claim-scan bounded-progress model',
    '',
    `- Spec: \`${manifest.model.claimScan.spec}\``,
    `- Checked invariants: ${manifest.model.claimScan.configuredChecks.map((name) => `\`${name}\``).join(', ')}`,
    `- TLC + mutation binding: \`${manifest.model.claimScan.observationBinding}\``,
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
    `- Source semantic digest schema: \`${manifest.model.sourceDigestSchema}\``,
    `- TLA semantic digest schema: \`${manifest.model.formalDigestSchema}\``,
    `- Bound proof/checker files: **${manifest.stateMachineBinding.assuranceInfrastructureFiles.length}**`,
    `- Content digest: \`${manifest.stateMachineBinding.assuranceInfrastructureDigest}\``,
    `- Semantic compiler/toolchain inputs: **${manifest.stateMachineBinding.semanticEnvironmentFiles.length}**`,
    `- Semantic compiler/toolchain digest: \`${manifest.stateMachineBinding.semanticEnvironmentDigest}\``,
    '',
    '## Coverage rule',
    '',
    'The manifest is compiler-discovered. Any new public callable, reachable package-owned input/output/callback field, signature/type change, configured TLA invariant, or bound source/model semantic change fails assurance until this file and the machine-reviewed manifest are deliberately updated.',
    '',
  );
  return `${lines.join('\n').trimEnd()}\n`;
}

function assertDigestSchemaReview(previousManifest, currentManifest) {
  if (!previousManifest || acknowledgePairing) return;
  const previousSourceSchema = previousManifest.model?.sourceDigestSchema;
  const previousFormalSchema = previousManifest.model?.formalDigestSchema;
  if (
    previousSourceSchema !== currentManifest.model.sourceDigestSchema ||
    previousFormalSchema !== currentManifest.model.formalDigestSchema
  )
    throw new Error('Semantic digest schema changed without explicit source/model review.');
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
const outboxPairingMessage =
  'Bound outbox scheduler semantics changed without an outbox model semantic change. Update the outbox abstraction or explicitly acknowledge the unchanged abstraction after review.';
function assertOutboxSourceModelPairing(previousBinding) {
  assertSourceModelPairing(
    previousBinding,
    {
      sourceDigest: semanticSourceDigest(outboxSourceFiles),
      modelDigest: formalDigest(outboxModelFiles),
    },
    outboxPairingMessage,
  );
}

if (process.argv.includes('--check-semantic-environment-binding-only')) {
  if (!fs.existsSync(manifestPath))
    throw new Error(
      'Missing assurance/formal-implementation-manifest.json. Run npm run assurance:update and review it.',
    );
  const previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const previousFiles = previous.stateMachineBinding?.semanticEnvironmentFiles ?? [];
  const previousDigest = previous.stateMachineBinding?.semanticEnvironmentDigest;
  const currentDigest = contentDigest(semanticEnvironmentFiles);
  if (
    (previousDigest !== currentDigest ||
      canonicalText(previousFiles) !== canonicalText(semanticEnvironmentFiles)) &&
    !acknowledgePairing
  )
    throw new Error(
      'Bound compiler/toolchain semantics changed without explicit source/model review. Use assurance:update:ack only after reviewing why the formal abstraction deliberately remains unchanged.',
    );
  console.log('Semantic compiler/toolchain binding matches the reviewed manifest.');
  process.exit(0);
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
    '--check-outbox-binding-only',
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
  } else if (bindingOnly === '--check-outbox-binding-only') {
    assertOutboxSourceModelPairing(previous.model?.outbox);
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

if (write && !acknowledgePairing && fs.existsSync(manifestPath)) {
  const previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assertOutboxSourceModelPairing(previous.model?.outbox);
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
  assertDigestSchemaReview(previous, current);
  if (
    previous &&
    (previous.stateMachineBinding?.semanticEnvironmentDigest !==
      current.stateMachineBinding.semanticEnvironmentDigest ||
      canonicalText(previous.stateMachineBinding?.semanticEnvironmentFiles ?? []) !==
        canonicalText(current.stateMachineBinding.semanticEnvironmentFiles)) &&
    !acknowledgePairing
  ) {
    throw new Error(
      'Bound compiler/toolchain semantics changed without explicit source/model review. Use assurance:update:ack only after reviewing why the formal abstraction deliberately remains unchanged.',
    );
  }
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
  assertSourceModelPairing(previous?.model?.outbox, current.model.outbox, outboxPairingMessage);
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
