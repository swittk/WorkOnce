const mutatingScript = /(?:^|\/)scripts\/[A-Za-z0-9._/-]*mutation[A-Za-z0-9._/-]*\.mjs$/u;
const explicitMutatingEntries = new Set(['test/lifecycle-proof-controls.test.mjs']);

/** Reject source/dist-mutating assurance entry points after aliases and computed args are resolved. */
export function assertParallelEntriesReadOnly(entries) {
  const mutating = [];
  for (const [label, , args] of entries) {
    for (const arg of args) {
      if (typeof arg !== 'string') continue;
      if (mutatingScript.test(arg) || explicitMutatingEntries.has(arg))
        mutating.push(`${label}: ${arg}`);
    }
  }
  if (mutating.length > 0)
    throw new Error(
      `Source/dist-mutating assurance guards must not run in runParallel: ${mutating.join(', ')}`,
    );
}
