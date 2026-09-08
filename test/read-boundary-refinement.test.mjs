import test from 'node:test';
import {
  assertTypedReadBoundarySamples,
  runTypedReadBoundarySamples,
} from '../scripts/read-boundary-refinement.mjs';

test('typed reads preserve definition fences, exact missing semantics and adapter parity', async () => {
  const samples = await runTypedReadBoundarySamples();
  assertTypedReadBoundarySamples(samples);
});
