import { renderBooleanSampleMutationChecks } from './formal-sample-mutations.mjs';
import { availableParallelism } from 'node:os';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import {
  assertStorageRefinementSamples,
  runStorageRefinementSamples,
} from './storage-refinement.mjs';
import { classifyTlcOutcome, requireExpectedInvariantViolation } from './tlc-outcome.mjs';
import { acquireTlcWorkspace, cleanupTlcWorkspaceOnSuccess } from './tlc-workspace.mjs';

const jar = resolve(process.env.TLA2TOOLS_JAR ?? '.artifacts/tla2tools.jar');
if (!existsSync(jar)) throw new Error('Set TLA2TOOLS_JAR to the official tla2tools.jar.');
const tlcWorkspace = acquireTlcWorkspace('storage-formal');
cleanupTlcWorkspaceOnSuccess(tlcWorkspace);
const javaTmp = resolve(tlcWorkspace, 'java-tmp');
mkdirSync(javaTmp, { recursive: true });
const configuredWorkers =
  process.env.WORKONCE_TLC_WORKERS === undefined
    ? undefined
    : Number(process.env.WORKONCE_TLC_WORKERS);
if (
  configuredWorkers !== undefined &&
  (!Number.isSafeInteger(configuredWorkers) || configuredWorkers < 2)
)
  throw new RangeError('WORKONCE_TLC_WORKERS must be a safe integer >= 2');
