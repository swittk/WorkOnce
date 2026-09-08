import { availableParallelism } from 'node:os';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
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
const execFileAsync = promisify(execFile);
async function requireRejectsAsync(model, config, modulePath, invariant) {
  const directory = resolve('.artifacts/tlc', model);
  mkdirSync(directory, { recursive: true });
  const args = [
    '-Xmx160m',
    '-XX:+UseParallelGC',
    `-DTLA-Library=${[resolve('formal'), resolve('.artifacts/tlc')].join(delimiter)}`,
    '-cp',
    jar,
    'tlc2.TLC',
    '-workers',
    '1',
    '-metadir',
    directory,
    '-config',
    config,
    modulePath,
  ];
  let output = '';
  let failed = false;
  try {
    const result = await execFileAsync('java', args, {
      cwd: resolve('.'),
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  } catch (error) {
    if (error?.killed || error?.signal) throw error;
    failed = true;
    output = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`;
  }
  const rejectedForInvariant =
    output.includes(`Invariant ${invariant} is violated`) ||
    output.includes(`invariant of ${invariant} is equal to FALSE`);
  if (!failed || !rejectedForInvariant)
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
const mutationChecks = [];
const observedSamplesLines = samples.map(tlaValue).join(',\n');
for (const [invariant, action] of Object.entries(mutants)) {
  const modulePath = resolve(`.artifacts/tlc/WorkOnceStorageMutant_${invariant}.tla`);
  const configPath = resolve(`.artifacts/tlc/WorkOnceStorageMutant_${invariant}.cfg`);
  writeFileSync(
    modulePath,
    embeddedStorageModule(
      `WorkOnceStorageMutant_${invariant}`,
      [
        `ObservedSamples == {\n${observedSamplesLines}\n}`,
        'Unsafe ==',
        action,
        String.raw`MutantNext == Next \/ Unsafe`,
        String.raw`MutantSpec == Init /\ [][MutantNext]_vars`,
      ].join('\n'),
    ),
  );
  writeFileSync(
    configPath,
    `SPECIFICATION MutantSpec\nCONSTANT MaxConflicts = 3\nCONSTANT Samples <- ObservedSamples\nINVARIANT ${invariant}\nCHECK_DEADLOCK FALSE\n`,
  );
  mutationChecks.push(() =>
    requireRejectsAsync(`WorkOnceStorageMutant_${invariant}`, configPath, modulePath, invariant),
  );
}
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
mutationChecks.push(() =>
  requireRejectsAsync(
    'WorkOnceStorageMutant_StorageSamplesConform',
    sampleConfig,
    sampleModule,
    'StorageSamplesConform',
  ),
);
await Promise.all(mutationChecks.map((runMutation) => runMutation()));
