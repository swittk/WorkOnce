import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esmWork from '../dist/work.js';
import * as esmMemory from '../dist/memory.js';
import * as esmExternal from '../dist/external.js';

const require = createRequire(import.meta.url);
const cjsWork = require('../dist-cjs/work.js');
const cjsMemory = require('../dist-cjs/memory.js');
const cjsExternal = require('../dist-cjs/external.js');

async function processAliasWitness(workApi, memoryApi, label) {
  const work = workApi.createWorkOnce({
    store: memoryApi.createMemoryStore({ now: () => 1000 }),
    scope: `alias-mut-process-${label}`,
  });
  const queue = work.define('job', { perform: async (run) => run.succeed('done') });
  await queue.ensure(null, { key: 'job' });
  const result = await queue.process({ workerId: label });
  assert.equal(result[0]?.status, 'settled', `${label}.process/runAvailable semantics`);
}

async function externalAliasWitness(workApi, memoryApi, externalApi, label) {
  const work = workApi.createWorkOnce({
    store: memoryApi.createMemoryStore({ now: () => 1000 }),
    scope: `alias-mut-external-${label}`,
  });
  const queue = work.define('job');
  const service = queue.serveExternal({
    prepare: (leased) => leased.handoff(leased.input),
    onPrepareError: (leased) => leased.fail('prepare_failed'),
  });
  await service.ensure(null, { key: 'job' });
  const result = await externalApi.processExternal(
    service,
    { workerId: label, signal: new AbortController().signal },
    async (run) => run.succeed(),
  );
  assert.equal(
    result[0]?.status,
    'settled',
    `${label}.processExternal/runExternalAvailable semantics`,
  );
}

async function restartAliasWitness(workApi, memoryApi, label) {
  const work = workApi.createWorkOnce({
    store: memoryApi.createMemoryStore({ now: () => 1000 }),
    scope: `alias-mut-restart-${label}`,
  });
  const queue = work.define('job');
  const queued = await queue.ensure(null, { key: 'job' });
  await assert.doesNotReject(
    queue.restart({ key: 'job', expectedGeneration: queued.generation }),
    `${label}.restart must not reject outside terminal states`,
  );
}

test('ESM WorkQueue.process mutation witness', () =>
  processAliasWitness(esmWork, esmMemory, 'esm'));
test('CommonJS WorkQueue.process mutation witness', () =>
  processAliasWitness(cjsWork, cjsMemory, 'commonjs'));
test('ESM processExternal mutation witness', () =>
  externalAliasWitness(esmWork, esmMemory, esmExternal, 'esm'));
test('CommonJS processExternal mutation witness', () =>
  externalAliasWitness(cjsWork, cjsMemory, cjsExternal, 'commonjs'));
test('ESM WorkQueue.restart mutation witness', () =>
  restartAliasWitness(esmWork, esmMemory, 'esm'));
test('CommonJS WorkQueue.restart mutation witness', () =>
  restartAliasWitness(cjsWork, cjsMemory, 'commonjs'));
