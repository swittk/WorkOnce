import test from 'node:test';
import {
  assertExternalTransportSamples,
  runExternalTransportSamples,
} from '../scripts/external-transport-refinement.mjs';

test('compiled external transport observations cover handoff, fencing, ACK ambiguity, capacity and boundaries', async () => {
  const samples = await runExternalTransportSamples();
  assertExternalTransportSamples(samples);
});
