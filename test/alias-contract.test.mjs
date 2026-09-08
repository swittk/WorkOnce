import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as root from '../dist/index.js';
import * as external from '../dist/external.js';

// Readable and technical names are intentional first-class aliases, not old-format compatibility.
test('ESM and CommonJS retain the supported readable and technical alias vocabulary', () => {
  const require = createRequire(import.meta.url);
  for (const api of [root, require('../dist-cjs/index.js')]) {
    for (const name of ['wait', 'defer', 'runExternalAvailable', 'processExternal'])
      assert.equal(typeof api[name], 'function', name);
    for (const [type, names] of [
      [
        api.WorkQueue,
        ['ensure', 'enqueue', 'runAvailable', 'process', 'heartbeat', 'renew', 'restart'],
      ],
      [api.WorkItem, ['ensure', 'enqueue', 'retry', 'rerun', 'restart']],
      [api.WorkRun, ['wait', 'defer', 'heartbeat', 'renew']],
      [api.ExternalWorkRun, ['wait', 'defer']],
    ]) {
      for (const name of names)
        assert.equal(typeof type.prototype[name], 'function', `${type.name}.${name}`);
    }
    assert.deepEqual(api.wait('pending', { afterMs: 7 }), api.defer('pending', { afterMs: 7 }));
  }
  for (const api of [external, require('../dist-cjs/external.js')])
    assert.equal(typeof api.processExternal, 'function');
});
