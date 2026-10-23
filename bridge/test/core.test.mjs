import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, ensureProject, parseToolResult, processJob } from '../src/core.mjs';

const job = { id: 'job_0123456789abcdef', prompt: 'ombak senja, dolly in', aspect: '9:16', durationSec: 4 };
const account = { id: 'acc_1', label: 'Akun 1', profileDir: '/p/1' };

function textResult(obj, isError = false) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }], ...(isError ? { isError: true } : {}) };
}

function makeDeps(overrides = {}) {
  const calls = [];
  const deps = {
    calls,
    projectId: 'proj-1',
    maxCredits: 20,
    outDir: '/tmp/out',
    callTool: async (acc, name, args) => {
      calls.push({ acc: acc.id, name, args });
      if (name === 'flow_generate_video') {
        return textResult({ model: 'omni', quotedCredits: 5, jobs: [{ mediaId: 'm1' }], result: { items: [{ mediaId: 'm1', state: 'succeeded' }] } });
      }
      if (name === 'flow_download_media') return textResult({ path: '/tmp/out/m1.mp4' });
      throw new Error(`unexpected tool ${name}`);
    },
    readFile: async path => { calls.push({ read: path }); return Buffer.alloc(2048, 1); },
    complete: async (id, buf) => { calls.push({ complete: id, bytes: buf.byteLength }); },
    fail: async (id, error, cooldownMs) => { calls.push({ fail: id, error, cooldownMs }); },
    ...overrides
  };
  return deps;
}

test('parseToolResult mengurai JSON dan melempar saat isError', () => {
  assert.deepEqual(parseToolResult(textResult({ a: 1 })), { a: 1 });
  assert.throws(() => parseToolResult(textResult('Not enough credits', true)), /Not enough credits/);
});

test('processJob: generate -> download -> upload complete', async () => {
  const deps = makeDeps();
  const out = await processJob({ job, account }, deps);
  assert.equal(out.status, 'done');
  const gen = deps.calls.find(c => c.name === 'flow_generate_video');
  assert.equal(gen.acc, 'acc_1');
  assert.equal(gen.args.project_id, 'proj-1');
  assert.equal(gen.args.prompt, job.prompt);
  assert.equal(gen.args.aspect, '9:16');
  assert.equal(gen.args.duration_sec, 4);
  assert.equal(gen.args.resolution, '360p');
  assert.equal(gen.args.max_credits, 20);
  assert.equal(gen.args.wait, true);
  const dl = deps.calls.find(c => c.name === 'flow_download_media');
  assert.equal(dl.args.media_id, 'm1');
  assert.deepEqual(deps.calls.at(-1), { complete: job.id, bytes: 2048 });
});

test('processJob: klip gagal -> fail tanpa upload', async () => {
  const deps = makeDeps({
    callTool: async (acc, name, args) => {
      deps.calls.push({ name, args });
      return textResult({ jobs: [{ mediaId: 'm1' }], result: { items: [{ mediaId: 'm1', state: 'failed', error: 'policy' }] } });
    }
  });
  const out = await processJob({ job, account }, deps);
  assert.equal(out.status, 'failed');
  assert.ok(!deps.calls.some(c => c.complete));
  const failed = deps.calls.find(c => c.fail);
  assert.match(failed.error, /failed/);
});

test('processJob: error kredit/limit memberi cooldown ke akun', async () => {
  const deps = makeDeps({
    callTool: async () => textResult('Quote 30 credits exceeds max_credits 20', true)
  });
  const out = await processJob({ job, account }, deps);
  assert.equal(out.status, 'failed');
  const failed = deps.calls.find(c => c.fail);
  assert.ok(failed.cooldownMs > 0, 'cooldown expected');
});

test('classifyError: rate limit/recaptcha -> cooldown, lainnya 0', () => {
  assert.ok(classifyError('429 Too Many Requests').cooldownMs >= 10 * 60_000);
  assert.ok(classifyError('reCAPTCHA check failed').cooldownMs > 0);
  assert.ok(classifyError('Not enough credits').cooldownMs >= 3_600_000);
  assert.equal(classifyError('Prompt blocked by policy').cooldownMs, 0);
});

