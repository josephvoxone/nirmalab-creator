import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.mjs';

const { processJob } = core;
const isStaleStateError = e => core.isStaleStateError?.(e);

const account = { id: 'acc_1', label: 'A', profileDir: 'cdp:http://127.0.0.1:9333' };
const job = { id: 'job_x', kind: 'image', prompt: 'p', aspect: '9:16', durationSec: 6, group: 'story_1' };

// The server answers 409 INVALID_STATE to a /fail (or /complete) for a job that is no longer running
// (cancelled by an operator, lease expired and re-claimed). The bridge must treat that as "already settled".
const http409 = new Error('/api/flow/bridge/jobs/job_x/fail -> HTTP 409: {"error":{"code":"INVALID_STATE","message":"Job is not running"}}');

test('isStaleStateError recognises the 409 INVALID_STATE answer and nothing else', () => {
  assert.equal(isStaleStateError(http409), true);
  assert.equal(isStaleStateError(new Error('upload HTTP 409: {"error":{"code":"INVALID_STATE"}}')), true);
  assert.equal(isStaleStateError(new Error('/x -> HTTP 500: boom')), false);
  assert.equal(isStaleStateError(new Error('HTTP 409: STALE rev')), false);
  assert.equal(isStaleStateError(new Error('Target crashed')), false);
});

test('processJob swallows a 409 from /fail (cancelled job): no throw, result still failed', async () => {
  const deps = {
    outDir: '/tmp', maxCredits: 10,
    callTool: async () => { throw new Error('Flow said no'); },
    readFile: async () => Buffer.alloc(1),
    complete: async () => {},
    fail: async () => { throw http409; }
  };
  const out = await processJob({ job, account }, deps);
  assert.equal(out.status, 'failed');
});

test('processJob: a real failure of /fail (HTTP 500) is not swallowed', async () => {
  const deps = {
    outDir: '/tmp', maxCredits: 10,
    callTool: async () => { throw new Error('Flow said no'); },
    readFile: async () => Buffer.alloc(1),
    complete: async () => {},
    fail: async () => { throw new Error('/x -> HTTP 500: boom'); }
  };
  await assert.rejects(() => processJob({ job, account }, deps), /HTTP 500/);
});