const workers = String(
  configuredWorkers === undefined
    ? Math.max(2, Math.min(8, availableParallelism()))
    : Math.min(configuredWorkers, availableParallelism()),
);
const timeoutMs = 30_000;
const storageSpec = readFileSync('formal/WorkOnceStorage.tla', 'utf8');
function embeddedStorageModule(name, extra) {
  const body = storageSpec
    .replace('MODULE WorkOnceStorage', `MODULE ${name}`)
    .replace('EXTENDS Naturals, FiniteSets', 'EXTENDS Naturals, FiniteSets, TLC, Sequences')
    .replace(/\n=+\s*$/u, '');
  return `${body}\n${extra}\n====\n`;
}
function tlc(model, config, modulePath, capture = false) {
  const directory = resolve(tlcWorkspace, model);
  mkdirSync(directory, { recursive: true });
  const result = spawnSync(
    'java',
    [
      '-Xmx512m',
      '-XX:+UseParallelGC',
      `-Djava.io.tmpdir=${javaTmp}`,
      `-DTLA-Library=${[resolve('formal'), tlcWorkspace].join(delimiter)}`,
      '-cp',
      jar,
      'tlc2.TLC',
      '-workers',
      workers,
      '-metadir',
      directory,
      '-config',
      config,
      modulePath,
    ],
    {
      cwd: resolve('.'),
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (!capture) {
    const outcome = classifyTlcOutcome(result);
    if (outcome.kind !== 'success') {
      process.stdout.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
      throw new Error(
        `TLC storage model ${model} failed: ${outcome.reason ?? outcome.kind}\n${outcome.output.slice(-2500)}`,
      );
    }
  }
  return result;
}
function tlaValue(value) {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (value && typeof value === 'object' && !Array.isArray(value))
    return `[${Object.entries(value)
      .map(([key, item]) => `${key} |-> ${tlaValue(item)}`)
      .join(', ')}]`;
  throw new Error(`Unrepresentable storage observation: ${String(value)}`);
}
function requireRejects(model, config, modulePath, invariant) {
  const result = tlc(model, config, modulePath, true);
  requireExpectedInvariantViolation(result, invariant);
  console.log(`TLC storage mutation guard: ${invariant} rejects its injected violation.`);
}

const samples = await runStorageRefinementSamples();
assertStorageRefinementSamples(samples);
const duplicateSlotTarget = samples.find(
  (sample) => sample.kind === 'detached' && sample.adapter === 'memory',
);
if (!duplicateSlotTarget || !Object.hasOwn(duplicateSlotTarget, 'duplicateSlotsExact'))
  throw new Error(
    'Storage mutation guard target missing: detached/memory sample has no duplicateSlotsExact observation.',
  );
const duplicateSlotMutantSamples = samples.map((sample) =>
  sample === duplicateSlotTarget ? { ...sample, duplicateSlotsExact: false } : sample,
);
const adapterCoverageMutantSamples = samples.filter(
  (sample) => sample.adapter === undefined || sample.adapter === 'memory',
);
const observedModule = resolve(tlcWorkspace, 'WorkOnceStorageObserved.tla');
const observedConfig = resolve(tlcWorkspace, 'WorkOnceStorageObserved.cfg');
writeFileSync(
  observedModule,
  embeddedStorageModule(
    'WorkOnceStorageObserved',
    [
      `ObservedSamples == {\n${samples.map(tlaValue).join(',\n')}\n}`,
      renderBooleanSampleMutationChecks(
        samples,
        assertStorageRefinementSamples,
        tlaValue,
        'StorageSampleOK',
      ),
      String.raw`InvalidSamples == ObservedSamples \cup {[kind |-> "invalid"]}`,
      `DuplicateSlotSamples == {\n${duplicateSlotMutantSamples.map(tlaValue).join(',\n')}\n}`,
      `AdapterCoverageSamples == {\n${adapterCoverageMutantSamples.map(tlaValue).join(',\n')}\n}`,
      'InvalidSampleCheck == INSTANCE WorkOnceStorage WITH Samples <- InvalidSamples, MaxConflicts <- MaxConflicts',
      'DuplicateSlotCheck == INSTANCE WorkOnceStorage WITH Samples <- DuplicateSlotSamples, MaxConflicts <- MaxConflicts',
      'AdapterCoverageCheck == INSTANCE WorkOnceStorage WITH Samples <- AdapterCoverageSamples, MaxConflicts <- MaxConflicts',
      'StorageNegativeSampleMutantsRejected == /\\ ~InvalidSampleCheck!StorageSamplesConform /\\ ~DuplicateSlotCheck!StorageSamplesConform /\\ ~AdapterCoverageCheck!StorageSamplesConform',
    ].join('\n'),
  ),
);
writeFileSync(
  observedConfig,
  `${readFileSync('formal/WorkOnceStorage.cfg', 'utf8')}\nCONSTANT Samples <- ObservedSamples\nINVARIANT StorageNegativeSampleMutantsRejected\n`,
);
console.log(`TLC storage model receives ${samples.length} fresh compiled storage observations.`);
tlc('WorkOnceStorageObserved', observedConfig, observedModule);

const mutants = {
  StorageTypeOK: String.raw`  /\ pc' = "invalid" /\ UNCHANGED <<nativeRevision, observedRevision, compareMisses, callerCommits, unknownCommitted, deadlineReached, deadlineExpired>>`,
  AtMostOneCallerCommit: String.raw`  /\ pc' = "done" /\ nativeRevision' = 1 /\ callerCommits' = 2 /\ UNCHANGED <<observedRevision, compareMisses, unknownCommitted, deadlineReached, deadlineExpired>>`,
  MissCannotCommit: String.raw`  /\ pc' = "retry" /\ nativeRevision' = 1 /\ compareMisses' = 1 /\ callerCommits' = 1 /\ UNCHANGED <<observedRevision, unknownCommitted, deadlineReached, deadlineExpired>>`,
  DecisionFaultCannotCommit: String.raw`  /\ pc' = "decision_fault" /\ callerCommits' = 1 /\ UNCHANGED <<nativeRevision, observedRevision, compareMisses, unknownCommitted, deadlineReached, deadlineExpired>>`,
  UnknownOutcomeStopsRetry: String.raw`  /\ pc' = "unknown" /\ nativeRevision' = 1 /\ callerCommits' = 0 /\ unknownCommitted' = FALSE /\ UNCHANGED <<observedRevision, compareMisses, deadlineReached, deadlineExpired>>`,
  DeadlineExpiryStopsRetry: String.raw`  /\ pc' = "expired" /\ deadlineExpired' = FALSE /\ UNCHANGED <<nativeRevision, observedRevision, compareMisses, callerCommits, unknownCommitted, deadlineReached>>`,
  ReachedDeadlineCannotCommit: String.raw`  /\ pc' = "done" /\ nativeRevision' = 1 /\ callerCommits' = 1 /\ deadlineReached' = TRUE /\ UNCHANGED <<observedRevision, compareMisses, unknownCommitted, deadlineExpired>>`,
  FreshReadBeforeCommit: String.raw`  /\ pc' = "done" /\ nativeRevision' = 2 /\ observedRevision' = 0 /\ callerCommits' = 1 /\ UNCHANGED <<compareMisses, unknownCommitted, deadlineReached, deadlineExpired>>`,
  BoundedCompareMisses: String.raw`  /\ pc' = "exhausted" /\ compareMisses' = MaxConflicts + 1 /\ UNCHANGED <<nativeRevision, observedRevision, callerCommits, unknownCommitted, deadlineReached, deadlineExpired>>`,
};
const observedSamplesLines = samples.map(tlaValue).join(',\n');
function configuredInvariants(configText) {
  const lines = configText.replace(/\r\n?/gu, '\n').split('\n');
  const result = [];
  let reading = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const single = /^INVARIANT\s+([A-Za-z_][A-Za-z0-9_]*)$/u.exec(trimmed);
    if (single) {
      result.push(single[1]);
      reading = false;
      continue;
    }
    if (trimmed === 'INVARIANTS') {
      reading = true;
      continue;
    }
    if (!reading) continue;
    const match = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/u.exec(line);
    if (match) result.push(match[1]);
    else if (trimmed) reading = false;
  }
  return result;
}
const configuredInvariantParserProbe = configuredInvariants(
  'INVARIANT SingleInvariant\nINVARIANTS\n  FirstGroupedInvariant\n\n  SecondGroupedInvariant\nCHECK_DEADLOCK FALSE\n',
);
if (
  JSON.stringify(configuredInvariantParserProbe) !==
  JSON.stringify(['SingleInvariant', 'FirstGroupedInvariant', 'SecondGroupedInvariant'])
)
  throw new Error(
    'Storage configured-invariant parser must preserve single and blank-separated forms',
  );
const storageConfigured = configuredInvariants(
  readFileSync('formal/WorkOnceStorage.cfg', 'utf8'),
).sort();
const storageGuarded = [...Object.keys(mutants), 'StorageSamplesConform'].sort();
if (JSON.stringify(storageConfigured) !== JSON.stringify(storageGuarded))
  throw new Error(
    `Storage formal mutation coverage drifted: configured=${storageConfigured.join(',')} guarded=${storageGuarded.join(',')}`,
  );

const baseStorageConfig = readFileSync('formal/WorkOnceStorage.cfg', 'utf8');
const maxConflictsMatch = /^CONSTANT\s+MaxConflicts\s*=\s*(\d+)\s*$/mu.exec(baseStorageConfig);
if (!maxConflictsMatch)
  throw new Error('formal/WorkOnceStorage.cfg is missing numeric MaxConflicts');
const maxConflicts = Number(maxConflictsMatch[1]);

const mutationEntries = Object.entries(mutants);
const mutationBranches = mutationEntries
  .map(([invariant, action], index) => {
    const rawLines = action.replace(/^\n+|\n+$/gu, '').split('\n');
    const nonEmpty = rawLines.filter((line) => line.trim().length > 0);
    const commonIndent = Math.min(...nonEmpty.map((line) => /^\s*/u.exec(line)?.[0].length ?? 0));
    const body = rawLines.map((line) => `     ${line.slice(commonIndent)}`).join('\n');
    return `  \\/ /\\ mutantIndex = ${index}\n${body}\n     /\\ mutantIndex' = ${index + 1}`;
  })
  .join('\n');
const mutationWitnessCases = mutationEntries
  .map(([invariant], index) => `    [] mutantIndex = ${index + 1} -> ~${invariant}`)
  .join('\n');
const batchModule = resolve(tlcWorkspace, 'WorkOnceStorageInvariantMutationBatch.tla');
const batchConfig = resolve(tlcWorkspace, 'WorkOnceStorageInvariantMutationBatch.cfg');
writeFileSync(
  batchModule,
  embeddedStorageModule(
    'WorkOnceStorageInvariantMutationBatch',
    [
      `ObservedSamples == {\n${observedSamplesLines}\n}`,
      'VARIABLE mutantIndex',
      'batchVars == <<vars, mutantIndex>>',
      'BatchInit == /\\ Init /\\ mutantIndex = 0',
      `BatchNext ==\n${mutationBranches}`,
      `MutationWitnesses ==\n  /\\ mutantIndex \\in 0..${mutationEntries.length}\n  /\\ CASE mutantIndex = 0 -> TRUE\n${mutationWitnessCases}`,
      `MutationStepEnabled == mutantIndex = ${mutationEntries.length} \\/ ENABLED BatchNext`,
      'BatchSpec == BatchInit /\\ [][BatchNext]_batchVars',
    ].join('\n'),
  ),
);
writeFileSync(
  batchConfig,
  `SPECIFICATION BatchSpec\nCONSTANT MaxConflicts = ${maxConflicts}\nCONSTANT Samples <- ObservedSamples\nINVARIANT MutationWitnesses\nINVARIANT MutationStepEnabled\nCHECK_DEADLOCK FALSE\n`,
);
const batchResult = tlc('WorkOnceStorageInvariantMutationBatch', batchConfig, batchModule, true);
const batchOutcome = classifyTlcOutcome(batchResult);
if (batchOutcome.kind !== 'success') {
  process.stdout.write(batchResult.stdout ?? '');
  process.stderr.write(batchResult.stderr ?? '');
  throw new Error(
    `Storage invariant mutation witness batch failed; this is not a mutation kill: ${batchOutcome.reason ?? batchOutcome.kind}\n${batchOutcome.output.slice(-2500)}`,
  );
}
console.log(
  `TLC storage mutation witness batch proves ${mutationEntries.length} configured state invariants are non-vacuous in sequence.`,
);

console.log(
  'TLC storage mutation guard: StorageSamplesConform rejects invalid-kind and duplicate-slot sample mutations in the observed-model run.',
);
