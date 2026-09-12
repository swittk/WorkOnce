const invariantPatterns = [
  /Invariant\s+([A-Za-z_][A-Za-z0-9_]*)\s+is violated/gu,
  /invariant of\s+([A-Za-z_][A-Za-z0-9_]*)\s+is equal to FALSE/giu,
];

function combinedOutput(result) {
  return `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
}

function observedInvariants(output) {
  const names = new Set();
  for (const pattern of invariantPatterns) {
    pattern.lastIndex = 0;
    for (const match of output.matchAll(pattern)) names.add(match[1]);
  }
  return [...names].sort();
}

function infrastructureReason(result, output) {
  if (result?.error?.code === 'ETIMEDOUT') return 'timeout';
  if (result?.error) return 'spawn_error';
  if (result?.signal) return 'signal';
  if (result?.status === null || result?.status === undefined) return 'missing_exit_status';
  if (/OutOfMemoryError|Java heap space|GC overhead limit exceeded/iu.test(output))
    return 'jvm_out_of_memory';
  if (
    /Could not find or load main class|ClassNotFoundException|Unable to access jarfile/iu.test(
      output,
    )
  )
    return 'jvm_or_classpath';
  if (/Exception in thread|java\.lang\.|tla2sany\.|util\.Assert/u.test(output))
    return 'tool_exception';
  if (/parse error|semantic error|Parsing file.*failed|TLC encountered an error/iu.test(output))
    return 'model_or_tool_error';
  return 'unclassified_nonzero_exit';
}

/**
 * Classify a TLC child-process result without treating arbitrary non-zero exits as counterexamples.
 * Unknown failures fail closed as infrastructure/tool failures. Only explicit TLC safety/liveness
 * diagnostics count as semantic counterexamples.
 */
export function classifyTlcOutcome(result) {
  const output = combinedOutput(result);
  const invariants = observedInvariants(output);

  if (result?.error || result?.signal || result?.status === null || result?.status === undefined) {
    return {
      kind: 'infrastructure_failure',
      reason: infrastructureReason(result, output),
      invariants,
      output,
    };
  }

  const infrastructure = infrastructureReason(result, output);
  if (infrastructure !== 'unclassified_nonzero_exit') {
    return {
      kind: 'infrastructure_failure',
      reason: infrastructure,
      invariants,
      output,
    };
  }

  if (invariants.length > 0) {
    return { kind: 'semantic_counterexample', reason: 'invariant_violation', invariants, output };
  }
  if (/Temporal properties were violated|The temporal property .* is violated/iu.test(output)) {
    return {
      kind: 'semantic_counterexample',
      reason: 'temporal_property_violation',
      invariants,
      output,
    };
  }
  if (/Deadlock reached\.|Error: Deadlock reached/iu.test(output)) {
    return { kind: 'semantic_counterexample', reason: 'deadlock', invariants, output };
  }
  if (result.status === 0) return { kind: 'success', invariants, output };

  return {
    kind: 'infrastructure_failure',
    reason: infrastructure,
    invariants,
    output,
  };
}

/** Require a named mutation witness to fail for that exact invariant, not for an unrelated reason. */
export function requireExpectedInvariantViolation(result, expectedInvariant) {
  const outcome = classifyTlcOutcome(result);
  if (
    outcome.kind === 'semantic_counterexample' &&
    outcome.reason === 'invariant_violation' &&
    outcome.invariants.includes(expectedInvariant)
  ) {
    return outcome;
  }
  if (outcome.kind === 'infrastructure_failure') {
    throw new Error(
      `TLC infrastructure failure while expecting invariant ${expectedInvariant}: ${outcome.reason}\n${outcome.output.slice(-2000)}`,
    );
  }
  if (outcome.kind === 'success') {
    throw new Error(`TLC mutation did not violate expected invariant ${expectedInvariant}.`);
  }
  throw new Error(
    `TLC mutation violated the wrong semantic property while expecting ${expectedInvariant}: ${outcome.invariants.join(',') || outcome.reason}\n${outcome.output.slice(-2000)}`,
  );
}
