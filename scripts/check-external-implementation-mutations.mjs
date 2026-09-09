import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutantRoot = path.join(root, '.artifacts', `external-mutant-dist-${process.pid}`);
fs.rmSync(mutantRoot, { recursive: true, force: true });
fs.cpSync(path.join(root, 'dist'), mutantRoot, { recursive: true });
const externalPath = path.join(mutantRoot, 'external.js');
const workPath = path.join(mutantRoot, 'work.js');
const externalOriginal = fs.readFileSync(externalPath, 'utf8');
const workOriginal = fs.readFileSync(workPath, 'utf8');
const importRoot = `./.artifacts/${path.basename(mutantRoot)}`;
function restore() {
  fs.writeFileSync(externalPath, externalOriginal);
  fs.writeFileSync(workPath, workOriginal);
}
function requireInlineRed(label, code, pattern) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    timeout: 15_000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  requireExpectedProcessFailure(result, `${label} mutant unexpectedly passed`);
  assert.match(output, pattern, `${label} failed for an unrelated reason`);
  console.log(`External implementation mutation guard rejects ${label}.`);
}
try {
  {
    const needle = 'throw controller.signal.reason;';
    assert.equal(
      externalOriginal.includes(needle),
      true,
      'heartbeat-cause mutation anchor is stale',
    );
    fs.writeFileSync(
      externalPath,
      externalOriginal.replaceAll(needle, "throw new Error('External ownership lost');"),
    );
    requireInlineRed(
      'heartbeat cause erasure',
      `import assert from 'node:assert/strict';
       import { runExternalAvailable } from '${importRoot}/index.js';
       import { setTimeout as sleep } from 'node:timers/promises';
       const heartbeatError=new Error('heartbeat network failure');
       const transport={async claim(){return [{input:null,attempt:{workId:'x',generation:1,fence:1},observedAt:0,leaseUntil:100}]},async heartbeat(){throw heartbeatError},async settle(){throw new Error('unexpected settle')}};
       const [result]=await runExternalAvailable(transport,{workerId:'r',heartbeatMs:5,signal:new AbortController().signal},async run=>{await sleep(20); return run.succeed();});
       assert.equal(result.status,'interrupted');
       assert.equal(result.error,heartbeatError,'heartbeat transport cause must be preserved exactly');`,
      /heartbeat transport cause must be preserved exactly/u,
    );
    restore();
  }
  {
    const needle = `if (fatal === undefined)
            fatal = { error };`;
    assert.equal(
      externalOriginal.includes(needle),
      true,
      'external first-fatal mutation anchor is stale',
    );
    fs.writeFileSync(externalPath, externalOriginal.replace(needle, 'fatal = { error };'));
    requireInlineRed(
      'external first fatal overwrite',
      `import assert from 'node:assert/strict';
       import { runExternal } from '${importRoot}/external.js';
       import { setTimeout as sleep } from 'node:timers/promises';
       const first=new Error('first-fatal-A'); const second=new Error('second-fatal-B');
       let claimed=false;
       const lease=id=>({input:{id},attempt:{workId:id,generation:1,fence:1},observedAt:0,leaseUntil:5000});
       const transport={async claim(){if(claimed)return []; claimed=true; return [lease('a'),lease('b')]},async heartbeat(lease){return lease},async settle(){throw new Error('unexpected settle')}};
       const stop=new AbortController(); let caught;
       try {await runExternal(transport,{workerId:'r',concurrency:2,heartbeatMs:100,idleMs:1000,signal:stop.signal},async (_run,input)=>{if(input.id==='a')throw first; await sleep(20); throw second;});} catch(error){caught=error;} finally {stop.abort();}
       assert.equal(caught,first,'external managed runner must preserve its first fatal failure');`,
      /external managed runner must preserve its first fatal failure/u,
    );
    restore();
  }
  {
    const needle =
      "        if (leases.length > limit)\n            throw new RangeError('External claim returned more leases than requested');";
    assert.equal(
      externalOriginal.includes(needle),
      true,
      'oversized-claim mutation anchor is stale',
    );
    fs.writeFileSync(externalPath, externalOriginal.replace(needle, ''));
    requireInlineRed(
      'oversized transport claim acceptance',
      `import assert from 'node:assert/strict';
       import { runExternalAvailable } from '${importRoot}/index.js';
       let handlers=0;
       const lease=id=>({input:null,attempt:{workId:id,generation:1,fence:1},observedAt:0,leaseUntil:100});
       const transport={async claim(){return [lease('a'),lease('b')]},async heartbeat(){return {observedAt:0,leaseUntil:100}},async settle(){return {state:'succeeded',result:null}}};
       await assert.rejects(runExternalAvailable(transport,{workerId:'r',concurrency:1,signal:new AbortController().signal},async run=>{handlers++;return run.succeed();}),/more leases than requested/,'oversized external claim must reject before handlers');
       assert.equal(handlers,0);`,
      /oversized external claim must reject before handlers|Missing expected rejection/u,
    );
    restore();
  }
  {
    const needle = '            signal: options.signal,';
    assert.equal(externalOriginal.includes(needle), true, 'claim-signal mutation anchor is stale');
    fs.writeFileSync(
      externalPath,
      externalOriginal.replaceAll(needle, '            signal: undefined,'),
    );
    requireInlineRed(
      'transport claim abort-signal erasure',
      `import assert from 'node:assert/strict';
       import { runExternalAvailable } from '${importRoot}/index.js';
       const stop=new AbortController();
       let exact=false;
       const transport={async claim(request){exact=request.signal===stop.signal;return []},async heartbeat(){throw new Error('unexpected')},async settle(){throw new Error('unexpected')}};
       await runExternalAvailable(transport,{workerId:'r',signal:stop.signal},async run=>run.succeed());
       assert.equal(exact,true,'external transport must receive the caller stop signal');`,
      /external transport must receive the caller stop signal/u,
    );
    restore();
  }
  {
    const needle = '                const renewed = await run.heartbeat();';
    const replacement =
      '                const renewed = { attempt: run.attempt, observedAt: run.observedAt };';
    assert.equal(
      workOriginal.includes(needle),
      true,
      'final-handoff-heartbeat mutation anchor is stale',
    );
    fs.writeFileSync(workPath, workOriginal.replace(needle, replacement));
    requireInlineRed(
      'final handoff heartbeat removal',
      `import assert from 'node:assert/strict';
       import { createWorkOnce } from '${importRoot}/index.js';
       import { createMemoryStore } from '${importRoot}/memory.js';
       let release; const gate=new Promise(r=>release=r); let entered; const seen=new Promise(r=>entered=r);
       const q=createWorkOnce({store:createMemoryStore(),scope:'handoff-mutant'}).define('job');
       await q.ensure(null,{key:'x'});
       const service=q.serveExternal({prepare:async run=>{entered();await gate;return run.handoff(null)},onPrepareError:run=>run.fail('prepare')});
       const pending=service.claim({workerId:'relay',limit:1});
       await seen; await q.cancel({key:'x',generation:1}); release();
       const leases=await pending;
       assert.equal(leases.length,0,'stale prepared attempt must not be exported after cancel');`,
      /stale prepared attempt must not be exported after cancel/u,
    );
    restore();
  }
} finally {
  fs.rmSync(mutantRoot, { recursive: true, force: true });
}
