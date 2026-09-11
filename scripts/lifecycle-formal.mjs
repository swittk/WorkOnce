import { availableParallelism } from 'node:os';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { assertBuildSourceBinding } from './build-source-binding.mjs';
import {
  assertLifecycleRefinementSamples,
  runLifecycleRefinementSamples,
} from './lifecycle-refinement.mjs';
import { classifyTlcOutcome } from './tlc-outcome.mjs';
import { acquireTlcWorkspace, cleanupTlcWorkspaceOnSuccess } from './tlc-workspace.mjs';

assertBuildSourceBinding();
const jar = resolve(process.env.TLA2TOOLS_JAR ?? '.artifacts/tla2tools.jar');
if (!existsSync(jar)) throw new Error('Missing official tla2tools.jar');
const tlcWorkspace = acquireTlcWorkspace('lifecycle-formal');
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

function tlcArgs(model, config, modulePath, heap = 384) {
  return [
    `-Xmx${heap}m`,
    '-XX:+UseParallelGC',
    `-Djava.io.tmpdir=${javaTmp}`,
    `-DTLA-Library=${[resolve('formal'), tlcWorkspace].join(delimiter)}`,
    '-cp',
    jar,
    'tlc2.TLC',
    '-workers',
    workers,
    '-metadir',
    resolve(tlcWorkspace, model),
    '-config',
    config,
    modulePath,
  ];
}

