import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireExpectedProcessFailure } from './subprocess-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mutantRoot = path.join(root, '.artifacts', `lifecycle-mutant-dist-${process.pid}`);
fs.rmSync(mutantRoot, { recursive: true, force: true });
fs.cpSync(path.join(root, 'dist'), mutantRoot, { recursive: true });
const kernelPath = path.join(mutantRoot, 'kernel.js');
const workPath = path.join(mutantRoot, 'work.js');
const original = fs.readFileSync(kernelPath, 'utf8');
const workOriginal = fs.readFileSync(workPath, 'utf8');
const importRoot = `./.artifacts/${path.basename(mutantRoot)}`;
function restore() {
  fs.writeFileSync(kernelPath, original);
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
  console.log(`Lifecycle implementation mutation guard rejects ${label}.`);
}
try {
  {
    const needle = '        row.fence !== ref.fence ||\n';
    assert.equal(
      original.split(needle).length,
      2,
      'stale-fence mutation anchor is stale or not unique',
    );
    fs.writeFileSync(kernelPath, original.replace(needle, ''));
    requireInlineRed(
      'stale-fence acceptance',
      `import assert from 'node:assert/strict';
       import { createWorkOnce } from '${importRoot}/index.js';
       import { createMemoryStore } from '${importRoot}/memory.js';
       let now=100;
       const q=createWorkOnce({store:createMemoryStore({now:()=>now}),scope:'fence-mutant'}).define('job',{limits:{leaseMs:5,maxAttempts:3,maxElapsedMs:100,maxDeferrals:1}});
       await q.ensure(null,{key:'job'});
       const [oldRun]=await q.claim({workerId:'A'});
       now=105;
       const [current]=await q.claim({workerId:'B'});
       assert.ok(current);
       await assert.rejects(oldRun.renew(),e=>e?.code==='stale_attempt','stale fence must reject old renew');`,
      /stale fence must reject old renew/u,
    );
    restore();
  }
  {
    const needle = '    if (row.receipt.submissionHash !== submissionHash)\n';
    assert.equal(
      original.split(needle).length,
      2,
      'receipt-hash mutation anchor is stale or not unique',
    );
    fs.writeFileSync(
      kernelPath,
      original.replace(needle, '    if (false && row.receipt.submissionHash !== submissionHash)\n'),
    );
    requireInlineRed(
      'receipt identity collapse',
      `import assert from 'node:assert/strict';
       import { createWorkOnce } from '${importRoot}/index.js';
       import { createMemoryStore } from '${importRoot}/memory.js';
       const q=createWorkOnce({store:createMemoryStore(),scope:'receipt-mutant'}).define('job');
       await q.ensure(null,{key:'job'});
       const [run]=await q.claim({workerId:'A'});
       await run.settle(run.succeed({value:1}));
       await assert.rejects(run.settle(run.succeed({value:2})),e=>e?.code==='settlement_conflict','receipt hash must reject conflicting settlement');`,
      /receipt hash must reject conflicting settlement/u,
    );
    restore();
  }
  {
    const needle =
      "    if (row.phase.state === 'succeeded' ||\n        row.phase.state === 'failed' ||\n        row.phase.state === 'cancelled')\n        return row;";
    const replacement =
      "    if (row.phase.state === 'failed' || row.phase.state === 'cancelled')\n        return row;";
    assert.equal(
      original.split(needle).length,
      2,
      'terminal-cancel mutation anchor is stale or not unique',
    );
    fs.writeFileSync(kernelPath, original.replace(needle, replacement));
    requireInlineRed(
      'wrong completion-before-cancel rule',
      `import assert from 'node:assert/strict';
       import { createWorkOnce } from '${importRoot}/index.js';
       import { createMemoryStore } from '${importRoot}/memory.js';
       const q=createWorkOnce({store:createMemoryStore(),scope:'cancel-mutant'}).define('job');
       await q.ensure(null,{key:'job'});
       const [run]=await q.claim({workerId:'A'});
       await run.settle(run.succeed('done'));
       const cancelled=await q.cancel({key:'job',generation:1});
       assert.equal(cancelled.phase.state,'succeeded','completion-before-cancel must preserve succeeded');`,
      /completion-before-cancel must preserve succeeded/u,
    );
    restore();
  }
  {
    const needle = '            limit: Math.min(limit * 4, 1000),';
    const replacement = '            limit,';
    assert.equal(
      workOriginal.split(needle).length,
      2,
      'claim-scan widening mutation anchor is stale or not unique',
    );
    fs.writeFileSync(workPath, workOriginal.replace(needle, replacement));
    requireInlineRed(
      'claim-scan widening removal',
      `import assert from 'node:assert/strict';
       import { createWorkOnce } from '${importRoot}/index.js';
       import { createMemoryStore } from '${importRoot}/memory.js';
       let now=100;
       const q=createWorkOnce({store:createMemoryStore({now:()=>now}),scope:'scan-width-mutant'}).define('job',{limits:{leaseMs:5,maxAttempts:1,maxElapsedMs:100,maxDeferrals:1}});
       for (const key of ['a','b','c','d']) await q.ensure(key,{key});
       await q.ensure('healthy',{key:'e',availableAt:110});
       assert.equal((await q.claim({workerId:'first',limit:4})).length,4);
       now=105;
       assert.equal((await q.claim({workerId:'sweeper',limit:1})).length,0);
       now=110;
       const later=await q.claim({workerId:'healthy',limit:1});
       assert.equal(later[0]?.input,'healthy','next invocation must reach later healthy work');`,
      /next invocation must reach later healthy work/u,
    );
    restore();
  }
  {
    const needle = '            if (runs.length === limit)';
    const replacement = '            if (runs.length > limit)';
    assert.equal(
      workOriginal.split(needle).length,
      2,
      'claim limit mutation anchor is stale or not unique',
    );
    fs.writeFileSync(workPath, workOriginal.replace(needle, replacement));
    requireInlineRed(
      'claim limit off-by-one',
      `import assert from 'node:assert/strict';
       import { createWorkOnce } from '${importRoot}/index.js';
       import { createMemoryStore } from '${importRoot}/memory.js';
       const q=createWorkOnce({store:createMemoryStore(),scope:'claim-limit-mutant'}).define('job');
       for (const key of ['a','b','c','d','e']) await q.ensure(key,{key});
       const runs=await q.claim({workerId:'limit',limit:2});
       assert.equal(runs.length,2,'claim limit must cap returned runs');`,
      /claim limit must cap returned runs/u,
    );
    restore();
  }
  {
    const needle =
      "}, { state: 'queued', availableAt: now }, now, 'manual_retry');\n    delete next.firstStartedAt;\n    delete next.receipt;\n    return next;";
    const replacement =
      "}, { state: 'queued', availableAt: now }, now, 'manual_retry');\n    delete next.firstStartedAt;\n    return next;";
    assert.equal(
      original.split(needle).length,
      2,
      'generation-reset receipt mutation anchor is stale or not unique',
    );
    fs.writeFileSync(kernelPath, original.replace(needle, replacement));
    requireInlineRed(
      'retry reset retaining old receipt',
      `import assert from 'node:assert/strict';
       import { createWorkOnce } from '${importRoot}/index.js';
       import { createMemoryStore } from '${importRoot}/memory.js';
       import { retryRecord } from '${importRoot}/kernel.js';
       const store=createMemoryStore({now:()=>100});
       const q=createWorkOnce({store,scope:'reset-mutant'}).define('job');
       await q.ensure(null,{key:'job'});
       const [run]=await q.claim({workerId:'A'});
       await run.settle(run.fail('bad',{manualRetry:true}));
       const row=(await store.getMany([run.ref.workId])).rows[0];
       const next=retryRecord(row,1,100);
       assert.equal(next.receipt,undefined,'retry reset must clear old receipt');`,
      /retry reset must clear old receipt/u,
    );
  }
} finally {
  fs.rmSync(mutantRoot, { recursive: true, force: true });
}
