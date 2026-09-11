import { availableParallelism } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBuildSourceBinding } from './build-source-binding.mjs';
import { classifyTlcOutcome, requireExpectedInvariantViolation } from './tlc-outcome.mjs';
import {
  acquireTlcWorkspace,
  cleanupTlcWorkspaceOnSuccess,
  createTlcWorkspace,
} from './tlc-workspace.mjs';

assertBuildSourceBinding();
if (process.argv.includes('--binding-check-only')) {
  console.log('Compiled WorkOnce output and emitted artifacts match current TypeScript sources.');
  process.exit(0);
}

const jar = resolve(process.env.TLA2TOOLS_JAR ?? '.artifacts/tla2tools.jar');
if (!existsSync(jar))
  throw new Error('Set TLA2TOOLS_JAR to the official tla2tools.jar. See docs/assurance.md.');
const shardMode = ['--runtime-only', '--non-runtime-only'].some((flag) =>
  process.argv.includes(flag),
);
const tlcWorkspace = acquireTlcWorkspace(shardMode ? 'formal-shard' : 'formal-parent');
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

function tlcArgs(model, config, modulePath, options = {}) {
  const heapMb = options.heapMb ?? 512;
  const workerCount = options.workerCount ?? workers;
  return [
    `-Xmx${heapMb}m`,
    '-XX:+UseParallelGC',
    `-Djava.io.tmpdir=${javaTmp}`,
    `-DTLA-Library=${[resolve('formal'), tlcWorkspace].join(delimiter)}`,
    '-cp',
    jar,
    'tlc2.TLC',
    '-workers',
    workerCount,
    '-metadir',
    resolve(tlcWorkspace, model),
    '-config',
    config,
    modulePath,
  ];
}

function runModel(model, config, modulePath = `${model}.tla`) {
  const directory = resolve(tlcWorkspace, model);
  mkdirSync(directory, { recursive: true });
  const result = spawnSync('java', tlcArgs(model, config, modulePath), {
    cwd: 'formal',
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  });
  const outcome = classifyTlcOutcome(result);
  if (outcome.kind === 'success') return;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (outcome.kind === 'semantic_counterexample')
    throw new Error(`TLC semantic counterexample (${outcome.reason}) in ${model}.`);
  throw new Error(
    `TLC infrastructure failure (${outcome.reason}) in ${model}.\n${outcome.output.slice(-2000)}`,
    result.error ? { cause: result.error } : undefined,
  );
}