test('ensureProject: pakai yang ada bernama sama, kalau tidak ada buat baru', async () => {
  const calls = [];
  const callTool = async (acc, name, args) => {
    calls.push(name);
    if (name === 'flow_list_projects') return textResult([{ id: 'x', title: 'Lain' }]);
    if (name === 'flow_create_project') return textResult({ id: 'new-1', title: args.title });
    throw new Error(name);
  };
  assert.equal(await ensureProject(account, callTool, 'OpenCreator Bridge'), 'new-1');
  const existing = async (acc, name) => textResult([{ id: 'p9', title: 'OpenCreator Bridge' }]);
  assert.equal(await ensureProject(account, existing, 'OpenCreator Bridge'), 'p9');
});

test('processJob: gagal menyiapkan project (halaman Flow timeout) tetap dilaporkan fail', async () => {
  const deps = makeDeps({ projectId: undefined, resolveProject: async () => { throw new Error('page.waitForFunction: Timeout 30000ms exceeded.'); } });
  const out = await processJob({ job, account }, deps);
  assert.equal(out.status, 'failed');
  const failed = deps.calls.find(c => c.fail);
  assert.equal(failed.fail, job.id);
  assert.match(failed.error, /Timeout/);
  assert.ok(failed.cooldownMs > 0, 'page timeout -> short cooldown so another account is tried');
  assert.ok(!deps.calls.some(c => c.name === 'flow_generate_video'));
});

test('processJob: resolveProject dipakai bila ada', async () => {
  const deps = makeDeps({ projectId: undefined, resolveProject: async () => 'proj-9' });
  await processJob({ job, account }, deps);
  assert.equal(deps.calls.find(c => c.name === 'flow_generate_video').args.project_id, 'proj-9');
});

import { cdpUrlFromActivePort, isChromeAccount } from '../src/core.mjs';

test('cdpUrlFromActivePort: port + path dari file DevToolsActivePort jadi ws URL', () => {
  assert.equal(cdpUrlFromActivePort('54624\n/devtools/browser/e1536df2\n'), 'ws://127.0.0.1:54624/devtools/browser/e1536df2');
  assert.equal(cdpUrlFromActivePort(''), undefined);
  assert.equal(cdpUrlFromActivePort('abc\n/x'), undefined);
});

test('isChromeAccount: profileDir "chrome" atau kosong-dengan-flag = Chrome milik user', () => {
  assert.equal(isChromeAccount({ profileDir: 'chrome' }), true);
  assert.equal(isChromeAccount({ profileDir: '/Users/x/.google-flow-mcp/profiles/acc-01' }), false);
  assert.equal(isChromeAccount({}), false);
});

import { cdpUrlForAccount } from '../src/core.mjs';

test('cdpUrlForAccount: "cdp:<url>" memakai Chrome khusus dengan port tetap', () => {
  assert.equal(cdpUrlForAccount({ profileDir: 'cdp:http://127.0.0.1:9333' }), 'http://127.0.0.1:9333');
  assert.equal(cdpUrlForAccount({ profileDir: 'cdp:ftp://x' }), undefined);
  assert.equal(cdpUrlForAccount({ profileDir: '/p/acc-01' }), undefined);
});

function agentDeps(agentReply, overrides = {}) {
  const calls = [];
  return {
    calls, projectId: 'proj-1', maxCredits: 20, outDir: '/tmp/out', mode: 'agent',
    callTool: async (acc, name, args) => {
      calls.push({ name, args });
      if (name === 'flow_agent_chat') return textResult(agentReply);
      if (name === 'flow_agent_respond') return textResult({ approval: 'none' });
      if (name === 'flow_video_status') return textResult({ items: [{ mediaId: 'm9', state: 'succeeded' }], timedOut: false });
      if (name === 'flow_download_media') return textResult({ path: '/tmp/out/m9.mp4' });
      throw new Error('unexpected ' + name);
    },
    readFile: async () => Buffer.alloc(4096, 2),
    complete: async (id, buf) => { calls.push({ complete: id, bytes: buf.byteLength }); },
    fail: async (id, error, cooldownMs) => { calls.push({ fail: id, error, cooldownMs }); },
    ...overrides
  };
}

test('mode agent: pesan memuat prompt verbatim + aspek/durasi, approve otomatis ≤ cap, tunggu, unduh, upload', async () => {
  const deps = agentDeps({ approval: 'approved', generatedMediaIds: ['m9'] });
  const out = await processJob({ job: { ...job, durationSec: 6 }, account }, deps);
  assert.equal(out.status, 'done');
  const chat = deps.calls.find(c => c.name === 'flow_agent_chat');
  assert.ok(chat.args.message.includes(job.prompt));
  assert.match(chat.args.message, /exactly one video/i);
  assert.match(chat.args.message, /9:16/);
  assert.match(chat.args.message, /6 seconds/);
  assert.equal(chat.args.max_credits, 20);
  assert.equal(chat.args.new_session, true);
  assert.deepEqual(deps.calls.find(c => c.name === 'flow_video_status').args, { media_ids: ['m9'], wait: true, timeout_sec: 900 });
  assert.deepEqual(deps.calls.at(-1), { complete: job.id, bytes: 4096 });
});

