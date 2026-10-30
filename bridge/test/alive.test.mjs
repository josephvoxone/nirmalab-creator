import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whileAlive } from '../src/core.mjs';

test('whileAlive pings during a long job and stops after it ends (bridge stays "online" mid-render)', async () => {
  const pings = [];
  const result = await whileAlive(() => new Promise(r => setTimeout(() => r('done'), 130)), () => { pings.push(Date.now()); return Promise.resolve(); }, 40);
  assert.equal(result, 'done');
  assert.ok(pings.length >= 2, `pinged ${pings.length}×`);
  const n = pings.length;
  await new Promise(r => setTimeout(r, 100));
  assert.equal(pings.length, n);
});

test('whileAlive survives a failing ping and passes the job error through', async () => {
  await assert.rejects(whileAlive(() => new Promise((_, j) => setTimeout(() => j(new Error('boom')), 60)), () => Promise.reject(new Error('net')), 20), /boom/);
});

test('isDeadClientError recognises a client that can never answer again (so it is rebuilt, not reused)', async () => {
  const { isDeadClientError } = await import('../src/core.mjs');
  for (const text of [
    'Not connected',
    'MCP error -32000: Connection closed',
    'page.waitForFunction: Target crashed',
    'page.evaluate: Target page, context or browser has been closed',
    'browserContext.newPage: Target closed',
    'write EPIPE'
  ]) assert.equal(isDeadClientError(new Error(text)), true, text);
  assert.equal(isDeadClientError('Not connected'), true, 'a bare string works too');
});

test('isDeadClientError leaves ordinary tool failures alone (they are retried or reported, the client is fine)', async () => {
  const { isDeadClientError } = await import('../src/core.mjs');
  for (const text of [
    'NOT_SIGNED_IN: Chrome remote debugging is off',
    'QUOTA: you are out of credits',
    'Flow did not create the video',
    'Timeout 30000ms exceeded',
    ''
  ]) assert.equal(isDeadClientError(new Error(text)), false, text);
  assert.equal(isDeadClientError(undefined), false);
  assert.equal(isDeadClientError(null), false);
});
