import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, processJob } from '../src/core.mjs';

const CDP_ERR = 'browserType.connectOverCDP: Protocol error (Browser.setDownloadBehavior): Browser context management is not supported.';
const account = { id: 'acc_1', label: 'Akun 1', profileDir: 'cdp:http://127.0.0.1:9333' };

function deps(extra = {}) {
  const calls = [];
  return {
    calls,
    projectId: 'p', outDir: '/tmp', maxCredits: 20,
    callTool: async () => { throw new Error(CDP_ERR); },
    readFile: async () => Buffer.alloc(1),
    complete: async id => calls.push({ complete: id }),
    fail: async (id, error) => calls.push({ fail: id, error }),
    release: async (id, error) => calls.push({ release: id, error }),
    ...extra
  };
}

test('classifyError: a Chrome that answers /json/version but refuses CDP control is a chrome fault, not the job', () => {
  assert.equal(classifyError(CDP_ERR).kind, 'chrome');
  assert.equal(classifyError('browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9333').kind, 'chrome');
  assert.equal(classifyError(CDP_ERR).cooldownMs, 0);
});

for (const kind of ['video', 'image', 'character']) {
  test(`processJob (${kind}): chrome fault releases the job instead of burning an attempt`, async () => {
    const d = deps();
    const job = { id: 'job_x', kind, prompt: 'p', aspect: '9:16', durationSec: 6, ...(kind !== 'video' ? { group: 'story_1' } : {}) };
    const out = await processJob({ job, account }, d);
    assert.equal(out.status, 'chrome-broken');
    assert.deepEqual(d.calls.filter(c => c.fail), []);
    assert.equal(d.calls.filter(c => c.release).length, 1);
  });
}

test('processJob: without a release hook the old fail path still applies', async () => {
  const d = deps({ release: undefined });
  const out = await processJob({ job: { id: 'job_y', prompt: 'p', aspect: '9:16', durationSec: 6 }, account }, d);
  assert.equal(out.status, 'failed');
  assert.equal(d.calls.filter(c => c.fail).length, 1);
});
