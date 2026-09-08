import { availableParallelism } from 'node:os';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runRuntimeBoundarySamples } from './runtime-boundary-refinement.mjs';

const jar = resolve(process.env.TLA2TOOLS_JAR ?? '.artifacts/tla2tools.jar');
if (!existsSync(jar))
  throw new Error('Set TLA2TOOLS_JAR to the official tla2tools.jar. See docs/assurance.md.');
mkdirSync('.artifacts/tlc', { recursive: true });
const workers = String(Math.max(2, Math.min(8, availableParallelism())));
const timeoutMs = 30_000;
function runModel(model, config, modulePath = `${model}.tla`) {
  const directory = resolve('.artifacts/tlc', model);
  mkdirSync(directory, { recursive: true });
  const result = spawnSync(
    'java',
    [
      '-Xmx512m',
      '-XX:+UseParallelGC',
      `-DTLA-Library=${resolve('formal')}`,
      '-cp',
      jar,
      'tlc2.TLC',
      '-workers',
      workers,
      '-metadir',
      directory,
      '-config',
      config,
      modulePath,
    ],
    { cwd: 'formal', stdio: 'inherit', timeout: timeoutMs, killSignal: 'SIGKILL' },
  );
  if (result.error) {
    const prefix =
      result.error.code === 'ETIMEDOUT'
        ? `TLC infrastructure timeout after ${timeoutMs} ms`
        : 'TLC infrastructure spawn failure';
    throw new Error(`${prefix}: ${result.error.message}`, { cause: result.error });
  }
  if (result.signal) throw new Error(`TLC infrastructure terminated by signal ${result.signal}`);
  if (result.status === null) throw new Error('TLC infrastructure returned no exit status');
  if (result.status !== 0) process.exit(result.status);
}
function tlaValue(value) {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return `[${Object.entries(value)
      .map(([key, item]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new Error('Invalid observation field');
        return `${key} |-> ${tlaValue(item)}`;
      })
      .join(', ')}]`;
  }
  throw new Error('Unrepresentable runtime observation');
}
if (!process.argv.includes('--runtime-only')) runModel('WorkOnce', 'WorkOnce.cfg');
// No per-trace TLC processes and no cached witness: check fresh compiled public API observations
// in one separate, small control-state graph. The durable graph is not cross-product inflated.
const samples = await runRuntimeBoundarySamples();
const config = resolve('.artifacts/tlc/WorkOnceRuntime-observed.cfg');
const observedModule = resolve('.artifacts/tlc/WorkOnceRuntimeObserved.tla');
writeFileSync(
  observedModule,
  `---- MODULE WorkOnceRuntimeObserved ----\nEXTENDS WorkOnceRuntime\nObservedSamples == {\n${samples.map(tlaValue).join(',\n')}\n}\n====\n`,
);
writeFileSync(
  config,
  `${readFileSync('formal/WorkOnceRuntime.cfg', 'utf8')}\nCONSTANT Samples <- ObservedSamples\n`,
);
console.log(
  `TLC runtime boundary receives ${samples.length} fresh compiled public API observations.`,
);
runModel('WorkOnceRuntimeObserved', config, observedModule);