test('mode agent: quote di atas cap -> Reject (tanpa kredit), job gagal tanpa cooldown akun', async () => {
  const deps = agentDeps({ approval: 'awaiting', pendingPermission: { totalCost: 45 }, generatedMediaIds: [] });
  const out = await processJob({ job, account }, deps);
  assert.equal(out.status, 'failed');
  assert.deepEqual(deps.calls.find(c => c.name === 'flow_agent_respond').args, { project_id: 'proj-1', answer: 'Reject' });
  const failed = deps.calls.find(c => c.fail);
  assert.match(failed.error, /45.*20/);
  assert.equal(failed.cooldownMs, 0);
});

test('mode agent: klip gagal/timeout dilaporkan gagal', async () => {
  const deps = agentDeps({ approval: 'approved', generatedMediaIds: ['m9'] });
  const base = deps.callTool;
  deps.callTool = async (acc, name, args) => name === 'flow_video_status'
    ? textResult({ items: [{ mediaId: 'm9', state: 'failed' }], timedOut: false })
    : base(acc, name, args);
  const out = await processJob({ job, account }, deps);
  assert.equal(out.status, 'failed');
  assert.ok(!deps.calls.some(c => c.complete));
});

test('cdpReady: Chrome Flow terjangkau hanya bila /json/version menjawab 200', async () => {
  const { cdpReady, preflightUrl } = await import('../src/core.mjs');
  const ok = async url => { assert.equal(url, 'http://127.0.0.1:9333/json/version'); return { ok: true }; };
  assert.equal(await cdpReady('http://127.0.0.1:9333', ok), true);
  assert.equal(await cdpReady('http://127.0.0.1:9333', async () => { throw new Error('ECONNREFUSED'); }), false);
  assert.equal(await cdpReady('http://127.0.0.1:9333', async () => ({ ok: false })), false);
  assert.equal(preflightUrl({}), 'http://127.0.0.1:9333');
  assert.equal(preflightUrl({ FLOW_CDP_URL: 'http://127.0.0.1:9444' }), 'http://127.0.0.1:9444');
  assert.equal(preflightUrl({ FLOW_PREFLIGHT: 'off' }), undefined);
});

test('agentMessage: satu video, durasi, model Omni 1.1 Flash + audio bawaan (10 vs 15 kredit), prompt apa adanya', async () => {
  const { agentMessage } = await import('../src/core.mjs');
  const msg = agentMessage({ aspect: '9:16', prompt: 'Wide shot of a valley.\nNegative prompt: text.' }, 6);
  assert.match(msg, /exactly one video/);
  assert.match(msg, /9:16/);
  assert.match(msg, /6 seconds/);
  assert.match(msg, /Omni 1\.1 Flash/);
  assert.match(msg, /native audio/);
  assert.ok(msg.endsWith('Wide shot of a valley.\nNegative prompt: text.'));
});

test('accountsToProbe: kredit dicek untuk akun Chrome yang terdaftar, bukan cuma yang pernah dapat job', async () => {
  const { accountsToProbe } = await import('../src/core.mjs');
  const list = accountsToProbe([
    { id: 'a', label: 'Flow 01', profileDir: 'cdp:http://127.0.0.1:9333', status: 'ready' },
    { id: 'b', label: 'Rusak', profileDir: 'cdp:http://127.0.0.1:9444', status: 'error' },
    { id: 'c', label: 'Tanpa profil', status: 'ready' },
    { id: 'd', label: 'Cooldown', profileDir: 'cdp:http://127.0.0.1:9555', status: 'cooldown' },
    { id: 'e', label: 'Chrome utama (jangan disentuh tiap heartbeat: dialog Allow)', profileDir: 'chrome', status: 'ready' },
    { id: 'f', label: 'Profil Playwright', profileDir: '/x/profile', status: 'ready' },
    'sampah'
  ]);
  assert.deepEqual(list.map(a => a.id), ['a', 'd']);
});
