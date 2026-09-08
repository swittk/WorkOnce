import test from 'node:test';
import {
  assertReadHistorySamples,
  runReadHistorySamples,
} from '../scripts/read-history-refinement.mjs';

test('history-only state and concurrent inspectMany obey the supported read contract', async () => {
  const samples = await runReadHistorySamples();
  assertReadHistorySamples(samples);
});
