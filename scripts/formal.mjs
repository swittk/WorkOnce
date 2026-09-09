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
const shardMode = ['--runtime-only', '--non-runtime-only', '--external-only'].some((flag) =>
  process.argv.includes(flag),
);
const tlcWorkspace = acquireTlcWorkspace(shardMode ? 'formal-shard' : 'formal-parent');
cleanupTlcWorkspaceOnSuccess(tlcWorkspace);
const configuredWorkers = Number(process.env.WORKONCE_TLC_WORKERS);
const workers = String(
  Number.isSafeInteger(configuredWorkers) && configuredWorkers >= 2
    ? Math.min(configuredWorkers, availableParallelism())
    : Math.max(2, Math.min(8, availableParallelism())),
);
const timeoutMs = 30_000;

function tlcArgs(model, config, modulePath, options = {}) {
  const heapMb = options.heapMb ?? 512;
  const workerCount = options.workerCount ?? workers;
  return [
    `-Xmx${heapMb}m`,
    '-XX:+UseParallelGC',
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
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const outcome = classifyTlcOutcome(result);
  if (outcome.kind === 'success') return;
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
      continue;
    }
    if (trimmed === 'CHECK_DEADLOCK FALSE' && !inserted) {
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
  const modulePath = resolve(tlcWorkspace, `${model}.tla`);
  const configPath = resolve(tlcWorkspace, `${model}.cfg`);
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
  /\ UNCHANGED <<active, fatalPresent, failureKind, failureValue, aborted, result, returnValue, stopActive>>`,
  FailurePresenceIndependent: String.raw`  /\ fatalPresent' = TRUE /\ failureKind' = "none" /\ failureValue' = "none"
  /\ UNCHANGED <<pc, active, aborted, result, returnValue, stopActive>>`,
  NoFatalBackoff: String.raw`  /\ pc' = "backoff" /\ fatalPresent' = TRUE /\ failureKind' = "defined" /\ failureValue' = "errorA"
  /\ UNCHANGED <<active, aborted, result, returnValue, stopActive>>`,
  NoAdmissionAfterStop: String.raw`  /\ pc' = "draining" /\ active' = 1 /\ aborted' = TRUE /\ stopActive' = 0
  /\ UNCHANGED <<fatalPresent, failureKind, failureValue, result, returnValue>>`,
  DrainedBeforeReturn: String.raw`  /\ pc' = "done" /\ active' = 1
  /\ UNCHANGED <<fatalPresent, failureKind, failureValue, aborted, result, returnValue, stopActive>>`,
  FatalReturnRejects: String.raw`  /\ pc' = "done" /\ active' = 0 /\ fatalPresent' = TRUE
  /\ failureKind' = "defined" /\ failureValue' = "errorA" /\ result' = "fulfilled" /\ returnValue' = "errorA"
  /\ UNCHANGED <<aborted, stopActive>>`,
  FatalValuePreserved: String.raw`  /\ pc' = "done" /\ active' = 0 /\ fatalPresent' = TRUE
  /\ failureKind' = "defined" /\ failureValue' = "errorA" /\ result' = "rejected" /\ returnValue' = "errorB"
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
  /\ UNCHANGED <<active, stopped, fatalPresent, lossPresent, lossValue,
                 returnPresent, returnValue, stopActive>>`,
  LossPresenceExact: String.raw`  /\ pc' = "ready" /\ active' = 0 /\ stopped' = FALSE
  /\ fatalPresent' = TRUE /\ lossPresent' = FALSE /\ lossValue' = "none"
  /\ returnPresent' = FALSE /\ returnValue' = "none" /\ stopActive' = 0`,
  LocalNoAdmissionAfterStop: String.raw`  /\ pc' = "draining" /\ active' = 1 /\ stopped' = TRUE
  /\ fatalPresent' = FALSE /\ lossPresent' = FALSE /\ lossValue' = "none"
  /\ returnPresent' = FALSE /\ returnValue' = "none" /\ stopActive' = 0`,
  LocalDrainedBeforeReturn: String.raw`  /\ pc' = "done" /\ active' = 1 /\ stopped' = TRUE
  /\ fatalPresent' = FALSE /\ lossPresent' = FALSE /\ lossValue' = "none"
  /\ returnPresent' = FALSE /\ returnValue' = "none" /\ stopActive' = 1`,
  LocalNoFatalBackoff: String.raw`  /\ pc' = "backoff" /\ active' = 0 /\ stopped' = FALSE
  /\ fatalPresent' = TRUE /\ lossPresent' = TRUE /\ lossValue' = "errorA"
  /\ returnPresent' = FALSE /\ returnValue' = "none" /\ stopActive' = 0`,
  LocalFatalReturnPreserves: String.raw`  /\ pc' = "done" /\ active' = 0 /\ stopped' = FALSE
  /\ fatalPresent' = TRUE /\ lossPresent' = TRUE /\ lossValue' = "errorA"
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
  SuccessReceiptCurrent: String.raw`  /\ phase' = "succeeded" /\ fence' = 1 /\ exports' = {1}
  /\ effects' = {} /\ receiptFence' = 0 /\ lastRejectedFence' = 0 /\ reply' = "settled"`,
  EffectsRequireExport: String.raw`  /\ phase' = "available" /\ fence' = 0 /\ exports' = {}
  /\ effects' = {1} /\ receiptFence' = 0 /\ lastRejectedFence' = 0 /\ reply' = "effect"`,
  RejectedFenceIsStale: String.raw`  /\ phase' = "available" /\ fence' = 1 /\ exports' = {1}
  /\ effects' = {} /\ receiptFence' = 0 /\ lastRejectedFence' = 1 /\ reply' = "stale"`,
  UnknownAckIsDurable: String.raw`  /\ phase' = "available" /\ fence' = 1 /\ exports' = {1}
  /\ effects' = {} /\ receiptFence' = 0 /\ lastRejectedFence' = 0 /\ reply' = "unknown"`,
};

const policyMutants = {
  PolicyTypeOK: String.raw`  /\ pc' = "invalid"
  /\ UNCHANGED <<phase, revision, snapRevision, fence, receiptFence, receipt,
                 snapReceiptFence, snapReceipt, faultRevision, faultPhase,
                 faultReceiptFence, faultReceipt, submission, reply>>`,
  StalePolicyCannotPublish: String.raw`  /\ pc' = "done" /\ phase' = "running"
  /\ revision' = 1 /\ snapRevision' = 1 /\ fence' = 1
  /\ receiptFence' = 1 /\ receipt' = "implicit"
  /\ snapReceiptFence' = 0 /\ snapReceipt' = "none"
  /\ faultRevision' = 0 /\ faultPhase' = "none"
  /\ faultReceiptFence' = 0 /\ faultReceipt' = "none"
  /\ submission' = "implicit" /\ reply' = "stale"`,
  PolicyFailureNoWrite: String.raw`  /\ pc' = "done" /\ phase' = "waiting"
  /\ revision' = 2 /\ snapRevision' = 1 /\ fence' = 1
  /\ receiptFence' = 1 /\ receipt' = "implicit"
  /\ snapReceiptFence' = 0 /\ snapReceipt' = "none"
  /\ faultRevision' = 1 /\ faultPhase' = "running"
  /\ faultReceiptFence' = 0 /\ faultReceipt' = "none"
  /\ submission' = "none" /\ reply' = "callbackError"`,
  ReceiptIdentityControlsReplay: String.raw`  /\ pc' = "running" /\ phase' = "running"
  /\ revision' = 1 /\ snapRevision' = 0 /\ fence' = 1
  /\ receiptFence' = 1 /\ receipt' = "implicit"
  /\ snapReceiptFence' = 0 /\ snapReceipt' = "none"
  /\ faultRevision' = 0 /\ faultPhase' = "none"
  /\ faultReceiptFence' = 0 /\ faultReceipt' = "none"
  /\ submission' = "explicit" /\ reply' = "replay"`,
  ReceiptFenceTracksPublishedAttempt: String.raw`  /\ pc' = "waiting" /\ phase' = "waiting"
  /\ revision' = 3 /\ snapRevision' = 1 /\ fence' = 2
  /\ receiptFence' = 1 /\ receipt' = "implicit"
  /\ snapReceiptFence' = 0 /\ snapReceipt' = "none"
  /\ faultRevision' = 0 /\ faultPhase' = "none"
  /\ faultReceiptFence' = 0 /\ faultReceipt' = "none"
  /\ submission' = "none" /\ reply' = "none"`,
  SupersededReceiptRejectsOld: String.raw`  /\ pc' = "waiting" /\ phase' = "waiting"
  /\ revision' = 2 /\ snapRevision' = 1 /\ fence' = 1
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
const externalMutationPlan = mutationCoveragePlan('formal/WorkOnceExternal.cfg', externalMutants);
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

  const sampleMutant = resolve(tlcWorkspace, 'WorkOnceRuntimeSamplesMutant.tla');
  const sampleMutantConfig = resolve(tlcWorkspace, 'WorkOnceRuntimeSamplesMutant.cfg');
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

  const readFenceMutant = resolve(tlcWorkspace, 'WorkOnceRuntimeReadFenceMutant.tla');
  const readFenceMutantConfig = resolve(tlcWorkspace, 'WorkOnceRuntimeReadFenceMutant.cfg');
  writeFileSync(
    readFenceMutant,
    String.raw`---- MODULE WorkOnceRuntimeReadFenceMutant ----
EXTENDS WorkOnceRuntimeObserved
BadRead == [kind |-> "read", matched |-> FALSE, accepted |-> TRUE,
            definitionError |-> FALSE, snapshotExact |-> FALSE, errorCause |-> "none"]
BadSamples == ObservedSamples \cup {BadRead}
MutantSpec == Init /\ [][Next]_vars
====
`,
  );
  writeFileSync(
    readFenceMutantConfig,
    singleInvariantConfig(runtimeConfig, 'RuntimeSamplesConform').replace(
      'CONSTANT Samples <- ObservedSamples',
      'CONSTANT Samples <- BadSamples',
    ),
  );
  requireInvariantRejects(
    'WorkOnceRuntimeReadFenceMutant',
    readFenceMutantConfig,
    readFenceMutant,
    'RuntimeSamplesConform',
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
  /\ UNCHANGED <<fatalPresent, failureKind, failureValue, aborted, result, returnValue, stopActive>>
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
    `---- MODULE WorkOnceReadHistoryObserved ----\nEXTENDS WorkOnceReadHistory\nObservedSamples == {\n${readHistorySamples.map(tlaValue).join(',\n')}\n}\n====\n`,
  );
  writeFileSync(
    readHistoryConfig,
    `${readFileSync('formal/WorkOnceReadHistory.cfg', 'utf8').replace(
      'CONSTANT Samples = {}',
      'CONSTANT Samples <- ObservedSamples',
    )}\nINVARIANT ReadHistorySamplesConform\n`,
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

  const readHistorySampleMutant = resolve(tlcWorkspace, 'WorkOnceReadHistorySamplesMutant.tla');
  const readHistorySampleMutantConfig = resolve(
    tlcWorkspace,
    'WorkOnceReadHistorySamplesMutant.cfg',
  );
  writeFileSync(
    readHistorySampleMutant,
    String.raw`---- MODULE WorkOnceReadHistorySamplesMutant ----
EXTENDS WorkOnceReadHistoryObserved
BadSamples == ObservedSamples \cup {[kind |-> "invalid"]}
MutantSpec == Init /\ [][Next]_vars
====
`,
  );
  writeFileSync(
    readHistorySampleMutantConfig,
    singleInvariantConfig(
      readFileSync(readHistoryConfig, 'utf8'),
      'ReadHistorySamplesConform',
    ).replace('CONSTANT Samples <- ObservedSamples', 'CONSTANT Samples <- BadSamples'),
  );
  requireInvariantRejects(
    'WorkOnceReadHistorySamplesMutant',
    readHistorySampleMutantConfig,
    readHistorySampleMutant,
    'ReadHistorySamplesConform',
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
    `---- MODULE WorkOnceLocalRunnerObserved ----\nEXTENDS WorkOnceLocalRunner\nObservedSamples == {\n${localRunnerSamples.map(tlaValue).join(',\n')}\n}\n====\n`,
  );
  writeFileSync(
    localRunnerConfig,
    `${readFileSync('formal/WorkOnceLocalRunner.cfg', 'utf8').replace(
      'CONSTANT Samples = {}',
      'CONSTANT Samples <- ObservedSamples',
    )}\nINVARIANT LocalRunnerSamplesConform\n`,
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

  const localRunnerSampleMutant = resolve(tlcWorkspace, 'WorkOnceLocalRunnerSamplesMutant.tla');
  const localRunnerSampleMutantConfig = resolve(
    tlcWorkspace,
    'WorkOnceLocalRunnerSamplesMutant.cfg',
  );
  writeFileSync(
    localRunnerSampleMutant,
    String.raw`---- MODULE WorkOnceLocalRunnerSamplesMutant ----
EXTENDS WorkOnceLocalRunnerObserved
BadSamples == ObservedSamples \cup {[kind |-> "invalid"]}
MutantSpec == Init /\ [][Next]_vars
====
`,
  );
  writeFileSync(
    localRunnerSampleMutantConfig,
    singleInvariantConfig(
      readFileSync(localRunnerConfig, 'utf8'),
      'LocalRunnerSamplesConform',
    ).replace('CONSTANT Samples <- ObservedSamples', 'CONSTANT Samples <- BadSamples'),
  );
  requireInvariantRejects(
    'WorkOnceLocalRunnerSamplesMutant',
    localRunnerSampleMutantConfig,
    localRunnerSampleMutant,
    'LocalRunnerSamplesConform',
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
    `---- MODULE WorkOncePolicyObserved ----\nEXTENDS WorkOncePolicy\nObservedSamples == {\n${policySamples.map(tlaValue).join(',\n')}\n}\n====\n`,
  );
  writeFileSync(
    policyConfig,
    `${readFileSync('formal/WorkOncePolicy.cfg', 'utf8').replace(
      'CONSTANT Samples = {}',
      'CONSTANT Samples <- ObservedSamples',
    )}\nINVARIANT PolicySamplesConform\n`,
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

  const policySampleMutant = resolve(tlcWorkspace, 'WorkOncePolicySamplesMutant.tla');
  const policySampleMutantConfig = resolve(tlcWorkspace, 'WorkOncePolicySamplesMutant.cfg');
  writeFileSync(
    policySampleMutant,
    String.raw`---- MODULE WorkOncePolicySamplesMutant ----
EXTENDS WorkOncePolicyObserved
BadSamples == ObservedSamples \cup {[kind |-> "invalid"]}
MutantSpec == Init /\ [][Next]_vars
====
`,
  );
  writeFileSync(
    policySampleMutantConfig,
    singleInvariantConfig(readFileSync(policyConfig, 'utf8'), 'PolicySamplesConform').replace(
      'CONSTANT Samples <- ObservedSamples',
      'CONSTANT Samples <- BadSamples',
    ),
  );
  requireInvariantRejects(
    'WorkOncePolicySamplesMutant',
    policySampleMutantConfig,
    policySampleMutant,
    'PolicySamplesConform',
  );
}

if (nonRuntimeOnly) {
  const { runOutboxRefinementSamples, assertOutboxRefinementSamples } = await import(
    './outbox-refinement.mjs'
  );
  runModel('WorkOnceOutbox', 'WorkOnceOutbox.cfg');
  runModel('WorkOnceOutboxBudget', 'WorkOnceOutboxBudget.cfg');
  const outboxSamples = await runOutboxRefinementSamples();
  assertOutboxRefinementSamples(outboxSamples);
  const outboxObserved = resolve(tlcWorkspace, 'WorkOnceOutboxObserved.tla');
  const outboxConfig = resolve(tlcWorkspace, 'WorkOnceOutbox-observed.cfg');
  writeFileSync(
    outboxObserved,
    `---- MODULE WorkOnceOutboxObserved ----\nEXTENDS WorkOnceOutbox\nCONSTANT Samples\nObservedSamples == {\n${outboxSamples.map(tlaValue).join(',\n')}\n}\nOutboxSamplesConform ==\n  /\\ Samples # {}\n  /\\ {s.kind : s \\in Samples} = {"rotation", "poison", "restart", "ackLoss", "casAckLoss", "adapter", "adapterBudget", "adapterFaults", "adapterConcurrent", "budget", "grid", "multiPoison", "dynamic", "finiteArrivals", "concurrent", "limitBoundary", "staleParent", "rotationFailure", "multiError", "runDispatcher", "historyCongruence", "historySplit"}\n  /\\ \\A s \\in Samples : OutboxSampleOK(s)\n====\n`,
  );
  writeFileSync(
    outboxConfig,
    `${readFileSync('formal/WorkOnceOutbox.cfg', 'utf8')}\nCONSTANT Samples <- ObservedSamples\nINVARIANT OutboxSamplesConform\n`,
  );
  console.log(
    `TLC outbox model receives ${outboxSamples.length} fresh compiled scheduler observations.`,
  );
  runModel('WorkOnceOutboxObserved', outboxConfig, outboxObserved);

  const sampleMutant = resolve(tlcWorkspace, 'WorkOnceOutboxSamplesMutant.tla');
  const sampleMutantConfig = resolve(tlcWorkspace, 'WorkOnceOutboxSamplesMutant.cfg');
  writeFileSync(
    sampleMutant,
    String.raw`---- MODULE WorkOnceOutboxSamplesMutant ----
EXTENDS WorkOnceOutboxObserved
BadSamples == ObservedSamples \cup {[kind |-> "invalid"]}
====
`,
  );
  writeFileSync(
    sampleMutantConfig,
    readFileSync(outboxConfig, 'utf8').replace(
      'CONSTANT Samples <- ObservedSamples',
      'CONSTANT Samples <- BadSamples',
    ),
  );
  requireInvariantRejects(
    'WorkOnceOutboxSamplesMutant',
    sampleMutantConfig,
    sampleMutant,
    'OutboxSamplesConform',
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
  for (const mutant of semanticMutants) {
    const modulePath = resolve(tlcWorkspace, `${mutant.name}.tla`);
    const configPath = resolve(tlcWorkspace, `${mutant.name}.cfg`);
    writeFileSync(
      modulePath,
      `---- MODULE ${mutant.name} ----\nEXTENDS WorkOnceOutbox\nUnsafe ==\n${mutant.action}\nMutantNext == Next \\/ Unsafe\nMutantSpec == Init /\\ [][MutantNext]_vars\n====\n`,
    );
    writeFileSync(
      configPath,
      singleInvariantConfig(readFileSync('formal/WorkOnceOutbox.cfg', 'utf8'), mutant.invariant),
    );
    requireInvariantRejects(mutant.name, configPath, modulePath, mutant.invariant);
    markExtraMutationWitness(outboxMutationPlan, mutant.invariant);
  }
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
    `---- MODULE WorkOnceExternalObserved ----\nEXTENDS WorkOnceExternal\nObservedSamples == {\n${externalSamples.map(tlaValue).join(',\n')}\n}\n====\n`,
  );
  writeFileSync(
    externalConfig,
    `${readFileSync('formal/WorkOnceExternal.cfg', 'utf8').replace(
      'CONSTANT Samples = {}',
      'CONSTANT Samples <- ObservedSamples',
    )}\nINVARIANT ExternalSamplesConform\n`,
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

  const externalSampleMutant = resolve(tlcWorkspace, 'WorkOnceExternalSamplesMutant.tla');
  const externalSampleMutantConfig = resolve(tlcWorkspace, 'WorkOnceExternalSamplesMutant.cfg');
  writeFileSync(
    externalSampleMutant,
    String.raw`---- MODULE WorkOnceExternalSamplesMutant ----
EXTENDS WorkOnceExternalObserved
BadSamples == ObservedSamples \cup {[kind |-> "invalid"]}
MutantSpec == Init /\ [][Next]_vars
====
`,
  );
  writeFileSync(
    externalSampleMutantConfig,
    singleInvariantConfig(readFileSync(externalConfig, 'utf8'), 'ExternalSamplesConform').replace(
      'CONSTANT Samples <- ObservedSamples',
      'CONSTANT Samples <- BadSamples',
    ),
  );
  requireInvariantRejects(
    'WorkOnceExternalSamplesMutant',
    externalSampleMutantConfig,
    externalSampleMutant,
    'ExternalSamplesConform',
  );

  const duplicateBoundaryModule = resolve(tlcWorkspace, 'WorkOnceExternalDuplicateBoundary.tla');
  const duplicateBoundaryConfig = resolve(tlcWorkspace, 'WorkOnceExternalDuplicateBoundary.cfg');
  writeFileSync(
    duplicateBoundaryModule,
    String.raw`---- MODULE WorkOnceExternalDuplicateBoundary ----
EXTENDS WorkOnceExternalObserved
MutantSpec == Spec
====
`,
  );
  writeFileSync(
    duplicateBoundaryConfig,
    singleInvariantConfig(readFileSync(externalConfig, 'utf8'), 'NoDuplicateExternalEffects'),
  );
  requireInvariantRejects(
    'WorkOnceExternalDuplicateBoundary',
    duplicateBoundaryConfig,
    duplicateBoundaryModule,
    'NoDuplicateExternalEffects',
  );
  console.log(
    'TLC external boundary witness confirms duplicate external effects are reachable across crash/reclaim; exactly-once is not claimed.',
  );
}

assertMutationPlansExecuted(
  runtimeOnly
    ? [runtimeMutationPlan, readHistoryMutationPlan, localRunnerMutationPlan, externalMutationPlan]
    : [lifecycleMutationPlan, policyMutationPlan, outboxMutationPlan, outboxBudgetMutationPlan],
);
