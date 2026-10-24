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