function requireInvariantRejects(model, config, modulePath, invariant) {
  const directory = resolve(tlcWorkspace, model);
  mkdirSync(directory, { recursive: true });
  const result = spawnSync(
    'java',
    tlcArgs(model, config, modulePath, { heapMb: 192, workerCount: '1' }),
    {
      cwd: 'formal',
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  requireExpectedInvariantViolation(result, invariant);
  console.log(`TLC mutation guard: ${invariant} rejects its injected violating transition.`);
}

function runReachableMutationWitnessBatch({
  model,
  baseModule,
  baseConfig,
  witnesses,
  directInvariants = [],
}) {
  const modulePath = resolve(tlcWorkspace, `${model}.tla`);
  const configPath = resolve(tlcWorkspace, `${model}.cfg`);
  const definitions = [];
  const expected = [];
  for (const witness of witnesses) {
    const actionName = `${witness.name}Unsafe`;
    const absentName = `${witness.name}WitnessAbsent`;
    definitions.push(`${actionName} ==\n${witness.action}`);
    definitions.push(`${absentName} == ~ENABLED (${actionName} /\\ ~${witness.invariant}')`);
    expected.push(absentName);
  }
  expected.push(...directInvariants);
  writeFileSync(
    modulePath,
    `---- MODULE ${model} ----\nEXTENDS ${baseModule}\n${definitions.join('\n\n')}\n====\n`,
  );
  writeFileSync(
    configPath,
    `${baseConfig.trimEnd()}\n${expected.map((name) => `INVARIANT ${name}`).join('\n')}\n`,
  );
  const directory = resolve(tlcWorkspace, model);
  mkdirSync(directory, { recursive: true });
  const baseArgs = tlcArgs(model, configPath, modulePath, { heapMb: 192, workerCount: '1' });
  baseArgs.splice(baseArgs.length - 1, 0, '-continue');
  const result = spawnSync('java', baseArgs, {
    cwd: 'formal',
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.signal || result.status === null || result.status === undefined)
    throw new Error(`TLC reachable-mutation batch ${model} did not complete normally.`, {
      cause: result.error,
    });
  if (result.status !== 0) {
    const outcome = classifyTlcOutcome(result);
    throw new Error(
      `TLC reachable-mutation batch ${model} failed as ${outcome.kind}/${outcome.reason ?? 'unknown'}.\n${outcome.output.slice(-2000)}`,
    );
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  for (const invariant of expected) {
    const escaped = invariant.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    if (!new RegExp(`Invariant\\s+${escaped}\\s+is violated`, 'u').test(output))
      throw new Error(
        `TLC reachable-mutation batch ${model} did not prove witness ${invariant}.\n${output.slice(-2000)}`,
      );
  }
  if (!/0 states left on queue\./u.test(output))
    throw new Error(`TLC reachable-mutation batch ${model} did not exhaust its state graph.`);
  console.log(
    `TLC reachable-mutation batch proves ${expected.length} exact counterexample witnesses for ${baseModule} in one state-graph traversal.`,
  );
}

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

function singleInvariantConfig(configText, invariant) {
  const lines = configText.replace(/\r\n?/gu, '\n').split('\n');
  const output = [];
  let skipping = false;
  let inserted = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^INVARIANT\s+[A-Za-z_][A-Za-z0-9_]*$/u.test(trimmed)) continue;
    if (trimmed === 'INVARIANTS') {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (/^\s+[A-Za-z_][A-Za-z0-9_]*\s*$/u.test(line)) continue;
      skipping = false;
    }
    if (trimmed === 'SPECIFICATION Spec') {
      output.push('SPECIFICATION MutantSpec');
      continue;
    }
    if (trimmed === 'CHECK_DEADLOCK FALSE' && !inserted) {
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

function assertAllFormalConfigsRegistered(plans, externallyGuardedConfigs) {
  const discovered = readdirSync('formal')
    .filter((name) => name.endsWith('.cfg'))
    .map((name) => `formal/${name}`)
    .sort();
  const registered = [...plans.map((plan) => plan.configPath), ...externallyGuardedConfigs].sort();
  if (JSON.stringify(discovered) !== JSON.stringify(registered))
    throw new Error(
      `Formal config mutation coverage inventory drifted: discovered=${discovered.join(',')} planned=${registered.join(',')}`,
    );
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
  let specSwapped = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^INVARIANT\s+[A-Za-z_][A-Za-z0-9_]*$/u.test(trimmed)) continue;
    if (trimmed === 'INVARIANTS') {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (/^\s+[A-Za-z_][A-Za-z0-9_]*\s*$/u.test(line)) continue;
      skipping = false;
    }
    if (trimmed === 'SPECIFICATION Spec') {
      output.push('SPECIFICATION BatchSpec');
      specSwapped = true;
      continue;
    }
    if (trimmed === 'CHECK_DEADLOCK FALSE' && !inserted) {
      output.push('INVARIANT MutationWitnesses');
      output.push('INVARIANT MutationBranchesEnabled');
      inserted = true;
    }
    output.push(line);
  }
  if (!inserted) output.push('INVARIANT MutationWitnesses', 'INVARIANT MutationBranchesEnabled');
  if (!specSwapped)
    throw new Error('Mutation witness config found no SPECIFICATION Spec line to rebind');
  return `${output.join('\n').trimEnd()}\n`;
}

try {
  mutationWitnessConfig('SPECIFICATION WrongSpec\nCHECK_DEADLOCK FALSE\n');
  throw new Error('Mutation witness config missing-spec self-test unexpectedly passed');
} catch (error) {
  if (!/found no SPECIFICATION Spec line to rebind/u.test(error?.message ?? '')) throw error;
}

function runMutationWitnessBatch({ model, baseModule, baseConfig, plan }) {
  const { mutants } = plan;
  const modulePath = resolve(tlcWorkspace, `${model}.tla`);
  const configPath = resolve(tlcWorkspace, `${model}.cfg`);
  const mutationEntries = Object.entries(mutants);
  const branchDefinitions = mutationEntries
    .map(([invariant, action]) => {
      const rawLines = action.replace(/^\n+|\n+$/gu, '').split('\n');
      const nonEmpty = rawLines.filter((line) => line.trim().length > 0);
      const commonIndent = Math.min(...nonEmpty.map((line) => /^\s*/u.exec(line)?.[0].length ?? 0));
      const body = rawLines.map((line) => `  ${line.slice(commonIndent)}`).join('\n');
      return `Mutant_${invariant} ==\n  /\\ mutantId = "none"\n${body}\n  /\\ mutantId' = ${JSON.stringify(invariant)}`;
    })
    .join('\n\n');
  const branches = mutationEntries.map(([invariant]) => `  \\/ Mutant_${invariant}`).join('\n');
  const enabledBranches = mutationEntries
    .map(([invariant]) => `    /\\ ENABLED Mutant_${invariant}`)
    .join('\n');
  const witnesses = Object.keys(mutants)
    .map((invariant) => `  \\/ /\\ mutantId = ${JSON.stringify(invariant)} /\\ ~${invariant}`)
    .join('\n');
  writeFileSync(
    modulePath,
    `---- MODULE ${model} ----\nEXTENDS ${baseModule}\nVARIABLE mutantId\nbatchVars == <<vars, mutantId>>\nBatchInit == /\\ Init /\\ mutantId = "none"\n${branchDefinitions}\nUnsafe ==\n${branches}\nBatchNext == Unsafe\nMutationWitnesses ==\n  \\/ mutantId = "none"\n${witnesses}\nMutationBranchesEnabled ==\n  \\/ mutantId # "none"\n  \\/ /\\ mutantId = "none"\n${enabledBranches}\nBatchSpec == BatchInit /\\ [][BatchNext]_batchVars\n====\n`,
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
  /\ UNCHANGED <<active, fatalPresent, failureKind, failureValue, firstFatalValue, aborted, result, returnValue, stopActive>>`,
  FailurePresenceIndependent: String.raw`  /\ fatalPresent' = TRUE /\ failureKind' = "none" /\ failureValue' = "none" /\ firstFatalValue' = "none"
  /\ UNCHANGED <<pc, active, aborted, result, returnValue, stopActive>>`,
  FirstFatalValuePreserved: String.raw`  /\ fatalPresent' = TRUE /\ failureKind' = "defined"
  /\ failureValue' = "errorB" /\ firstFatalValue' = "errorA"
  /\ UNCHANGED <<pc, active, aborted, result, returnValue, stopActive>>`,
  NoFatalBackoff: String.raw`  /\ pc' = "backoff" /\ fatalPresent' = TRUE /\ failureKind' = "defined" /\ failureValue' = "errorA" /\ firstFatalValue' = "errorA"
  /\ UNCHANGED <<active, aborted, result, returnValue, stopActive>>`,
  NoAdmissionAfterStop: String.raw`  /\ pc' = "draining" /\ active' = 1 /\ aborted' = TRUE /\ stopActive' = 0
  /\ UNCHANGED <<fatalPresent, failureKind, failureValue, firstFatalValue, result, returnValue>>`,
  DrainedBeforeReturn: String.raw`  /\ pc' = "done" /\ active' = 1
  /\ UNCHANGED <<fatalPresent, failureKind, failureValue, firstFatalValue, aborted, result, returnValue, stopActive>>`,
  FatalReturnRejects: String.raw`  /\ pc' = "done" /\ active' = 0 /\ fatalPresent' = TRUE
  /\ failureKind' = "defined" /\ failureValue' = "errorA" /\ firstFatalValue' = "errorA" /\ result' = "fulfilled" /\ returnValue' = "errorA"
  /\ UNCHANGED <<aborted, stopActive>>`,
  FatalValuePreserved: String.raw`  /\ pc' = "done" /\ active' = 0 /\ fatalPresent' = TRUE
  /\ failureKind' = "defined" /\ failureValue' = "errorA" /\ firstFatalValue' = "errorA" /\ result' = "rejected" /\ returnValue' = "errorB"
  /\ UNCHANGED <<aborted, stopActive>>`,
};

const readHistoryMutants = {
  ReadHistoryTypeOK: String.raw`  /\ left' = [BaseProjection EXCEPT !.state = "invalid"]
  /\ right' = BaseProjection /\ leftHistory' = BaseHistoryA /\ rightHistory' = BaseHistoryB
  /\ futureHistory' = <<>> /\ historyWrites' = 0 /\ depth' = 0`,
  CurrentProjectionCongruent: String.raw`  /\ left' = BaseProjection
  /\ right' = [BaseProjection EXCEPT !.state = "running"]
  /\ leftHistory' = BaseHistoryA /\ rightHistory' = BaseHistoryB
  /\ futureHistory' = <<>> /\ historyWrites' = 0 /\ depth' = 0`,
  EnabledFutureCongruent: String.raw`  /\ left' = BaseProjection
  /\ right' = [BaseProjection EXCEPT !.state = "running"]
  /\ leftHistory' = BaseHistoryA /\ rightHistory' = BaseHistoryB
  /\ futureHistory' = <<>> /\ historyWrites' = 0 /\ depth' = 0`,
  OutcomeFutureCongruent: String.raw`  /\ left' = BaseProjection
  /\ right' = [BaseProjection EXCEPT !.state = "running"]
  /\ leftHistory' = BaseHistoryA /\ rightHistory' = BaseHistoryB
  /\ futureHistory' = <<>> /\ historyWrites' = 0 /\ depth' = 0`,
  HistoryBounded: String.raw`  /\ left' = BaseProjection /\ right' = BaseProjection
  /\ leftHistory' = <<>> /\ rightHistory' = BaseHistoryB
  /\ futureHistory' = <<>> /\ historyWrites' = 0 /\ depth' = 0`,
  HistoryRetentionOrder: String.raw`  /\ left' = BaseProjection /\ right' = BaseProjection
  /\ leftHistory' = BaseHistoryA /\ rightHistory' = BaseHistoryB
  /\ futureHistory' = <<"claim">> /\ historyWrites' = 1 /\ depth' = 1`,
  HistoryDifferenceVisible: String.raw`  /\ left' = BaseProjection /\ right' = BaseProjection
  /\ leftHistory' = BaseHistoryA /\ rightHistory' = BaseHistoryA
  /\ futureHistory' = <<>> /\ historyWrites' = 0 /\ depth' = 0`,
};

const localRunnerMutants = {
  LocalTypeOK: String.raw`  /\ pc' = "invalid"
  /\ UNCHANGED <<active, stopped, fatalPresent, lossPresent, lossValue, firstLossValue,
                 returnPresent, returnValue, stopActive>>`,
  LossPresenceExact: String.raw`  /\ pc' = "ready" /\ active' = 0 /\ stopped' = FALSE
  /\ fatalPresent' = TRUE /\ lossPresent' = FALSE /\ lossValue' = "none" /\ firstLossValue' = "none"
  /\ returnPresent' = FALSE /\ returnValue' = "none" /\ stopActive' = 0`,
  LocalFirstFatalValuePreserved: String.raw`  /\ pc' = "draining" /\ active' = 0 /\ stopped' = FALSE
  /\ fatalPresent' = TRUE /\ lossPresent' = TRUE /\ lossValue' = "errorB" /\ firstLossValue' = "errorA"
  /\ returnPresent' = FALSE /\ returnValue' = "none" /\ stopActive' = 0`,
  LocalNoAdmissionAfterStop: String.raw`  /\ pc' = "draining" /\ active' = 1 /\ stopped' = TRUE
  /\ fatalPresent' = FALSE /\ lossPresent' = FALSE /\ lossValue' = "none" /\ firstLossValue' = "none"
  /\ returnPresent' = FALSE /\ returnValue' = "none" /\ stopActive' = 0`,
  LocalDrainedBeforeReturn: String.raw`  /\ pc' = "done" /\ active' = 1 /\ stopped' = TRUE
  /\ fatalPresent' = FALSE /\ lossPresent' = FALSE /\ lossValue' = "none" /\ firstLossValue' = "none"
  /\ returnPresent' = FALSE /\ returnValue' = "none" /\ stopActive' = 1`,
  LocalNoFatalBackoff: String.raw`  /\ pc' = "backoff" /\ active' = 0 /\ stopped' = FALSE
  /\ fatalPresent' = TRUE /\ lossPresent' = TRUE /\ lossValue' = "errorA" /\ firstLossValue' = "errorA"
  /\ returnPresent' = FALSE /\ returnValue' = "none" /\ stopActive' = 0`,
  LocalFatalReturnPreserves: String.raw`  /\ pc' = "done" /\ active' = 0 /\ stopped' = FALSE
  /\ fatalPresent' = TRUE /\ lossPresent' = TRUE /\ lossValue' = "errorA" /\ firstLossValue' = "errorA"
  /\ returnPresent' = TRUE /\ returnValue' = "errorB" /\ stopActive' = 0`,
};

const outboxMutants = {
  OutboxTypeOK: String.raw`  /\ cursor' = "invalid"
  /\ UNCHANGED <<aQueue, bQueue, attempts, delivered, passCount, crashes>>`,
  FirstPassRotatesPoison: String.raw`  /\ passCount' = 1
  /\ cursor' = "A"
  /\ attempts' = <<"a1">>
  /\ UNCHANGED <<aQueue, bQueue, delivered, crashes>>`,
  CrossParentOrder: String.raw`  /\ passCount' = 3
  /\ attempts' = <<"a1", "a2", "b1">>
  /\ UNCHANGED <<aQueue, bQueue, cursor, delivered, crashes>>`,
};

const outboxBudgetMutants = {
  BudgetTypeOK: String.raw`  /\ cursor' = "bad"
  /\ UNCHANGED <<aQueue, bQueue, cQueue, calls, delivered>>`,
  AllBudgetIntentAccounted: String.raw`  /\ aQueue' = <<"a1", "a2">>
  /\ UNCHANGED <<bQueue, cQueue, cursor, calls, delivered>>`,
  ExactBudgetPrefixes: String.raw`  /\ calls' = 1 /\ cursor' = "A"
  /\ UNCHANGED <<aQueue, bQueue, cQueue, delivered>>`,
  MidParentRemainsReachable: String.raw`  /\ calls' = 1 /\ aQueue' = <<"a1", "a2">>
  /\ UNCHANGED <<bQueue, cQueue, cursor, delivered>>`,
  AllReachedByFourth: String.raw`  /\ calls' = 4
  /\ UNCHANGED <<aQueue, bQueue, cQueue, cursor, delivered>>`,
};

const externalMutants = {
  ExternalTypeOK: String.raw`  /\ phase' = "invalid"
  /\ UNCHANGED <<fence, exports, effects, receiptFence, lastRejectedFence, reply>>`,
  CurrentRunningExported: String.raw`  /\ phase' = "running" /\ fence' = 1 /\ exports' = {}
  /\ effects' = {} /\ receiptFence' = 0 /\ lastRejectedFence' = 0 /\ reply' = "lease"`,
  EffectsRequireExport: String.raw`  /\ phase' = "available" /\ fence' = 0 /\ exports' = {}
  /\ effects' = {1} /\ receiptFence' = 0 /\ lastRejectedFence' = 0 /\ reply' = "effect"`,
  RejectedFenceIsStale: String.raw`  /\ phase' = "available" /\ fence' = 1 /\ exports' = {1}
  /\ effects' = {} /\ receiptFence' = 0 /\ lastRejectedFence' = 1 /\ reply' = "stale"`,
};

const policyMutants = {
  PolicyTypeOK: String.raw`  /\ pc' = "invalid"
  /\ UNCHANGED <<phase, revision, snapRevision, fence, oldReferenceFence, receiptFence, receipt,
                 snapReceiptFence, snapReceipt, faultRevision, faultPhase,
                 faultReceiptFence, faultReceipt, submission, reply>>`,
  StalePolicyCannotPublish: String.raw`  /\ pc' = "done" /\ phase' = "running"
  /\ revision' = 1 /\ snapRevision' = 1 /\ fence' = 1
  /\ oldReferenceFence' = 0
  /\ receiptFence' = 1 /\ receipt' = "implicit"
  /\ snapReceiptFence' = 0 /\ snapReceipt' = "none"
  /\ faultRevision' = 0 /\ faultPhase' = "none"
  /\ faultReceiptFence' = 0 /\ faultReceipt' = "none"
  /\ submission' = "implicit" /\ reply' = "stale"`,
  PolicyFailureNoWrite: String.raw`  /\ pc' = "done" /\ phase' = "waiting"
  /\ revision' = 2 /\ snapRevision' = 1 /\ fence' = 1
  /\ oldReferenceFence' = 0
  /\ receiptFence' = 1 /\ receipt' = "implicit"
  /\ snapReceiptFence' = 0 /\ snapReceipt' = "none"
  /\ faultRevision' = 1 /\ faultPhase' = "running"
  /\ faultReceiptFence' = 0 /\ faultReceipt' = "none"
  /\ submission' = "none" /\ reply' = "callbackError"`,
  ReceiptIdentityControlsReplay: String.raw`  /\ pc' = "running" /\ phase' = "running"
  /\ revision' = 1 /\ snapRevision' = 0 /\ fence' = 1
  /\ oldReferenceFence' = 0
  /\ receiptFence' = 1 /\ receipt' = "implicit"
  /\ snapReceiptFence' = 0 /\ snapReceipt' = "none"
  /\ faultRevision' = 0 /\ faultPhase' = "none"
  /\ faultReceiptFence' = 0 /\ faultReceipt' = "none"
  /\ submission' = "explicit" /\ reply' = "replay"`,
  ReceiptFenceTracksPublishedAttempt: String.raw`  /\ pc' = "waiting" /\ phase' = "waiting"
  /\ revision' = 3 /\ snapRevision' = 1 /\ fence' = 2
  /\ oldReferenceFence' = 0
  /\ receiptFence' = 1 /\ receipt' = "implicit"
  /\ snapReceiptFence' = 0 /\ snapReceipt' = "none"
  /\ faultRevision' = 0 /\ faultPhase' = "none"
  /\ faultReceiptFence' = 0 /\ faultReceipt' = "none"
  /\ submission' = "none" /\ reply' = "none"`,
  SupersededReceiptRejectsOld: String.raw`  /\ pc' = "waiting" /\ phase' = "waiting"
  /\ revision' = 2 /\ snapRevision' = 1 /\ fence' = 1
  /\ oldReferenceFence' = 0
  /\ receiptFence' = 1 /\ receipt' = "implicit"
  /\ snapReceiptFence' = 0 /\ snapReceipt' = "none"
  /\ faultRevision' = 0 /\ faultPhase' = "none"
  /\ faultReceiptFence' = 0 /\ faultReceipt' = "none"
  /\ submission' = "implicit" /\ reply' = "staleOld"`,
};

const lifecycleMutationPlan = mutationCoveragePlan('formal/WorkOnce.cfg', lifecycleMutants);
const runtimeMutationPlan = mutationCoveragePlan('formal/WorkOnceRuntime.cfg', runtimeMutants, [
  'RuntimeSamplesConform',
]);
const readHistoryMutationPlan = mutationCoveragePlan(
  'formal/WorkOnceReadHistory.cfg',
  readHistoryMutants,
);
const localRunnerMutationPlan = mutationCoveragePlan(
  'formal/WorkOnceLocalRunner.cfg',
  localRunnerMutants,
);
const policyMutationPlan = mutationCoveragePlan('formal/WorkOncePolicy.cfg', policyMutants);
const externalMutationPlan = mutationCoveragePlan('formal/WorkOnceExternal.cfg', externalMutants, [
  'SuccessReceiptCurrent',
  'UnknownAckIsDurable',
]);
const outboxMutationPlan = mutationCoveragePlan('formal/WorkOnceOutbox.cfg', outboxMutants, [
  'PoisonIntentRetained',
  'AllOriginalIntentAccounted',
  'HealthyReachedByThirdPass',
]);
const outboxBudgetMutationPlan = mutationCoveragePlan(
  'formal/WorkOnceOutboxBudget.cfg',
  outboxBudgetMutants,
);
const directMutationPlans = [
  lifecycleMutationPlan,
  runtimeMutationPlan,
  readHistoryMutationPlan,
  localRunnerMutationPlan,
  policyMutationPlan,
  externalMutationPlan,
  outboxMutationPlan,
  outboxBudgetMutationPlan,
];
const externallyGuardedFormalConfigs = [
  'formal/WorkOnceLifecycleTemporal.cfg',
  'formal/WorkOnceClaimScan.cfg',
  'formal/WorkOnceStorage.cfg',
];
assertAllFormalConfigsRegistered(directMutationPlans, externallyGuardedFormalConfigs);
if (process.argv.includes('--config-coverage-only')) {
  console.log(
    `Formal config mutation coverage registers ${directMutationPlans.length + externallyGuardedFormalConfigs.length} current configs fail closed across the formal, lifecycle, and storage proof runners.`,
  );
  process.exit(0);
}

const runtimeOnly = process.argv.includes('--runtime-only');
const nonRuntimeOnly = process.argv.includes('--non-runtime-only');
if (runtimeOnly && nonRuntimeOnly) throw new Error('Formal shard modes are mutually exclusive.');
if (!runtimeOnly && !nonRuntimeOnly) {
  const script = fileURLToPath(import.meta.url);
  const runShard = (mode) =>
    new Promise((resolveShard, rejectShard) => {
      const shardWorkspace = createTlcWorkspace(`formal-${mode.slice(2)}`);
      cleanupTlcWorkspaceOnSuccess(shardWorkspace);
      const child = spawn(process.execPath, [script, mode], {
        cwd: process.cwd(),
        env: { ...process.env, WORKONCE_TLC_ARTIFACT_DIR: shardWorkspace },
        stdio: 'inherit',
      });
      child.once('error', rejectShard);
      child.once('exit', (code, signal) => {
        if (code === 0) resolveShard();
        else
          rejectShard(new Error(`Formal shard ${mode} failed with ${signal ?? `exit ${code}`}.`));
      });
    });
  const parentShardModes = ['--runtime-only', '--non-runtime-only'];
  if (availableParallelism() <= 2) {
    for (const mode of parentShardModes) await runShard(mode);
  } else {
    const results = await Promise.allSettled(parentShardModes.map((mode) => runShard(mode)));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  process.exit(0);
}

function bindObservedSamples(configText) {
  const marker = 'CONSTANT Samples = {}';
  const occurrences = configText.split(marker).length - 1;
  if (occurrences !== 1)
    throw new Error(
      `Observed-sample config must contain exactly one ${marker} binding; found ${occurrences}.`,
    );
  return configText.replace(marker, 'CONSTANT Samples <- ObservedSamples');
}

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
if (nonRuntimeOnly) {
  runModel('WorkOnce', 'WorkOnce.cfg');
  runMutationWitnessBatch({
    model: 'WorkOnceInvariantMutationBatch',
    baseModule: 'WorkOnce',
    baseConfig: lifecycleConfig,
    plan: lifecycleMutationPlan,
  });
}

if (runtimeOnly) {
  // No per-trace TLC processes and no cached witness: check fresh compiled public API observations
  // in one separate, small control-state graph. The durable graph is not cross-product inflated.
  const { runRuntimeBoundarySamples } = await import('./runtime-boundary-refinement.mjs');
  const samples = await runRuntimeBoundarySamples();
  const config = resolve(tlcWorkspace, 'WorkOnceRuntime-observed.cfg');
  const observedModule = resolve(tlcWorkspace, 'WorkOnceRuntimeObserved.tla');
  writeFileSync(
    observedModule,
    `---- MODULE WorkOnceRuntimeObserved ----\nEXTENDS WorkOnceRuntime\nObservedSamples == {\n${samples.map(tlaValue).join(',\n')}\n}\nInvalidSamples == ObservedSamples \\cup {[kind |-> \"invalid\"]}\nBadRunner == [kind |-> \"runner\", failureValue |-> \"none\", returnedValue |-> \"none\", handled |-> FALSE, rejected |-> TRUE, preserved |-> TRUE, drained |-> TRUE, timedOut |-> FALSE, site |-> \"direct\"]\nBadRunnerSamples == ObservedSamples \\cup {BadRunner}\nBadRead == [kind |-> \"read\", matched |-> FALSE, accepted |-> TRUE, definitionError |-> FALSE, snapshotExact |-> FALSE, errorCause |-> \"none\"]\nBadReadSamples == ObservedSamples \\cup {BadRead}\nInvalidSampleCheck == INSTANCE WorkOnceRuntime WITH Samples <- InvalidSamples\nBadRunnerCheck == INSTANCE WorkOnceRuntime WITH Samples <- BadRunnerSamples\nBadReadCheck == INSTANCE WorkOnceRuntime WITH Samples <- BadReadSamples\nRuntimeNegativeSampleMutantsRejected == /\\ ~InvalidSampleCheck!RuntimeSamplesConform /\\ ~BadRunnerCheck!RuntimeSamplesConform /\\ ~BadReadCheck!RuntimeSamplesConform\n====\n`,
  );
  writeFileSync(
    config,
    `${readFileSync('formal/WorkOnceRuntime.cfg', 'utf8')}\nCONSTANT Samples <- ObservedSamples\nINVARIANT RuntimeNegativeSampleMutantsRejected\n`,
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

  markExtraMutationWitness(runtimeMutationPlan, 'RuntimeSamplesConform');
  console.log(
    'TLC mutation guard: RuntimeSamplesConform rejects all 3 injected sample mutations in the observed-model run.',
  );

  // Keep the realistic late-admission mutant in addition to the one-step activity check above.
  const admissionMutant = resolve(tlcWorkspace, 'WorkOnceRuntimeAdmissionMutant.tla');
  const admissionMutantConfig = resolve(tlcWorkspace, 'WorkOnceRuntimeAdmissionMutant.cfg');
  writeFileSync(
    admissionMutant,
    String.raw`---- MODULE WorkOnceRuntimeAdmissionMutant ----
EXTENDS WorkOnceRuntimeObserved
UnsafeLateAdmission ==
  /\ pc = "claim" /\ Stopped /\ active < 2
  /\ pc' = "draining" /\ active' = active + 1
  /\ UNCHANGED <<fatalPresent, failureKind, failureValue, firstFatalValue, aborted, result, returnValue, stopActive>>
MutantNext == Next \/ UnsafeLateAdmission
MutantSpec == Init /\ [][MutantNext]_vars
====
`,
  );
  writeFileSync(
    admissionMutantConfig,
    singleInvariantConfig(runtimeConfig, 'NoAdmissionAfterStop'),
  );
  requireInvariantRejects(
    'WorkOnceRuntimeAdmissionMutant',
    admissionMutantConfig,
    admissionMutant,
    'NoAdmissionAfterStop',
  );

  const { runReadHistorySamples, assertReadHistorySamples } = await import(
    './read-history-refinement.mjs'
  );
  const readHistorySamples = await runReadHistorySamples();
  assertReadHistorySamples(readHistorySamples);
  const readHistoryObserved = resolve(tlcWorkspace, 'WorkOnceReadHistoryObserved.tla');
  const readHistoryConfig = resolve(tlcWorkspace, 'WorkOnceReadHistory-observed.cfg');
  writeFileSync(
    readHistoryObserved,
    `---- MODULE WorkOnceReadHistoryObserved ----\nEXTENDS WorkOnceReadHistory\nObservedSamples == {\n${readHistorySamples.map(tlaValue).join(',\n')}\n}\nInvalidSamples == ObservedSamples \\cup {[kind |-> \"invalid\"]}\nInvalidSampleCheck == INSTANCE WorkOnceReadHistory WITH Samples <- InvalidSamples\nReadHistoryNegativeSampleMutantRejected == ~InvalidSampleCheck!ReadHistorySamplesConform\n====\n`,
  );
  writeFileSync(
    readHistoryConfig,
    `${bindObservedSamples(readFileSync('formal/WorkOnceReadHistory.cfg', 'utf8'))}\nINVARIANT ReadHistorySamplesConform\nINVARIANT ReadHistoryNegativeSampleMutantRejected\n`,
  );
  console.log(
    `TLC read-history boundary receives ${readHistorySamples.length} fresh compiled observations.`,
  );
  runModel('WorkOnceReadHistoryObserved', readHistoryConfig, readHistoryObserved);

  const baseReadHistoryConfig = readFileSync('formal/WorkOnceReadHistory.cfg', 'utf8');
  runMutationWitnessBatch({
    model: 'WorkOnceReadHistoryInvariantMutationBatch',
    baseModule: 'WorkOnceReadHistory',
    baseConfig: baseReadHistoryConfig,
    plan: readHistoryMutationPlan,
  });

  const readHistoryInfluenceMutant = resolve(
    tlcWorkspace,
    'WorkOnceReadHistoryInfluenceMutant.tla',
  );
  const readHistoryInfluenceMutantConfig = resolve(
    tlcWorkspace,
    'WorkOnceReadHistoryInfluenceMutant.cfg',
  );
  writeFileSync(
    readHistoryInfluenceMutant,
    String.raw`---- MODULE WorkOnceReadHistoryInfluenceMutant ----
EXTENDS WorkOnceReadHistory
HistorySensitiveApply(p, history, op) ==
  IF history[DifferenceIndex] = "old:history-A"
  THEN Apply(p, op)
  ELSE [Apply(p, op) EXCEPT !.state = "failed"]
HistorySensitiveStep(op) ==
  /\ depth < MaxDepth
  /\ op \in Ops
  /\ LET writes == WritesHistory(left, op) IN
       /\ left' = HistorySensitiveApply(left, leftHistory, op)
       /\ right' = HistorySensitiveApply(right, rightHistory, op)
       /\ leftHistory' = IF writes THEN TrimAppend(leftHistory, HistoryEvent(left, op)) ELSE leftHistory
       /\ rightHistory' = IF writes THEN TrimAppend(rightHistory, HistoryEvent(right, op)) ELSE rightHistory
       /\ futureHistory' = IF writes THEN Append(futureHistory, HistoryEvent(left, op)) ELSE futureHistory
       /\ historyWrites' = IF writes THEN historyWrites + 1 ELSE historyWrites
       /\ depth' = depth + 1
HistorySensitiveNext == \E op \in Ops : HistorySensitiveStep(op)
MutantSpec == Init /\ [][HistorySensitiveNext]_vars
====
`,
  );
  writeFileSync(
    readHistoryInfluenceMutantConfig,
    singleInvariantConfig(baseReadHistoryConfig, 'CurrentProjectionCongruent').replace(
      'SPECIFICATION Spec',
      'SPECIFICATION MutantSpec',
    ),
  );
  requireInvariantRejects(
    'WorkOnceReadHistoryInfluenceMutant',
    readHistoryInfluenceMutantConfig,
    readHistoryInfluenceMutant,
    'CurrentProjectionCongruent',
  );
  console.log(
    'TLC read-history mutation guard rejects a future transition whose projection depends on durable history.',
  );

  console.log(
    'TLC mutation guard: ReadHistorySamplesConform rejects its injected bad sample in the observed-model run.',
  );

  const { runLocalRunnerRefinementSamples, assertLocalRunnerRefinementSamples } = await import(
    './local-runner-refinement.mjs'
  );
  const localRunnerSamples = await runLocalRunnerRefinementSamples();
  assertLocalRunnerRefinementSamples(localRunnerSamples);
  const localRunnerObserved = resolve(tlcWorkspace, 'WorkOnceLocalRunnerObserved.tla');
  const localRunnerConfig = resolve(tlcWorkspace, 'WorkOnceLocalRunner-observed.cfg');
  writeFileSync(
    localRunnerObserved,
    `---- MODULE WorkOnceLocalRunnerObserved ----\nEXTENDS WorkOnceLocalRunner\nObservedSamples == {\n${localRunnerSamples.map(tlaValue).join(',\n')}\n}\nInvalidSamples == ObservedSamples \\cup {[kind |-> \"invalid\"]}\nInvalidSampleCheck == INSTANCE WorkOnceLocalRunner WITH Samples <- InvalidSamples\nLocalRunnerNegativeSampleMutantRejected == ~InvalidSampleCheck!LocalRunnerSamplesConform\n====\n`,
  );
  writeFileSync(
    localRunnerConfig,
    `${bindObservedSamples(readFileSync('formal/WorkOnceLocalRunner.cfg', 'utf8'))}\nINVARIANT LocalRunnerSamplesConform\nINVARIANT LocalRunnerNegativeSampleMutantRejected\n`,
  );
  console.log(
    `TLC local-runner boundary receives ${localRunnerSamples.length} fresh compiled public API observations.`,
  );
  runModel('WorkOnceLocalRunnerObserved', localRunnerConfig, localRunnerObserved);

  const baseLocalRunnerConfig = readFileSync('formal/WorkOnceLocalRunner.cfg', 'utf8');
  runMutationWitnessBatch({
    model: 'WorkOnceLocalRunnerInvariantMutationBatch',
    baseModule: 'WorkOnceLocalRunner',
    baseConfig: baseLocalRunnerConfig,
    plan: localRunnerMutationPlan,
  });

  console.log(
    'TLC mutation guard: LocalRunnerSamplesConform rejects its injected bad sample in the observed-model run.',
  );
}

if (nonRuntimeOnly) {
  const { runPolicyRefinementSamples, assertPolicyRefinementSamples } = await import(
    './policy-refinement.mjs'
  );
  const policySamples = await runPolicyRefinementSamples();
  assertPolicyRefinementSamples(policySamples);
  const policyObserved = resolve(tlcWorkspace, 'WorkOncePolicyObserved.tla');
  const policyConfig = resolve(tlcWorkspace, 'WorkOncePolicy-observed.cfg');
  writeFileSync(
    policyObserved,
    `---- MODULE WorkOncePolicyObserved ----\nEXTENDS WorkOncePolicy\nObservedSamples == {\n${policySamples.map(tlaValue).join(',\n')}\n}\nInvalidSamples == ObservedSamples \\cup {[kind |-> \"invalid\"]}\nInvalidSampleCheck == INSTANCE WorkOncePolicy WITH Samples <- InvalidSamples\nPolicyNegativeSampleMutantRejected == ~InvalidSampleCheck!PolicySamplesConform\n====\n`,
  );
  writeFileSync(
    policyConfig,
    `${bindObservedSamples(readFileSync('formal/WorkOncePolicy.cfg', 'utf8'))}\nINVARIANT PolicySamplesConform\nINVARIANT PolicyNegativeSampleMutantRejected\n`,
  );
  console.log(
    `TLC policy boundary receives ${policySamples.length} fresh compiled public API observations.`,
  );
  runModel('WorkOncePolicyObserved', policyConfig, policyObserved);

  const basePolicyConfig = readFileSync('formal/WorkOncePolicy.cfg', 'utf8');
  runMutationWitnessBatch({
    model: 'WorkOncePolicyInvariantMutationBatch',
    baseModule: 'WorkOncePolicy',
    baseConfig: basePolicyConfig,
    plan: policyMutationPlan,
  });

  console.log(
    'TLC mutation guard: PolicySamplesConform rejects its injected bad sample in the observed-model run.',
  );
}

if (nonRuntimeOnly) {
  const { runOutboxRefinementSamples, assertOutboxRefinementSamples } = await import(
    './outbox-refinement.mjs'
  );
  // WorkOnceOutboxObserved runs the same base Spec and every base invariant below, so a separate
  // WorkOnceOutbox JVM would duplicate the identical state graph. The budget model remains distinct.
  runModel('WorkOnceOutboxBudget', 'WorkOnceOutboxBudget.cfg');
  const outboxSamples = await runOutboxRefinementSamples();
  assertOutboxRefinementSamples(outboxSamples);
  const outboxObserved = resolve(tlcWorkspace, 'WorkOnceOutboxObserved.tla');
  const outboxConfig = resolve(tlcWorkspace, 'WorkOnceOutbox-observed.cfg');
  writeFileSync(
    outboxObserved,
    `---- MODULE WorkOnceOutboxObserved ----\nEXTENDS WorkOnceOutbox\nCONSTANT Samples\nObservedSamples == {\n${outboxSamples.map(tlaValue).join(',\n')}\n}\nOutboxSamplesConformFor(S) ==\n  /\\ S # {}\n  /\\ {s.kind : s \\in S} = {"rotation", "poison", "restart", "ackLoss", "casAckLoss", "adapter", "adapterBudget", "adapterFaults", "adapterConcurrent", "budget", "grid", "multiPoison", "dynamic", "finiteArrivals", "concurrent", "limitBoundary", "staleParent", "rotationFailure", "multiError", "runDispatcher", "historyCongruence", "historySplit"}\n  /\\ \\A s \\in S : OutboxSampleOK(s)\nOutboxSamplesConform == OutboxSamplesConformFor(Samples)\nBadSamples == ObservedSamples \\cup {[kind |-> "invalid"]}\nOutboxNegativeSampleMutantRejected == ~OutboxSamplesConformFor(BadSamples)\n====\n`,
  );
  writeFileSync(
    outboxConfig,
    `${readFileSync('formal/WorkOnceOutbox.cfg', 'utf8')}\nCONSTANT Samples <- ObservedSamples\nINVARIANT OutboxSamplesConform\nINVARIANT OutboxNegativeSampleMutantRejected\n`,
  );
  console.log(
    `TLC outbox model receives ${outboxSamples.length} fresh compiled scheduler observations.`,
  );
  runModel('WorkOnceOutboxObserved', outboxConfig, outboxObserved);

  console.log(
    'TLC mutation guard: OutboxSamplesConform rejects its injected bad sample in the observed-model run.',
  );

  runMutationWitnessBatch({
    model: 'WorkOnceOutboxInvariantMutationBatch',
    baseModule: 'WorkOnceOutbox',
    baseConfig: readFileSync('formal/WorkOnceOutbox.cfg', 'utf8'),
    plan: outboxMutationPlan,
  });
  runMutationWitnessBatch({
    model: 'WorkOnceOutboxBudgetInvariantMutationBatch',
    baseModule: 'WorkOnceOutboxBudget',
    baseConfig: readFileSync('formal/WorkOnceOutboxBudget.cfg', 'utf8'),
    plan: outboxBudgetMutationPlan,
  });

  const semanticMutants = [
    {
      name: 'WorkOnceOutboxNoWrapMutant',
      invariant: 'HealthyReachedByThirdPass',
      action: String.raw`  /\ passCount = 2 /\ cursor = "B" /\ Len(aQueue) > 0 /\ Len(bQueue) = 0
  /\ passCount' = passCount + 1
  /\ UNCHANGED <<aQueue, bQueue, cursor, attempts, delivered, crashes>>`,
    },
    {
      name: 'WorkOnceOutboxSkippedChildMutant',
      invariant: 'AllOriginalIntentAccounted',
      action: String.raw`  /\ passCount = 0 /\ aQueue = <<"a1", "a2">> /\ aQueue' = <<"a1">>
  /\ UNCHANGED <<bQueue, cursor, attempts, delivered, passCount, crashes>>`,
    },
    {
      name: 'WorkOnceOutboxLostPoisonMutant',
      invariant: 'PoisonIntentRetained',
      action: String.raw`  /\ passCount = 1 /\ aQueue = <<"a2", "a1">> /\ aQueue' = <<"a2">>
  /\ UNCHANGED <<bQueue, cursor, attempts, delivered, passCount, crashes>>`,
    },
  ];
  runReachableMutationWitnessBatch({
    model: 'WorkOnceOutboxReachableMutationBatch',
    baseModule: 'WorkOnceOutboxObserved',
    baseConfig: readFileSync(outboxConfig, 'utf8'),
    witnesses: semanticMutants,
  });
  for (const mutant of semanticMutants)
    markExtraMutationWitness(outboxMutationPlan, mutant.invariant);
}

if (runtimeOnly) {
  const { runExternalTransportSamples, assertExternalTransportSamples } = await import(
    './external-transport-refinement.mjs'
  );
  const externalSamples = await runExternalTransportSamples();
  assertExternalTransportSamples(externalSamples);
  const externalObserved = resolve(tlcWorkspace, 'WorkOnceExternalObserved.tla');
  const externalConfig = resolve(tlcWorkspace, 'WorkOnceExternal-observed.cfg');
  writeFileSync(
    externalObserved,
    `---- MODULE WorkOnceExternalObserved ----\nEXTENDS WorkOnceExternal\nObservedSamples == {\n${externalSamples.map(tlaValue).join(',\n')}\n}\nInvalidSamples == ObservedSamples \\cup {[kind |-> \"invalid\"]}\nInvalidSampleCheck == INSTANCE WorkOnceExternal WITH Samples <- InvalidSamples\nExternalNegativeSampleMutantRejected == ~InvalidSampleCheck!ExternalSamplesConform\n====\n`,
  );
  writeFileSync(
    externalConfig,
    `${bindObservedSamples(readFileSync('formal/WorkOnceExternal.cfg', 'utf8'))}\nINVARIANT ExternalSamplesConform\nINVARIANT ExternalNegativeSampleMutantRejected\n`,
  );
  console.log(
    `TLC external transport boundary receives ${externalSamples.length} fresh compiled public API observations.`,
  );
  runModel('WorkOnceExternalObserved', externalConfig, externalObserved);

  const baseExternalConfig = readFileSync('formal/WorkOnceExternal.cfg', 'utf8');
  runMutationWitnessBatch({
    model: 'WorkOnceExternalInvariantMutationBatch',
    baseModule: 'WorkOnceExternal',
    baseConfig: baseExternalConfig,
    plan: externalMutationPlan,
  });

  const externalSemanticMutants = [
    {
      name: 'WorkOnceExternalBadSuccessReceiptMutant',
      invariant: 'SuccessReceiptCurrent',
      action: String.raw`  /\ phase = "running" /\ fence \in exports
  /\ phase' = "succeeded" /\ receiptFence' = 0 /\ reply' = "settled"
  /\ UNCHANGED <<fence, exports, effects, lastRejectedFence>>`,
    },
    {
      name: 'WorkOnceExternalUnknownAckNotDurableMutant',
      invariant: 'UnknownAckIsDurable',
      action: String.raw`  /\ phase = "running" /\ fence = 2 /\ fence \in exports /\ lastRejectedFence = 1
  /\ phase' = "running" /\ receiptFence' = 0 /\ reply' = "unknown"
  /\ UNCHANGED <<fence, exports, effects, lastRejectedFence>>`,
    },
  ];
  const [successReceiptMutant, unknownAckMutant] = externalSemanticMutants;
  const staleEffectWitness = {
    name: 'WorkOnceExternalStaleEffectReachability',
    invariant: 'NoStaleExternalEffect',
    action: String.raw`  /\ lastRejectedFence = 0
  /\ StaleEffect(1)`,
  };
  runReachableMutationWitnessBatch({
    model: 'WorkOnceExternalReachableMutationBatch',
    baseModule: 'WorkOnceExternalObserved',
    baseConfig: readFileSync(externalConfig, 'utf8'),
    witnesses: [staleEffectWitness, unknownAckMutant, successReceiptMutant],
    directInvariants: ['NoDuplicateExternalEffects'],
  });
  markExtraMutationWitness(externalMutationPlan, successReceiptMutant.invariant);
  markExtraMutationWitness(externalMutationPlan, unknownAckMutant.invariant);
  console.log(
    'TLC external boundary witnesses confirm duplicate effects and stale-attempt effects after reclaim are reachable; exactly-once is not claimed.',
  );
}

assertMutationPlansExecuted(
  runtimeOnly
    ? [runtimeMutationPlan, readHistoryMutationPlan, localRunnerMutationPlan, externalMutationPlan]
    : [lifecycleMutationPlan, policyMutationPlan, outboxMutationPlan, outboxBudgetMutationPlan],
);
