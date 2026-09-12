import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireCausalMutationFailure } from './mutation-file-guard.mjs';

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
function replaceOccurrence(source, needle, replacement, occurrence, label) {
  const positions = [];
  let from = 0;
  while (true) {
    const index = source.indexOf(needle, from);
    if (index < 0) break;
    positions.push(index);
    from = index + needle.length;
  }
  assert.equal(positions.length, 2, `${label} mutation anchor occurrence count drifted`);
  const index = positions[occurrence];
  assert.notEqual(index, undefined, `${label} mutation occurrence is missing`);
  return source.slice(0, index) + replacement + source.slice(index + needle.length);
}
function requireInlineRed(label, code, pattern) {
  const runWitness = () =>
    spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      timeout: 15_000,
    });
  requireCausalMutationFailure(
    new Map([
      [externalPath, externalOriginal],
      [workPath, workOriginal],
    ]),
    runWitness,
    label,
    pattern,
  );
  console.log(`External implementation mutation guard rejects ${label}.`);
}
try {
  {
    const needle = 'throw controller.signal.reason;';
    fs.writeFileSync(
      externalPath,
      replaceOccurrence(
        externalOriginal,
        needle,
        'void controller.signal.reason;',
        0,
        'pre-handler abort gate',
      ),
    );
    requireInlineRed(
      'pre-handler abort gate removal',
      `import assert from 'node:assert/strict';
       import { runExternalAvailable } from '${importRoot}/index.js';
       const stop=new AbortController(); const stopped=new Error('stopped before handler'); let handlers=0;
       const lease={input:null,attempt:{workId:'x',generation:1,fence:1},observedAt:0,leaseUntil:1000};
       const transport={async claim(){stop.abort(stopped);return [lease]},async heartbeat(){throw new Error('unexpected heartbeat')},async settle(){throw new Error('unexpected settle')}};
       const [result]=await runExternalAvailable(transport,{workerId:'r',signal:stop.signal},async run=>{handlers++;return run.succeed();});
       assert.equal(handlers,0,'pre-aborted external lease must not enter its handler');
       assert.equal(result.status,'interrupted');
       assert.equal(result.error,stopped);`,
      /pre-aborted external lease must not enter its handler/u,
    );
    restore();
  }
  {
    const needle = 'throw controller.signal.reason;';
    fs.writeFileSync(
      externalPath,
      replaceOccurrence(
        externalOriginal,
        needle,
        "throw new Error('External ownership lost');",
        1,
        'post-handler abort cause',
      ),
    );
    requireInlineRed(
      'post-handler heartbeat cause erasure',
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
      externalOriginal.split(needle).length,
      2,
      'external first-fatal mutation anchor is stale or not unique',
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
      "    if (leases.length > limit)\n        throw new RangeError('External claim returned more leases than requested');";
    assert.equal(
      externalOriginal.split(needle).length,
      2,
      'oversized-claim mutation anchor is stale or not unique',
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
    const needle = '        if (attempts.has(identity))';
    assert.equal(
      externalOriginal.split(needle).length,
      2,
      'duplicate-claim mutation anchor is stale or not unique',
    );
    fs.writeFileSync(externalPath, externalOriginal.replace(needle, '        if (false)'));
    requireInlineRed(
      'duplicate external attempt acceptance',
      `import assert from 'node:assert/strict';
       import { runExternalAvailable } from '${importRoot}/index.js';
       const attempt={workId:'same',generation:1,fence:1};
       const lease={input:null,attempt,observedAt:0,leaseUntil:100};
       let handlers=0;
       const transport={async claim(){return [lease,{...lease}]},async heartbeat(){return {observedAt:0,leaseUntil:100}},async settle(){return {state:'succeeded',result:null}}};
       await assert.rejects(runExternalAvailable(transport,{workerId:'r',concurrency:2,signal:new AbortController().signal},async run=>{handlers++;return run.succeed();}),/duplicate attempt identity/,'duplicate external attempt must reject before handlers');
       assert.equal(handlers,0);`,
      /duplicate external attempt must reject before handlers|Missing expected rejection/u,
    );
    restore();
  }
  {
    const needle = '            signal: options.signal,';
    fs.writeFileSync(
      externalPath,
      replaceOccurrence(
        externalOriginal,
        needle,
        '            signal: undefined,',
        0,
        'runExternalAvailable claim signal',
      ),
    );
    requireInlineRed(
      'runExternalAvailable claim abort-signal erasure',
      `import assert from 'node:assert/strict';
       import { runExternalAvailable } from '${importRoot}/index.js';
       const stop=new AbortController();
       let exact=false;
       const transport={async claim(request){exact=request.signal===stop.signal;return []},async heartbeat(){throw new Error('unexpected')},async settle(){throw new Error('unexpected')}};
       await runExternalAvailable(transport,{workerId:'r',signal:stop.signal},async run=>run.succeed());
       assert.equal(exact,true,'bounded external transport must receive the caller stop signal');`,
      /bounded external transport must receive the caller stop signal/u,
    );
    restore();
  }
  {
    const needle = '            signal: options.signal,';
    fs.writeFileSync(
      externalPath,
      replaceOccurrence(
        externalOriginal,
        needle,
        '            signal: undefined,',
        1,
        'runExternal claim signal',
      ),
    );
    requireInlineRed(
      'runExternal claim abort-signal erasure',
      `import assert from 'node:assert/strict';
       import { runExternal } from '${importRoot}/external.js';
       const stop=new AbortController(); let received;
       const transport={async claim(request){received=request.signal;stop.abort(new Error('stop'));return []},async heartbeat(){throw new Error('unexpected')},async settle(){throw new Error('unexpected')}};
       await runExternal(transport,{workerId:'r',signal:stop.signal},async run=>run.succeed());
       assert.equal(received,stop.signal,'managed external transport must receive the caller stop signal');`,
      /managed external transport must receive the caller stop signal/u,
    );
    restore();
  }
  {
    const needle = '                const renewed = await run.heartbeat();';
    const replacement =
      '                const renewed = { attempt: run.attempt, observedAt: run.observedAt };';
    assert.equal(
      workOriginal.split(needle).length,
      2,
      'final-handoff-heartbeat mutation anchor is stale or not unique',
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
