import { setTimeout as sleep } from 'node:timers/promises';

export const refinementLivenessTimeoutMs = 15_000;

export async function waitForRefinementObservation(check, label, pollMs = 2) {
  const deadline = performance.now() + refinementLivenessTimeoutMs;
  for (;;) {
    const observed = await check();
    if (observed) return observed;
    if (performance.now() >= deadline) throw new Error(`refinement timed out waiting for ${label}`);
    await sleep(pollMs);
  }
}
