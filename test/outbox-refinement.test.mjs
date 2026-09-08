import test from 'node:test';
import {
  assertOutboxRefinementSamples,
  runOutboxRefinementSamples,
} from '../scripts/outbox-refinement.mjs';

test('compiled outbox observations cover cursor rotation, faults, restart and adapters', async () => {
  const samples = await runOutboxRefinementSamples();
  assertOutboxRefinementSamples(samples);
});
