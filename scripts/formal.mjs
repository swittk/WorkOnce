import { availableParallelism } from 'node:os';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { assertBuildSourceBinding } from './build-source-binding.mjs';

assertBuildSourceBinding();
if (process.argv.includes('--binding-check-only')) {
  console.log('Compiled WorkOnce output and emitted artifacts match current TypeScript sources.');
  process.exit(0);
}

const jar = resolve(process.env.TLA2TOOLS_JAR ?? '.artifacts/tla2tools.jar');
if (!existsSync(jar))
  throw new Error('Set TLA2TOOLS_JAR to the official tla2tools.jar. See docs/assurance.md.');
mkdirSync('.artifacts/tlc', { recursive: true });
const workers = String(Math.max(2, Math.min(8, availableParallelism())));
const timeoutMs = 30_000;

function tlcArgs(model, config, modulePath) {
  return [
    '-Xmx512m',
    '-XX:+UseParallelGC',
    `-DTLA-Library=${[resolve('formal'), resolve('.artifacts/tlc')].join(delimiter)}`,
    '-cp',
    jar,
    'tlc2.TLC',
    '-workers',
    workers,
    '-metadir',
    resolve('.artifacts/tlc', model),
    '-config',
    config,
    modulePath,
  ];
}

function runModel(model, config, modulePath = `${model}.tla`) {
  const directory = resolve('.artifacts/tlc', model);
  mkdirSync(directory, { recursive: true });
  const result = spawnSync('java', tlcArgs(model, config, modulePath), {
    cwd: 'formal',
    stdio: 'inherit',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  if (result.error) {
    const prefix =
      result.error.code === 'ETIMEDOUT'
        ? `TLC infrastructure timeout after ${timeoutMs} ms`
        : 'TLC infrastructure spawn failure';
    throw new Error(`${prefix}: ${result.error.message}`, { cause: result.error });
  }
  if (result.signal) throw new Error(`TLC infrastructure terminated by signal ${result.signal}`);
  if (result.status === null) throw new Error('TLC infrastructure returned no exit status');
  if (result.status !== 0) process.exit(result.status);
}

function requireInvariantRejects(model, config, modulePath, invariant) {
  const directory = resolve('.artifacts/tlc', model);
  mkdirSync(directory, { recursive: true });
  const result = spawnSync('java', tlcArgs(model, config, modulePath), {
    cwd: 'formal',
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`TLC mutation check terminated by signal ${result.signal}`);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 0 || !output.includes(`Invariant ${invariant} is violated`)) {
    throw new Error(`Formal mutation was not rejected by ${invariant}: ${output.slice(-2000)}`);
  }
  console.log(`TLC mutation guard: ${invariant} rejects its injected violating transition.`);
}

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

function singleInvariantConfig(configText, invariant) {
  const lines = configText.replace(/\r\n?/gu, '\n').split('\n');
  const output = [];
  let skipping = false;
  let inserted = false;
  for (const line of lines) {
    if (line.trim() === 'INVARIANTS') {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (/^\s+[A-Za-z_][A-Za-z0-9_]*\s*$/u.test(line)) continue;
      skipping = false;
    }
    if (line.trim() === 'SPECIFICATION Spec') {
      output.push('SPECIFICATION MutantSpec');
      continue;
    }
    if (line.trim() === 'CHECK_DEADLOCK FALSE' && !inserted) {
      output.push(`INVARIANT ${invariant}`);
      inserted = true;
    }
    output.push(line);
  }
  if (!inserted) output.push(`INVARIANT ${invariant}`);
  return `${output.join('\n').trimEnd()}\n`;
}

function mutationCoveragePlan(configPath, mutants, additionalGuards = []) {
  const configured = configuredInvariants(readFileSync(configPath, 'utf8')).sort();
  const guarded = [...Object.keys(mutants), ...additionalGuards].sort();
  if (JSON.stringify(configured) !== JSON.stringify(guarded))
    throw new Error(
      `Formal mutation coverage drifted for ${configPath}: configured=${configured.join(',')} guarded=${guarded.join(',')}`,
    );
  return {
    configPath,
    mutants,
    additionalGuards: [...additionalGuards],
    batchWitnessed: false,
    extraWitnessed: new Set(),
  };
}

function markExtraMutationWitness(plan, invariant) {
  if (!plan.additionalGuards.includes(invariant))
    throw new Error(`Unexpected extra mutation witness ${invariant} for ${plan.configPath}`);
  plan.extraWitnessed.add(invariant);
}

function assertMutationPlansExecuted(plans) {
  for (const plan of plans) {
    const missingExtra = plan.additionalGuards.filter((name) => !plan.extraWitnessed.has(name));
    if (!plan.batchWitnessed || missingExtra.length)
      throw new Error(
        `Formal mutation plan was not executed for ${plan.configPath}: batch=${plan.batchWitnessed} missingExtra=${missingExtra.join(',')}`,
      );
  }
}

function mutationWitnessConfig(configText) {
  const lines = configText.replace(/\r\n?/gu, '\n').split('\n');
  const output = [];
  let skipping = false;
  let inserted = false;
  for (const line of lines) {
    if (line.trim() === 'INVARIANTS') {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (/^\s+[A-Za-z_][A-Za-z0-9_]*\s*$/u.test(line)) continue;
      skipping = false;
    }
    if (line.trim() === 'SPECIFICATION Spec') {
      output.push('SPECIFICATION BatchSpec');
      continue;
    }
    if (line.trim() === 'CHECK_DEADLOCK FALSE' && !inserted) {
      output.push('INVARIANT MutationWitnesses');
      inserted = true;
    }
    output.push(line);
  }
  if (!inserted) output.push('INVARIANT MutationWitnesses');
  return `${output.join('\n').trimEnd()}\n`;
}

function runMutationWitnessBatch({ model, baseModule, baseConfig, plan }) {
  const { mutants } = plan;
  const modulePath = resolve(`.artifacts/tlc/${model}.tla`);
  const configPath = resolve(`.artifacts/tlc/${model}.cfg`);
  const branches = Object.entries(mutants)
    .map(([invariant, action]) => {
      const rawLines = action.replace(/^\n+|\n+$/gu, '').split('\n');
      const nonEmpty = rawLines.filter((line) => line.trim().length > 0);
      const commonIndent = Math.min(...nonEmpty.map((line) => /^\s*/u.exec(line)?.[0].length ?? 0));
      const body = rawLines.map((line) => `     ${line.slice(commonIndent)}`).join('\n');
      return `  \\/ /\\ mutantId = "none"\n${body}\n     /\\ mutantId' = ${JSON.stringify(invariant)}`;
    })
    .join('\n');
  const witnesses = Object.keys(mutants)
    .map((invariant) => `  \\/ /\\ mutantId = ${JSON.stringify(invariant)} /\\ ~${invariant}`)
    .join('\n');
  writeFileSync(
    modulePath,
    `---- MODULE ${model} ----\nEXTENDS ${baseModule}\nVARIABLE mutantId\nbatchVars == <<vars, mutantId>>\nBatchInit == /\\ Init /\\ mutantId = "none"\nUnsafe ==\n${branches}\nBatchNext == Unsafe\nMutationWitnesses ==\n  \\/ mutantId = "none"\n${witnesses}\nBatchSpec == BatchInit /\\ [][BatchNext]_batchVars\n====\n`,
  );
  writeFileSync(configPath, mutationWitnessConfig(baseConfig));
  runModel(model, configPath, modulePath);
  plan.batchWitnessed = true;
  console.log(
    `TLC mutation witness batch proves ${Object.keys(mutants).length} configured invariants are non-vacuous for ${baseModule}.`,
  );
}

const lifecycleMutants = {
  TypeOK: String.raw`  /\ state' = "invalid"
  /\ UNCHANGED <<waitCause, owner, fence, generation, lease, now, available, attempts, retries,
                 deferrals, firstStarted, manualRetryAllowed, stopReason, tokens, pendingNext,
                 childCreated, terminalNeedsNext, lastAcceptedFence>>`,
  CurrentFenceUnique: String.raw`  /\ tokens' = {[worker |-> 1, generation |-> generation, fence |-> fence],
                  [worker |-> 2, generation |-> generation, fence |-> fence]}
  /\ UNCHANGED <<state, waitCause, owner, fence, generation, lease, now, available, attempts,
                 retries, deferrals, firstStarted, manualRetryAllowed, stopReason, pendingNext,
                 childCreated, terminalNeedsNext, lastAcceptedFence>>`,
  RunningOwnerTokenIssued: String.raw`  /\ state' = "running" /\ owner' = 1 /\ fence' = 1 /\ lease' = 1 /\ attempts' = 1
  /\ UNCHANGED <<waitCause, generation, now, available, retries, deferrals, firstStarted,
                 manualRetryAllowed, stopReason, tokens, pendingNext, childCreated,
                 terminalNeedsNext, lastAcceptedFence>>`,
  AcceptedFenceIsCurrentOrClear: String.raw`  /\ fence' = 1 /\ lastAcceptedFence' = 2
  /\ UNCHANGED <<state, waitCause, owner, generation, lease, now, available, attempts, retries,
                 deferrals, firstStarted, manualRetryAllowed, stopReason, tokens, pendingNext,
                 childCreated, terminalNeedsNext>>`,
  SuccessUsesCurrentFence: String.raw`  /\ state' = "succeeded" /\ fence' = 1 /\ lastAcceptedFence' = 0
  /\ UNCHANGED <<waitCause, owner, generation, lease, now, available, attempts, retries, deferrals,
                 firstStarted, manualRetryAllowed, stopReason, tokens, pendingNext, childCreated,
                 terminalNeedsNext>>`,
  WaitingHasCause: String.raw`  /\ state' = "waiting"
  /\ UNCHANGED <<waitCause, owner, fence, generation, lease, now, available, attempts, retries,
                 deferrals, firstStarted, manualRetryAllowed, stopReason, tokens, pendingNext,
                 childCreated, terminalNeedsNext, lastAcceptedFence>>`,
  RunningHasNoWaitCause: String.raw`  /\ state' = "running" /\ waitCause' = "retry"
  /\ UNCHANGED <<owner, fence, generation, lease, now, available, attempts, retries, deferrals,
                 firstStarted, manualRetryAllowed, stopReason, tokens, pendingNext, childCreated,
                 terminalNeedsNext, lastAcceptedFence>>`,
  PendingFollowupIsTerminal: String.raw`  /\ pendingNext' = TRUE
  /\ UNCHANGED <<state, waitCause, owner, fence, generation, lease, now, available, attempts, retries,
                 deferrals, firstStarted, manualRetryAllowed, stopReason, tokens, childCreated,
                 terminalNeedsNext, lastAcceptedFence>>`,
  ResetStatesHaveNoPendingFollowup: String.raw`  /\ pendingNext' = TRUE
  /\ UNCHANGED <<state, waitCause, owner, fence, generation, lease, now, available, attempts, retries,
                 deferrals, firstStarted, manualRetryAllowed, stopReason, tokens, childCreated,
                 terminalNeedsNext, lastAcceptedFence>>`,
  NoLostContinuation: String.raw`  /\ terminalNeedsNext' = TRUE /\ pendingNext' = FALSE /\ childCreated' = FALSE
  /\ UNCHANGED <<state, waitCause, owner, fence, generation, lease, now, available, attempts, retries,
                 deferrals, firstStarted, manualRetryAllowed, stopReason, tokens, lastAcceptedFence>>`,
};

const runtimeMutants = {
  RuntimeTypeOK: String.raw`  /\ pc' = "invalid"
  /\ UNCHANGED <<active, fatalPresent, failureKind, aborted, result, stopActive>>`,
  FailurePresenceIndependent: String.raw`  /\ fatalPresent' = TRUE /\ failureKind' = "none"
  /\ UNCHANGED <<pc, active, aborted, result, stopActive>>`,
  NoFatalBackoff: String.raw`  /\ pc' = "backoff" /\ fatalPresent' = TRUE /\ failureKind' = "defined"
  /\ UNCHANGED <<active, aborted, result, stopActive>>`,
  NoAdmissionAfterStop: String.raw`  /\ pc' = "draining" /\ active' = 1 /\ aborted' = TRUE /\ stopActive' = 0
  /\ UNCHANGED <<fatalPresent, failureKind, result>>`,
  DrainedBeforeReturn: String.raw`  /\ pc' = "done" /\ active' = 1
  /\ UNCHANGED <<fatalPresent, failureKind, aborted, result, stopActive>>`,
  FatalReturnRejects: String.raw`  /\ pc' = "done" /\ active' = 0 /\ fatalPresent' = TRUE /\ failureKind' = "defined"
  /\ result' = "fulfilled"
  /\ UNCHANGED <<aborted, stopActive>>`,
};

const lifecycleMutationPlan = mutationCoveragePlan('formal/WorkOnce.cfg', lifecycleMutants);
const runtimeMutationPlan = mutationCoveragePlan('formal/WorkOnceRuntime.cfg', runtimeMutants, [
  'RuntimeSamplesConform',
]);

function tlaValue(value) {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return `[${Object.entries(value)
      .map(([key, item]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new Error('Invalid observation field');
        return `${key} |-> ${tlaValue(item)}`;
      })
      .join(', ')}]`;
  }
  throw new Error('Unrepresentable runtime observation');
}

const lifecycleConfig = readFileSync('formal/WorkOnce.cfg', 'utf8');
if (!process.argv.includes('--runtime-only')) {
  runModel('WorkOnce', 'WorkOnce.cfg');
  runMutationWitnessBatch({
    model: 'WorkOnceInvariantMutationBatch',
    baseModule: 'WorkOnce',
    baseConfig: lifecycleConfig,
    plan: lifecycleMutationPlan,
  });
}

// No per-trace TLC processes and no cached witness: check fresh compiled public API observations
// in one separate, small control-state graph. The durable graph is not cross-product inflated.
const { runRuntimeBoundarySamples } = await import('./runtime-boundary-refinement.mjs');
const samples = await runRuntimeBoundarySamples();
const config = resolve('.artifacts/tlc/WorkOnceRuntime-observed.cfg');
const observedModule = resolve('.artifacts/tlc/WorkOnceRuntimeObserved.tla');
writeFileSync(
  observedModule,
  `---- MODULE WorkOnceRuntimeObserved ----\nEXTENDS WorkOnceRuntime\nObservedSamples == {\n${samples.map(tlaValue).join(',\n')}\n}\n====\n`,
);
writeFileSync(
  config,
  `${readFileSync('formal/WorkOnceRuntime.cfg', 'utf8')}\nCONSTANT Samples <- ObservedSamples\n`,
);
console.log(
  `TLC runtime boundary receives ${samples.length} fresh compiled public API observations.`,
);
runModel('WorkOnceRuntimeObserved', config, observedModule);

const runtimeConfig = readFileSync(config, 'utf8');
runMutationWitnessBatch({
  model: 'WorkOnceRuntimeInvariantMutationBatch',
  baseModule: 'WorkOnceRuntimeObserved',
  baseConfig: runtimeConfig,
  plan: runtimeMutationPlan,
});

const sampleMutant = resolve('.artifacts/tlc/WorkOnceRuntimeSamplesMutant.tla');
const sampleMutantConfig = resolve('.artifacts/tlc/WorkOnceRuntimeSamplesMutant.cfg');
writeFileSync(
  sampleMutant,
  String.raw`---- MODULE WorkOnceRuntimeSamplesMutant ----
EXTENDS WorkOnceRuntimeObserved
BadSamples == ObservedSamples \cup {[kind |-> "invalid"]}
MutantSpec == Init /\ [][Next]_vars
====
`,
);
writeFileSync(
  sampleMutantConfig,
  singleInvariantConfig(runtimeConfig, 'RuntimeSamplesConform').replace(
    'CONSTANT Samples <- ObservedSamples',
    'CONSTANT Samples <- BadSamples',
  ),
);
requireInvariantRejects(
  'WorkOnceRuntimeSamplesMutant',
  sampleMutantConfig,
  sampleMutant,
  'RuntimeSamplesConform',
);
markExtraMutationWitness(runtimeMutationPlan, 'RuntimeSamplesConform');

// Keep the realistic late-admission mutant in addition to the one-step activity check above.
const admissionMutant = resolve('.artifacts/tlc/WorkOnceRuntimeAdmissionMutant.tla');
const admissionMutantConfig = resolve('.artifacts/tlc/WorkOnceRuntimeAdmissionMutant.cfg');
writeFileSync(
  admissionMutant,
  String.raw`---- MODULE WorkOnceRuntimeAdmissionMutant ----
EXTENDS WorkOnceRuntimeObserved
UnsafeLateAdmission ==
  /\ pc = "claim" /\ Stopped /\ active < 2
  /\ pc' = "draining" /\ active' = active + 1
  /\ UNCHANGED <<fatalPresent, failureKind, aborted, result, stopActive>>
MutantNext == Next \/ UnsafeLateAdmission
MutantSpec == Init /\ [][MutantNext]_vars
====
`,
);
writeFileSync(admissionMutantConfig, singleInvariantConfig(runtimeConfig, 'NoAdmissionAfterStop'));
requireInvariantRejects(
  'WorkOnceRuntimeAdmissionMutant',
  admissionMutantConfig,
  admissionMutant,
  'NoAdmissionAfterStop',
);

assertMutationPlansExecuted(
  process.argv.includes('--runtime-only')
    ? [runtimeMutationPlan]
    : [lifecycleMutationPlan, runtimeMutationPlan],
);