function runModel(model, config, modulePath = `${model}.tla`, heap = 384) {
  mkdirSync(resolve(tlcWorkspace, model), { recursive: true });
  const result = spawnSync('java', tlcArgs(model, config, modulePath, heap), {
    cwd: 'formal',
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  const outcome = classifyTlcOutcome(result);
  if (outcome.kind !== 'success') {
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    const reason = outcome.reason ?? outcome.kind;
    throw new Error(`TLC ${model} failed: ${reason}\n${outcome.output.slice(-2000)}`);
  }
}

function configuredInvariants(configText) {
  const result = [];
  let reading = false;
  for (const line of configText.replace(/\r\n?/gu, '\n').split('\n')) {
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
    'Lifecycle configured-invariant parser must preserve single and blank-separated forms',
  );

const mutationWitnessInvariants = [
  'INVARIANT MutationWitnesses',
  'INVARIANT MutationBranchesEnabled',
];

function mutationWitnessConfig(configText) {
  const output = [];
  let skipping = false;
  let inserted = false;
  let specSwapped = false;
  for (const line of configText.replace(/\r\n?/gu, '\n').split('\n')) {
    const trimmed = line.trim();
    if (/^INVARIANT\s+[A-Za-z_][A-Za-z0-9_]*$/u.test(trimmed)) continue;
    if (trimmed === 'INVARIANTS') {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (/^\s+[A-Za-z_][A-Za-z0-9_]*\s*$/u.test(line) || trimmed === '') continue;
      skipping = false;
    }
    if (trimmed === 'SPECIFICATION Spec') {
      output.push('SPECIFICATION BatchSpec');
      specSwapped = true;
      continue;
    }
    if (line.trim() === 'CHECK_DEADLOCK FALSE' && !inserted) {
      output.push(...mutationWitnessInvariants);
      inserted = true;
    }
    output.push(line);
  }
  if (!inserted) output.push(...mutationWitnessInvariants);
  if (!specSwapped)
    throw new Error('Mutation witness config found no "SPECIFICATION Spec" line to rebind');
  return `${output.join('\n').trimEnd()}\n`;
}

function runMutationWitnessBatch({ model, baseModule, configPath, mutants }) {
  const configured = configuredInvariants(readFileSync(configPath, 'utf8')).sort();
  const guarded = Object.keys(mutants).sort();
  if (JSON.stringify(configured) !== JSON.stringify(guarded))
    throw new Error(
      `Lifecycle mutation coverage drifted for ${configPath}: configured=${configured.join(',')} guarded=${guarded.join(',')}`,
    );
  const mutationEntries = Object.entries(mutants);
  const branchDefinitions = mutationEntries
    .map(([invariant, body]) => {
      const indented = body
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n');
      return String.raw`Mutant_${invariant} ==
  /\ mutantId = "none"
${indented}
  /\ mutantId' = ${JSON.stringify(invariant)}`;
    })
    .join('\n\n');
  const branches = mutationEntries
    .map(([invariant]) => String.raw`  \/ Mutant_${invariant}`)
    .join('\n');
  const enabledBranches = mutationEntries
    .map(([invariant]) => String.raw`    /\ ENABLED Mutant_${invariant}`)
    .join('\n');
  const witnesses = Object.keys(mutants)
    .map((invariant) => `  \\/ /\\ mutantId = ${JSON.stringify(invariant)} /\\ ~${invariant}`)
    .join('\n');
  const modulePath = resolve(tlcWorkspace, `${model}.tla`);
  const mutantConfig = resolve(tlcWorkspace, `${model}.cfg`);
  writeFileSync(
    modulePath,
    `---- MODULE ${model} ----\nEXTENDS ${baseModule}\nVARIABLE mutantId\nbatchVars == <<vars, mutantId>>\nBatchInit == /\\ Init /\\ mutantId = "none"\n${branchDefinitions}\nUnsafe ==\n${branches}\nBatchNext == Unsafe\nMutationWitnesses ==\n  \\/ mutantId = "none"\n${witnesses}\nMutationBranchesEnabled ==\n  \\/ mutantId # "none"\n  \\/ /\\ mutantId = "none"\n${enabledBranches}\nBatchSpec == BatchInit /\\ [][BatchNext]_batchVars\n====\n`,
  );
  writeFileSync(mutantConfig, mutationWitnessConfig(readFileSync(configPath, 'utf8')));
  runModel(model, mutantConfig, modulePath, 256);
  console.log(
    `Lifecycle TLC mutation witness batch proves ${guarded.length} configured invariants are non-vacuous for ${baseModule}.`,
  );
}

const temporalMutants = {
  LifecycleTemporalTypeOK: String.raw`  /\ phase' = "invalid"
  /\ UNCHANGED <<revision, generation, fence, receiptGeneration, receiptFence, receiptHash,
                 lastOp, lastResult, lastBeforeRevision, lastBeforePhase,
                 lastExpectedRevision, lastRefGeneration, lastRefFence, lastHash>>`,
  AcceptedWakeUsesCurrentRevision: String.raw`  /\ lastOp' = "wake" /\ lastResult' = "ok"
  /\ lastBeforeRevision' = 1 /\ lastExpectedRevision' = 2 /\ revision' = 2
  /\ UNCHANGED <<phase, generation, fence, receiptGeneration, receiptFence, receiptHash,
                 lastBeforePhase, lastRefGeneration, lastRefFence, lastHash>>`,
  AcceptedDeferProducesWaiting: String.raw`  /\ lastOp' = "defer" /\ lastResult' = "ok"
  /\ lastBeforeRevision' = 1 /\ lastBeforePhase' = "running" /\ revision' = 2 /\ phase' = "running"
  /\ UNCHANGED <<generation, fence, receiptGeneration, receiptFence, receiptHash,
                 lastExpectedRevision, lastRefGeneration, lastRefFence, lastHash>>`,
  RejectedWakeDoesNotWrite: String.raw`  /\ lastOp' = "wake" /\ lastResult' = "generation_conflict"
  /\ lastBeforeRevision' = 1 /\ revision' = 2 /\ phase' = "queued"
  /\ lastBeforePhase' = "queued" /\ lastExpectedRevision' = 2
  /\ UNCHANGED <<generation, fence, receiptGeneration, receiptFence, receiptHash,
                 lastRefGeneration, lastRefFence, lastHash>>`,
  TerminalCancelDoesNotWrite: String.raw`  /\ lastOp' = "cancel_terminal" /\ lastResult' = "ok"
  /\ lastBeforeRevision' = 1 /\ revision' = 2 /\ lastBeforePhase' = "queued" /\ phase' = "succeeded"
  /\ UNCHANGED <<generation, fence, receiptGeneration, receiptFence, receiptHash,
                 lastExpectedRevision, lastRefGeneration, lastRefFence, lastHash>>`,
  ResetClearsReceipt: String.raw`  /\ lastOp' = "reset" /\ lastResult' = "ok"
  /\ receiptGeneration' = 1 /\ receiptFence' = 1 /\ receiptHash' = "h1"
  /\ UNCHANGED <<phase, revision, generation, fence, lastBeforeRevision, lastBeforePhase,
                 lastExpectedRevision, lastRefGeneration, lastRefFence, lastHash>>`,
  ReceiptBelongsToCurrentGeneration: String.raw`  /\ generation' = 1 /\ fence' = 1
  /\ receiptGeneration' = 2 /\ receiptFence' = 1 /\ receiptHash' = "h1"
  /\ UNCHANGED <<phase, revision, lastOp, lastResult, lastBeforeRevision, lastBeforePhase,
                 lastExpectedRevision, lastRefGeneration, lastRefFence, lastHash>>`,
  ReplayUsesReceiptIdentity: String.raw`  /\ lastOp' = "replay" /\ lastResult' = "replay"
  /\ generation' = 1 /\ fence' = 1 /\ receiptGeneration' = 1 /\ receiptFence' = 1
  /\ receiptHash' = "h1" /\ lastRefGeneration' = 1 /\ lastRefFence' = 1 /\ lastHash' = "h2"
  /\ UNCHANGED <<phase, revision, lastBeforeRevision, lastBeforePhase, lastExpectedRevision>>`,
};

const scanMutants = {
  ClaimScanTypeOK: String.raw`  /\ pc' = "invalid"
  /\ UNCHANGED <<pass, frontRemaining, healthyRemaining, pageFront, pageHealthy,
                 claimedThisPass, healthyClaimed, exhaustedTerminalized>>`,
  ClaimLimitHonored: String.raw`  /\ claimedThisPass' = ClaimLimit + 1
  /\ UNCHANGED <<pc, pass, frontRemaining, healthyRemaining, pageFront, pageHealthy,
                 healthyClaimed, exhaustedTerminalized>>`,
  NoHealthyLoss: String.raw`  /\ healthyRemaining' = 0 /\ healthyClaimed' = 0
  /\ UNCHANGED <<pc, pass, frontRemaining, pageFront, pageHealthy,
                 claimedThisPass, exhaustedTerminalized>>`,
  NoExhaustedLoss: String.raw`  /\ frontRemaining' = 0 /\ exhaustedTerminalized' = 0
  /\ UNCHANGED <<pc, pass, healthyRemaining, pageFront, pageHealthy,
                 claimedThisPass, healthyClaimed>>`,
  FirstBoundedPassOnlyTerminalizesFront: String.raw`  /\ pass' = 1 /\ frontRemaining' = 1
  /\ UNCHANGED <<pc, healthyRemaining, pageFront, pageHealthy,
                 claimedThisPass, healthyClaimed, exhaustedTerminalized>>`,
  SecondInvocationReachesHealthy: String.raw`  /\ pass' = 2 /\ healthyClaimed' = 0
  /\ UNCHANGED <<pc, frontRemaining, healthyRemaining, pageFront, pageHealthy,
                 claimedThisPass, exhaustedTerminalized>>`,
};

function tlaValue(value) {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return `[${Object.entries(value)
      .map(([key, item]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
          throw new Error('Invalid lifecycle observation field');
        return `${key} |-> ${tlaValue(item)}`;
      })
      .join(', ')}]`;
  }
  throw new Error('Unrepresentable lifecycle observation');
}

runModel('WorkOnceLifecycleTemporal', 'WorkOnceLifecycleTemporal.cfg');
runMutationWitnessBatch({
  model: 'WorkOnceLifecycleTemporalMutationBatch',
  baseModule: 'WorkOnceLifecycleTemporal',
  configPath: 'formal/WorkOnceLifecycleTemporal.cfg',
  mutants: temporalMutants,
});
runModel('WorkOnceClaimScan', 'WorkOnceClaimScan.cfg', 'WorkOnceClaimScan.tla', 256);
runMutationWitnessBatch({
  model: 'WorkOnceClaimScanMutationBatch',
  baseModule: 'WorkOnceClaimScan',
  configPath: 'formal/WorkOnceClaimScan.cfg',
  mutants: scanMutants,
});

const samples = await runLifecycleRefinementSamples();
assertLifecycleRefinementSamples(samples);
const lifecycleAdapterDomainMutationKinds = [
  ['claimScanContinuation', 'ClaimScanContinuationMissingAdapterSamples'],
  ['stolenPageContinuation', 'StolenPageContinuationMissingAdapterSamples'],
  ['claimLimit', 'ClaimLimitMissingAdapterSamples'],
  ['finiteClaimDrain', 'FiniteClaimDrainMissingAdapterSamples'],
];
const lifecycleAdapterDomainMutants = lifecycleAdapterDomainMutationKinds.map(([kind, name]) => {
  const matching = samples.filter((sample) => sample.kind === kind);
  const adapters = matching.map((sample) => sample.adapter).sort();
  if (JSON.stringify(adapters) !== JSON.stringify(['cas', 'memory', 'sqlite']))
    throw new Error(`Lifecycle adapter-domain mutation source drifted for ${kind}`);
  return { kind, name };
});
const observedModule = resolve(tlcWorkspace, 'WorkOnceLifecycleObserved.tla');
const observedConfig = resolve(tlcWorkspace, 'WorkOnceLifecycleObserved.cfg');
writeFileSync(
  observedModule,
  `---- MODULE WorkOnceLifecycleObserved ----\nEXTENDS WorkOnceLifecycleContract\nObservedSamples == {\n${samples.map(tlaValue).join(',\n')}\n}\nBadSamples == ObservedSamples \\cup {[kind |-> \"invalid\"]}\nBadFieldSamples == ObservedSamples \\cup {[kind |-> \"leaseFenceCause\", exactBoundaryExpired |-> FALSE, reclaimedFence |-> TRUE, staleRenewCause |-> TRUE, staleSettleCause |-> TRUE]}\n${lifecycleAdapterDomainMutants.map(({ kind, name }) => `${name} == {s \\in ObservedSamples : ~(s.kind = ${JSON.stringify(kind)} /\\ s.adapter = \"cas\")}`).join('\n')}\nVARIABLE dummy\nvars == <<dummy>>\nInit == dummy = 0\nNext == UNCHANGED dummy\nSpec == Init /\\ [][Next]_vars\nLifecycleSamplesObserved == LifecycleSamplesConform(ObservedSamples)\nLifecycleNegativeSampleMutantsRejected == /\\ ~LifecycleSamplesConform(BadSamples) /\\ ~LifecycleSamplesConform(BadFieldSamples)\nLifecycleAdapterDomainMutantsRejected ==\n${lifecycleAdapterDomainMutants.map(({ name }) => `  /\\ ~LifecycleSamplesConform(${name})`).join('\n')}\n====\n`,
);
writeFileSync(
  observedConfig,
  'SPECIFICATION Spec\nINVARIANT LifecycleSamplesObserved\nINVARIANT LifecycleNegativeSampleMutantsRejected\nINVARIANT LifecycleAdapterDomainMutantsRejected\nCHECK_DEADLOCK FALSE\n',
);
console.log(
  `TLC lifecycle boundary receives ${samples.length} fresh compiled implementation observations.`,
);
runModel('WorkOnceLifecycleObserved', observedConfig, observedModule, 256);

console.log(
  'Lifecycle sample mutation guards reject invalid-kind, false-field and missing-adapter witnesses in the observed-model TLC run.',
);

console.log('Lifecycle temporal, claim-scan, observation and mutation gates passed.');
