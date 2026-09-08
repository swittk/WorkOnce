import { availableParallelism } from 'node:os';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import {
  assertStorageRefinementSamples,
  runStorageRefinementSamples,
} from './storage-refinement.mjs';

const jar = resolve(process.env.TLA2TOOLS_JAR ?? '.artifacts/tla2tools.jar');
if (!existsSync(jar)) throw new Error('Set TLA2TOOLS_JAR to the official tla2tools.jar.');
mkdirSync('.artifacts/tlc', { recursive: true });
const workers = String(Math.max(2, Math.min(8, availableParallelism())));
const timeoutMs = 30_000;
const storageSpec = readFileSync('formal/WorkOnceStorage.tla', 'utf8');
function embeddedStorageModule(name, extra) {
  const body = storageSpec
    .replace('MODULE WorkOnceStorage', `MODULE ${name}`)
    .replace(/\n=+\s*$/u, '');
  return `${body}\n${extra}\n====\n`;
}
function tlc(model, config, modulePath, capture = false) {
  const directory = resolve('.artifacts/tlc', model);
  mkdirSync(directory, { recursive: true });
  const result = spawnSync(
    'java',
    [
      '-Xmx512m',
      '-XX:+UseParallelGC',
      `-DTLA-Library=${[resolve('formal'), resolve('.artifacts/tlc')].join(delimiter)}`,
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
      encoding: capture ? 'utf8' : undefined,
      stdio: capture ? undefined : 'inherit',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`TLC storage model terminated by ${result.signal}`);
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
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const rejectedForInvariant =
    output.includes(`Invariant ${invariant} is violated`) ||
    output.includes(`invariant of ${invariant} is equal to FALSE`);
  if (result.status === 0 || !rejectedForInvariant)
    throw new Error(`Storage mutation was not rejected by ${invariant}: ${output.slice(-2500)}`);
  console.log(`TLC storage mutation guard: ${invariant} rejects its injected violation.`);
}

const samples = await runStorageRefinementSamples();
assertStorageRefinementSamples(samples);
const observedModule = resolve('.artifacts/tlc/WorkOnceStorageObserved.tla');
const observedConfig = resolve('.artifacts/tlc/WorkOnceStorageObserved.cfg');
writeFileSync(
  observedModule,
  embeddedStorageModule(
    'WorkOnceStorageObserved',
    `ObservedSamples == {\n${samples.map(tlaValue).join(',\n')}\n}`,
  ),
);
writeFileSync(
  observedConfig,
  `${readFileSync('formal/WorkOnceStorage.cfg', 'utf8')}\nCONSTANT Samples <- ObservedSamples\n`,
);
console.log(`TLC storage model receives ${samples.length} fresh compiled storage observations.`);
const result = tlc('WorkOnceStorageObserved', observedConfig, observedModule);
if (result.status !== 0) process.exit(result.status ?? 1);

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
    if (line.trim() === 'INVARIANTS') {
      reading = true;
      continue;
    }
    if (!reading) continue;
    const match = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/u.exec(line);
    if (!match) break;
    result.push(match[1]);
  }
  return result;
}
const storageConfigured = configuredInvariants(
  readFileSync('formal/WorkOnceStorage.cfg', 'utf8'),
).sort();
const storageGuarded = [...Object.keys(mutants), 'StorageSamplesConform'].sort();
if (JSON.stringify(storageConfigured) !== JSON.stringify(storageGuarded))
  throw new Error(
    `Storage formal mutation coverage drifted: configured=${storageConfigured.join(',')} guarded=${storageGuarded.join(',')}`,
  );

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
const batchModule = resolve('.artifacts/tlc/WorkOnceStorageInvariantMutationBatch.tla');
const batchConfig = resolve('.artifacts/tlc/WorkOnceStorageInvariantMutationBatch.cfg');
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
  `SPECIFICATION BatchSpec\nCONSTANT MaxConflicts = 3\nCONSTANT Samples <- ObservedSamples\nINVARIANT MutationWitnesses\nINVARIANT MutationStepEnabled\nCHECK_DEADLOCK FALSE\n`,
);
const batchResult = tlc('WorkOnceStorageInvariantMutationBatch', batchConfig, batchModule, true);
const batchOutput = `${batchResult.stdout ?? ''}\n${batchResult.stderr ?? ''}`;
if (batchResult.status !== 0)
  throw new Error(
    `Storage invariant mutation witness batch failed; this is not a mutation kill. ${batchOutput.slice(-2500)}`,
  );
process.stdout.write(batchResult.stdout ?? '');
process.stderr.write(batchResult.stderr ?? '');
console.log(
  `TLC storage mutation witness batch proves ${mutationEntries.length} configured state invariants are non-vacuous in sequence.`,
);

const sampleModule = resolve('.artifacts/tlc/WorkOnceStorageMutant_StorageSamplesConform.tla');
const sampleConfig = resolve('.artifacts/tlc/WorkOnceStorageMutant_StorageSamplesConform.cfg');
writeFileSync(
  sampleModule,
  embeddedStorageModule(
    'WorkOnceStorageMutant_StorageSamplesConform',
    [
      `ObservedSamples == {\n${observedSamplesLines}\n}`,
      String.raw`BadSamples == ObservedSamples \cup {[kind |-> "invalid"]}`,
    ].join('\n'),
  ),
);
writeFileSync(
  sampleConfig,
  `SPECIFICATION Spec\nCONSTANT MaxConflicts = 3\nCONSTANT Samples <- BadSamples\nINVARIANT StorageSamplesConform\nCHECK_DEADLOCK FALSE\n`,
);
requireRejects(
  'WorkOnceStorageMutant_StorageSamplesConform',
  sampleConfig,
  sampleModule,
  'StorageSamplesConform',
);
