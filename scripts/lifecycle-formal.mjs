import { availableParallelism } from 'node:os';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { assertBuildSourceBinding } from './build-source-binding.mjs';
import {
  assertLifecycleRefinementSamples,
  runLifecycleRefinementSamples,
} from './lifecycle-refinement.mjs';

assertBuildSourceBinding();
const jar = resolve(process.env.TLA2TOOLS_JAR ?? '.artifacts/tla2tools.jar');
if (!existsSync(jar)) throw new Error('Missing official tla2tools.jar');
mkdirSync('.artifacts/tlc', { recursive: true });
const workers = String(Math.max(2, Math.min(8, availableParallelism())));
const timeoutMs = 30_000;

function tlcArgs(model, config, modulePath, heap = 384) {
  return [
    `-Xmx${heap}m`,
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

function runModel(model, config, modulePath = `${model}.tla`, heap = 384) {
  mkdirSync(resolve('.artifacts/tlc', model), { recursive: true });
  const result = spawnSync('java', tlcArgs(model, config, modulePath, heap), {
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
  if (result.status !== 0) throw new Error(`TLC ${model} exited ${result.status}`);
}

function requireInvariantRejects(model, config, modulePath, invariant) {
  mkdirSync(resolve('.artifacts/tlc', model), { recursive: true });
  const result = spawnSync('java', tlcArgs(model, config, modulePath, 256), {
    cwd: 'formal',
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`TLC mutation check terminated by signal ${result.signal}`);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const semanticFailure =
    output.includes(`Invariant ${invariant} is violated`) ||
    output.includes(`The invariant of ${invariant} is equal to FALSE`);
  if (result.status === 0 || !semanticFailure)
    throw new Error(
      `Lifecycle formal mutant was not rejected by ${invariant}: ${output.slice(-2000)}`,
    );
  console.log(`Lifecycle sample mutation guard: ${invariant} rejects its intended counterexample.`);
}

function configuredInvariants(configText) {
  const result = [];
  let reading = false;
  for (const line of configText.replace(/\r\n?/gu, '\n').split('\n')) {
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

function mutationWitnessConfig(configText) {
  const output = [];
  let skipping = false;
  let inserted = false;
  for (const line of configText.replace(/\r\n?/gu, '\n').split('\n')) {
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

function runMutationWitnessBatch({ model, baseModule, configPath, mutants }) {
  const configured = configuredInvariants(readFileSync(configPath, 'utf8')).sort();
  const guarded = Object.keys(mutants).sort();
  if (JSON.stringify(configured) !== JSON.stringify(guarded))
    throw new Error(
      `Lifecycle mutation coverage drifted for ${configPath}: configured=${configured.join(',')} guarded=${guarded.join(',')}`,
    );
  const branches = Object.entries(mutants)
    .map(([invariant, body]) => {
      const indented = body
        .split('\n')
        .map((line) => `   ${line}`)
        .join('\n');
      return `  \\/ /\\ mutantId = "none"\n${indented}\n     /\\ mutantId' = ${JSON.stringify(invariant)}`;
    })
    .join('\n');
  const witnesses = Object.keys(mutants)
    .map((invariant) => `  \\/ /\\ mutantId = ${JSON.stringify(invariant)} /\\ ~${invariant}`)
    .join('\n');
  const modulePath = resolve(`.artifacts/tlc/${model}.tla`);
  const mutantConfig = resolve(`.artifacts/tlc/${model}.cfg`);
  writeFileSync(
    modulePath,
    `---- MODULE ${model} ----\nEXTENDS ${baseModule}\nVARIABLE mutantId\nbatchVars == <<vars, mutantId>>\nBatchInit == /\\ Init /\\ mutantId = "none"\nUnsafe ==\n${branches}\nBatchNext == Unsafe\nMutationWitnesses ==\n  \\/ mutantId = "none"\n${witnesses}\nBatchSpec == BatchInit /\\ [][BatchNext]_batchVars\n====\n`,
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
const observedModule = resolve('.artifacts/tlc/WorkOnceLifecycleObserved.tla');
const observedConfig = resolve('.artifacts/tlc/WorkOnceLifecycleObserved.cfg');
writeFileSync(
  observedModule,
  `---- MODULE WorkOnceLifecycleObserved ----\nEXTENDS WorkOnceLifecycleContract\nObservedSamples == {\n${samples.map(tlaValue).join(',\n')}\n}\nVARIABLE dummy\nvars == <<dummy>>\nInit == dummy = 0\nNext == UNCHANGED dummy\nSpec == Init /\\ [][Next]_vars\nLifecycleSamplesObserved == LifecycleSamplesConform(ObservedSamples)\n====\n`,
);
writeFileSync(
  observedConfig,
  'SPECIFICATION Spec\nINVARIANT LifecycleSamplesObserved\nCHECK_DEADLOCK FALSE\n',
);
console.log(
  `TLC lifecycle boundary receives ${samples.length} fresh compiled implementation observations.`,
);
runModel('WorkOnceLifecycleObserved', observedConfig, observedModule, 256);

const badModule = resolve('.artifacts/tlc/WorkOnceLifecycleSamplesMutant.tla');
const badConfig = resolve('.artifacts/tlc/WorkOnceLifecycleSamplesMutant.cfg');
writeFileSync(
  badModule,
  `---- MODULE WorkOnceLifecycleSamplesMutant ----\nEXTENDS WorkOnceLifecycleObserved\nBadSamples == ObservedSamples \\cup {[kind |-> "invalid"]}\nBadLifecycleSamplesObserved == LifecycleSamplesConform(BadSamples)\n====\n`,
);
writeFileSync(
  badConfig,
  'SPECIFICATION Spec\nINVARIANT BadLifecycleSamplesObserved\nCHECK_DEADLOCK FALSE\n',
);
requireInvariantRejects(
  'WorkOnceLifecycleSamplesMutant',
  badConfig,
  badModule,
  'BadLifecycleSamplesObserved',
);

console.log('Lifecycle temporal, claim-scan, observation and mutation gates passed.');
