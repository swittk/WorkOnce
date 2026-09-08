import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, '.artifacts'), { recursive: true });
const packed = JSON.parse(
  execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', '.artifacts'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, WORKONCE_REUSE_BOUND_BUILD: '1' },
  }),
)[0];
for (const file of packed.files) {
  if (/(^|\/)(node_modules|\.chatgpt|\.artifacts|\.git|\.env)(\/|$)/.test(file.path))
    throw new Error(`Unexpected packed path: ${file.path}`);
}
const packedPaths = new Set(packed.files.map((file) => file.path));
if (!packedPaths.has('dist/external.js') || !packedPaths.has('dist-cjs/external.js')) {
  throw new Error('Packed WorkOnce is missing the external executor subpath');
}
if (packedPaths.has('dist/remote.js') || packedPaths.has('dist-cjs/remote.js')) {
  throw new Error('Packed WorkOnce still contains the removed remote subpath');
}
const directory = mkdtempSync(join(tmpdir(), 'workonce-consumer-'));
try {
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'workonce-consumer-smoke', version: '1.0.0', private: true }),
  );
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      join(root, '.artifacts', packed.filename),
    ],
    { cwd: directory, stdio: 'pipe' },
  );
  const body = `const q=createWorkOnce({store:createMemoryStore(),scope:'consumer'}).define('work');
 await q.ensure({value:1},{key:'test'});const [run]=await q.claim({workerId:'consumer'});
 const result=await run.settle(run.succeed({ok:true}));if(result.state!=='succeeded')throw new Error('Failed consumer round trip');`;
  writeFileSync(
    join(directory, 'consumer.mjs'),
    `import {createWorkOnce} from '@workonce/core';\nimport {createMemoryStore} from '@workonce/core/memory';\nimport {runExternal} from '@workonce/core/external';\nif(typeof runExternal!=='function')throw new Error('Missing external executor');\n${body}`.replaceAll(
      '\\n',
      '\n',
    ),
  );
  writeFileSync(
    join(directory, 'consumer.cjs'),
    `const {createWorkOnce}=require('@workonce/core');\nconst {createMemoryStore}=require('@workonce/core/memory');\nconst {runExternal}=require('@workonce/core/external');\nif(typeof runExternal!=='function')throw new Error('Missing external executor');\n(async()=>{${body}})().catch(error=>{console.error(error);process.exitCode=1;});`.replaceAll(
      '\\n',
      '\n',
    ),
  );
  for (const file of ['consumer.mjs', 'consumer.cjs'])
    execFileSync(process.execPath, [file], { cwd: directory, stdio: 'inherit' });
  const types =
    `import {createWorkOnce} from '@workonce/core';\nimport {createMemoryStore} from '@workonce/core/memory';\nimport {runExternal,runExternalAvailable} from '@workonce/core/external';\nvoid runExternal; void runExternalAvailable;\nconst q=createWorkOnce({store:createMemoryStore(),scope:'consumer'}).define<{id:string},{done:boolean}>('work');\nvoid q.runAvailable({workerId:'typed'},run=>run.succeed({done:true}));`.replaceAll(
      '\\n',
      '\n',
    );
  writeFileSync(join(directory, 'api.mts'), types);
  writeFileSync(join(directory, 'api.cts'), types);
  execFileSync(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '--strict',
      '--noEmit',
      '--target',
      'ES2018',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--skipLibCheck',
      join(directory, 'api.mts'),
      join(directory, 'api.cts'),
    ],
    { cwd: directory, stdio: 'inherit' },
  );
  console.log(
    JSON.stringify({
      esm: 'passed',
      commonjs: 'passed',
      types: 'passed',
      packedFiles: packed.files.length,
      packedBytes: packed.size,
      integrity: packed.integrity,
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
