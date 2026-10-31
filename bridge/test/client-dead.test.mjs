import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core.mjs';

const { classifyError, processJob } = core;
const account = { id: 'acc_1', label: 'Akun 1', profileDir: 'cdp:http://127.0.0.1:9333' };

function deps(message, extra = {}) {
  const calls = [];
  return {
    calls,
    projectId: 'p', outDir: '/tmp', maxCredits: 10,
    callTool: async () => { throw new Error(message); },
    readFile: async () => Buffer.alloc(1),
    complete: async id => calls.push({ complete: id }),
    fail: async (id, error, cooldownMs) => calls.push({ fail: id, error, cooldownMs }),
    release: async (id, error) => calls.push({ release: id, error }),
    ...extra
  };
}

// 28 Oct: 7 of 10 character sheets died of 'page.waitForFunction: Target crashed' / 'Not connected' — each one burnt a
// retry attempt (21 attempts in ~6 minutes) although the job was fine; only the Chrome tab / MCP child was dead.
test('classifyError: a dead Chrome tab / MCP client is client-dead with a cooldown of at least 30 s', () => {
  for (const text of [
    'page.waitForFunction: Target crashed ',
    'Target crashed',
    'Not connected',
    'MCP error -32000: Connection closed',
    'Error: Not connected'
  ]) {
    const c = classifyError(text);
    assert.equal(c.kind, 'client-dead', text);
    assert.ok(c.cooldownMs >= 30_000, `${text}: cooldown ${c.cooldownMs}`);
  }
});

test('classifyError: neighbours keep their meaning (target closed stays transient/5 min, chrome stays chrome, plain errors stay job)', () => {
  assert.deepEqual(classifyError('page.goto: Target closed'), { kind: 'transient', cooldownMs: 5 * 60_000 });
  assert.equal(classifyError('browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9333').kind, 'chrome');
  assert.equal(classifyError('Flow clip failed').kind, 'job');
  assert.equal(classifyError('Flow agent did not create the video (I will generate…)').kind, 'job');
});

test('classifyError: Flow reply text that merely contains the words does not read as a dead client', () => {
  for (const text of [
    'Flow agent did not create the video (Your Google account is not connected to Flow yet. Not connected means…)',
    'Flow agent did not create the image (The target crashed into the wall in your scene)',
    'Flow agent quote 20 credits is above the cap of 10; rejected, nothing spent',
    'Flow clip failed: connection closed by remote scene',
    'Prompt rejected: a character is not connected to the plot'
  ]) assert.notEqual(classifyError(text).kind, 'client-dead', text);
});

for (const kind of ['video', 'image', 'character']) {
  test(`processJob (${kind}): a dead client releases the job — no fail, so no attempt is burnt`, async () => {
    const d = deps('page.waitForFunction: Target crashed ');
    const job = { id: 'job_x', kind, prompt: 'p', aspect: '9:16', durationSec: 6, ...(kind !== 'video' ? { group: 'story_1' } : {}) };
    const out = await processJob({ job, account }, d);
    assert.equal(out.status, 'client-dead');
    assert.ok(out.cooldownMs >= 30_000);
    assert.deepEqual(d.calls.filter(c => c.fail), []);
    assert.equal(d.calls.filter(c => c.release).length, 1);
  });
}

test('processJob: a successful job whose Flow reply says "not connected" is still done', async () => {
  const bytes = Buffer.alloc(32, 7);
  const tools = {
    flow_list_projects: [{ id: 'proj', title: 'Nirmalab · story_1' }],
    flow_get_project: { characters: [], media: [] },
    flow_agent_chat: { reply: 'Your account is not connected to the old project; I made a new one. Not connected.', generatedMediaIds: ['m1'] },
    flow_download_media: { path: '/tmp/m1.png' }
  };
  const d = deps('', {
    callTool: async (_acc, name) => ({ content: [{ type: 'text', text: JSON.stringify(tools[name]) }] }),
    readFile: async () => bytes
  });
  const out = await processJob({ job: { id: 'job_ok', kind: 'image', group: 'story_1', prompt: 'p', aspect: '9:16' }, account }, d);
  assert.equal(out.status, 'done');
  assert.deepEqual(d.calls.filter(c => c.fail || c.release), []);
});

test('createStrikes: 3 strikes within 2 minutes (or 6 in a row, however slow) stop the releasing', () => {
  let now = 1_000_000;
  const s = core.createStrikes?.({ now: () => now });
  assert.ok(s, 'createStrikes exists');
  assert.equal(s.canRelease(), true);
  s.hit(); now += 40_000; s.hit();
  assert.equal(s.canRelease(), true);
  now += 40_000; s.hit();
  assert.equal(s.canRelease(), false, '3 strikes in 80 s');
  s.reset();
  assert.equal(s.canRelease(), true);
  // slow strikes (every 3 minutes) never trip the window …
  for (let i = 0; i < 5; i++) { s.hit(); now += 180_000; }
  assert.equal(s.canRelease(), true);
  // … but a job that crashes the client again and again does not loop forever
  s.hit();
  assert.equal(s.canRelease(), false, '6 consecutive strikes');
});

test('processJob without a release hook (strikes used up): the dead client is reported as a normal failure with the 30 s cooldown', async () => {
  const d = deps('Not connected', { release: undefined });
  const out = await processJob({ job: { id: 'job_x', kind: 'video', prompt: 'p' }, account }, d);
  assert.equal(out.status, 'failed');
  const fail = d.calls.find(c => c.fail);
  assert.ok(fail && fail.cooldownMs >= 30_000);
});
