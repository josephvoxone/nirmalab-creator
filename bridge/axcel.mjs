#!/usr/bin/env node
/**
 * Axcel bridge — runs on the Mac next to the logged-in Chrome (`axcel.cloud`).
 *
 * Axcel has no public API; the only way in is the web app's own `/api/*`, which needs the
 * `axcel_sesi` cookie plus Cloudflare Turnstile tokens minted in a real browser session. So this
 * daemon drives the *user's own* Chrome over CDP (the endpoint Chrome publishes in
 * `~/Library/Application Support/Google/Chrome/DevToolsActivePort` when remote debugging is on),
 * mints the tokens there, and exposes a small local HTTP API the server can call:
 *
 *   GET  /health          → { ok, akun, plan, tokenAge }
 *   GET  /account         → /api/account passthrough (plan, user, credits)
 *   GET  /catalog         → /api/catalog passthrough (models, durations, resolutions)
 *   POST /generate        → { model, op, prompt, ratio, duration, resolution, audio, inputs } → { jobId }
 *   GET  /jobs/:id        → /api/jobs/{id} passthrough
 *   POST /upload          → raw bytes (x-nama, content-type) → { assetId }
 *   GET  /media?url=…     → downloads the finished media (follows the signed redirect)
 *
 * Auth: `Authorization: Bearer $AXCEL_BRIDGE_TOKEN`, bound to 127.0.0.1.
 *
 * Env: AXCEL_BRIDGE_TOKEN (required), AXCEL_BRIDGE_PORT (8899), AXCEL_OUT_DIR
 *      (~/Documents/nirmalab/flow/axcel), AXCEL_PAGE_URL, AXCEL_DEBUG.
 */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AXCEL_ORIGIN, CLIENT_HEADER, PAGE_TOKEN_TTL_MS, absoluteMediaUrl, axcelOp, axcelPayload,
  classifyAxcelError, cookieHeader, jobState, pickDuration, resolutionNumber, resultExtension
} from './src/axcel-core.mjs';

const env = process.env;
const TOKEN = env.AXCEL_BRIDGE_TOKEN || '';
const PORT = Number(env.AXCEL_BRIDGE_PORT || 8899);
/** 127.0.0.1 on the Mac (nothing else may reach it); 0.0.0.0 inside the container network. */
const BIND = env.AXCEL_BIND || '127.0.0.1';
const OUT_DIR = env.AXCEL_OUT_DIR || join(homedir(), 'Documents', 'nirmalab', 'flow', 'axcel');
const PAGE_URL = env.AXCEL_PAGE_URL || `${AXCEL_ORIGIN}/video/text-to-video`;
const DEBUG = env.AXCEL_DEBUG === '1';
// On the Mac Chrome publishes its port in the profile dir; in the container we point at the
// profile volume instead (AXCEL_CHROME_PROFILE) so the same code works on both.
const PORT_FILE = env.AXCEL_CDP_PORT_FILE
  || (env.AXCEL_CHROME_PROFILE
    ? join(env.AXCEL_CHROME_PROFILE, 'DevToolsActivePort')
    : join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'DevToolsActivePort'));
const POLL_MS = 5_000;
/** Chrome's UA — Cloudflare rejects requests without one. */
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const JOB_TIMEOUT_MS = 20 * 60_000;
/** Container deployment: an explicit CDP HTTP endpoint instead of the profile's port file. */
const CDP_URL = (env.AXCEL_CDP_URL || '').trim();
/** Where the finished file is handed back: the Studio server (VPS) or localhost in dev. */
const SERVER_URL = (env.AXCEL_SERVER_URL || env.CREATOR_URL || '').replace(/\/$/, '');
const SERVER_TOKEN = env.AXCEL_SERVER_TOKEN || env.FLOW_BRIDGE_TOKEN || '';
/**
 * Session cookie copied from the user's browser (`axcel_sesi`, HttpOnly). On the VPS there is no
 * human to log in, so the bridge seeds it into the Chrome profile on first use and refreshes it
 * whenever /api/auth/me says the session is gone.
 */
const SESI = (env.AXCEL_SESI || '').trim();

const log = (...parts) => { if (DEBUG) console.error('[axcel]', ...parts); };

// ---------------------------------------------------------------- CDP

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.n = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', event => this.#onMessage(event));
  }

  static async connect() {
    // Two ways in: the DevToolsActivePort file (Mac Chrome) or an explicit HTTP endpoint
    // (the container, where Chrome's /json endpoints are reachable on 127.0.0.1).
    let url;
    if (CDP_URL) {
      const version = await (await fetch(`${CDP_URL.replace(/\/$/, '')}/json/version`, { signal: AbortSignal.timeout(10_000) })).json();
      url = version.webSocketDebuggerUrl;
      if (!url) throw new Error(`CDP_URL ${CDP_URL} tanpa webSocketDebuggerUrl`);
    } else {
      const [port, path] = (await readFile(PORT_FILE, 'utf8')).trim().split('\n');
      if (!port || !path) throw new Error(`DevToolsActivePort kosong: ${PORT_FILE}`);
      url = `ws://127.0.0.1:${port.trim()}${path.trim()}`;
    }
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('Chrome CDP tidak bisa dihubungi — nyalakan remote debugging di chrome://inspect')), { once: true });
    });
    return new CDP(ws);
  }

  #onMessage(event) {
    const raw = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString());
    if (raw.id && this.pending.has(raw.id)) {
      const { resolve, reject } = this.pending.get(raw.id);
      this.pending.delete(raw.id);
      if (raw.error) reject(new Error(`${raw.method ?? 'CDP'}: ${raw.error.message}`));
      else resolve(raw.result ?? {});
    } else if (raw.method) {
      this.events.push(raw);
      if (this.events.length > 500) this.events.splice(0, 250);
    }
  }

  send(method, params = {}, sessionId) {
    const id = ++this.n;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timeout`)); }, 240_000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

/** Connects, finds (or opens) an `axcel.cloud` tab, and returns a session bound to it. */
async function openPage() {
  const cdp = await CDP.connect();
  let target;
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    target = targetInfos.find(t => t.type === 'page' && t.url.startsWith(AXCEL_ORIGIN));
    if (!target) {
      const created = await cdp.send('Target.createTarget', { url: PAGE_URL });
      target = { targetId: created.targetId };
      await new Promise(resolve => setTimeout(resolve, 3_000));
    }
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    // A background tab throttles setTimeout to ~1/min, which stalls Turnstile solves; focus
    // emulation keeps the timers honest without stealing the user's active tab.
    await cdp.send('Page.enable', {}, sessionId).catch(() => undefined);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => undefined);
    await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => undefined);
    return { cdp, sessionId, targetId: target.targetId };
  } catch (error) {
    cdp.close();
    throw error;
  }
}

/**
 * One CDP connection for the whole process. Chrome shows its "remote debugging" prompt per new
 * client, so connecting once and reusing the session is what keeps that prompt from coming back.
 */
let shared = null;

async function getPage() {
  if (shared) {
    try {
      await shared.cdp.send('Runtime.evaluate', { expression: '1', returnByValue: true }, shared.sessionId);
      return shared;
    } catch {
      try { shared.cdp.close(); } catch { /* already gone */ }
      shared = null;
    }
  }
  shared = await openPage();
  shared.cdp.ws.addEventListener('close', () => { shared = null; });
  return shared;
}

async function evaluate(page, expression, { awaitPromise = true, timeout = 60_000, userGesture = false } = {}) {
  const result = await page.cdp.send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true, timeout, userGesture
  }, page.sessionId);
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'eval gagal';
    throw new Error(String(text).split('\n')[0]);
  }
  return result.result?.value;
}


/**
 * Page-side helper, injected before each token mint. One widget per action, reused with
 * reset+execute (the SPA does the same) — re-rendering a fresh widget every call is what made
 * Cloudflare throttle the script and hang the evaluate. The host div needs a real size, or
 * Turnstile refuses to render.
 */
const TURNSTILE_HELPER = `
window.__axcelBridge = window.__axcelBridge || {};
if (window.__axcelBridge.version !== 3) {
  for (const host of Object.values(window.__axcelBridge.hosts || {})) { try { host.remove(); } catch {} }
  window.__axcelBridge = { version: 3 };
}
window.__axcelBridge.solve = async (sitekey, action) => {
  if (!window.turnstile) {
    const selector = 'script[src*="challenges.cloudflare.com/turnstile"]';
    if (!document.querySelector(selector)) {
      await new Promise(done => {
        const s = document.createElement('script');
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        s.onload = done; s.onerror = done;
        document.head.appendChild(s);
      });
    }
    for (let i = 0; i < 40 && !window.turnstile; i++) await new Promise(r => setTimeout(r, 250));
  }
  if (!window.turnstile) return '__no_turnstile__';
  const key = sitekey || '';
  if (!key) return '__no_sitekey__';
  // A fresh widget per solve: reusing an id re-fires the previous promise's callbacks, so the
  // new promise would never resolve.
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:8px;bottom:8px;width:320px;height:70px;z-index:2147483000';
  document.body.appendChild(host);
  return await new Promise(resolve => {
    let done = false;
    let id;
    const finish = v => {
      if (done) return;
      done = true;
      try { window.turnstile.remove(id); } catch {}
      try { host.remove(); } catch {}
      resolve(v);
    };
    try {
      id = window.turnstile.render(host, {
        sitekey: key, action, execution: 'execute', appearance: 'interaction-only',
        callback: t => finish(t), 'error-callback': () => finish(''), 'expired-callback': () => finish('')
      });
      window.turnstile.execute(id);
    } catch { finish('__throw__'); }
    setTimeout(() => finish('__timeout__'), 45000);
  });
};
`;
// ---------------------------------------------------------------- session helpers

let pageToken = { value: '', expiresAt: 0 };
let generateQueue = Promise.resolve();

async function seedCookie(page) {
  if (!SESI) return false;
  await page.cdp.send('Network.enable', {}, page.sessionId).catch(() => undefined);
  await page.cdp.send('Network.setCookie', {
    name: 'axcel_sesi', value: SESI, domain: 'axcel.cloud', path: '/',
    httpOnly: true, secure: true, sameSite: 'Lax',
    expires: Math.floor(Date.now() / 1000) + 30 * 24 * 3600
  }, page.sessionId);
  await page.cdp.send('Page.reload', {}, page.sessionId).catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 4_000));
  log('cookie axcel_sesi disemai dari env');
  return true;
}

async function ensureLoggedIn(page) {
  const me = await evaluate(page, `fetch('/api/auth/me',{credentials:'same-origin',signal:AbortSignal.timeout(90000),headers:${JSON.stringify(CLIENT_HEADER)}}).then(r=>r.json()).catch(()=>({masuk:null}))`, { timeout: 110_000 });
  if (me?.masuk === null) throw new Error('Axcel tidak menjawab (endpoint me lambat) — coba lagi');
  if (!me?.masuk && SESI) {
    // VPS: nobody can log in by hand, so re-seed the copied cookie once and retry.
    if (await seedCookie(page)) {
      const again = await evaluate(page, `fetch('/api/auth/me',{credentials:'same-origin',signal:AbortSignal.timeout(90000),headers:${JSON.stringify(CLIENT_HEADER)}}).then(r=>r.json()).catch(()=>({masuk:null}))`, { timeout: 110_000 });
      if (again?.masuk) return again;
    }
  }
  if (!me?.masuk) throw new Error('Chrome belum login ke axcel.cloud (buka tab Axcel dan masuk dulu)');
  return me;
}


/** Turnstile needs a foreground, unfrozen tab; bring the Axcel tab forward only if it is hidden. */
async function ensureVisible(page) {
  const state = await evaluate(page, 'document.visibilityState', { timeout: 15_000 }).catch(() => 'visible');
  if (state === 'visible') return;
  log('tab tersembunyi (%s) — dibawa ke depan', state);
  await page.cdp.send('Page.bringToFront', {}, page.sessionId).catch(() => undefined);
  await evaluate(page, 'document.visibilityState', { timeout: 15_000 }).catch(() => undefined);
}

let siteKeys = { utama: '', invisible: '', at: 0 };
const SITE_KEY_FILE = join(homedir(), '.config', 'opencreator', 'axcel-sitekeys.json');

async function readKeyFile() {
  try { return JSON.parse(await readFile(SITE_KEY_FILE, 'utf8')); } catch { return {}; }
}

/**
 * Turnstile site keys from `/api/auth/config` (cached 1 h in memory, on disk as a fallback).
 * The origin is intermittently slow or 502, and without the keys no token can be minted — so a
 * known-good pair from disk beats failing the job.
 */
async function ensureSiteKeys(page) {
  if (siteKeys.utama && Date.now() - siteKeys.at < 3_600_000) return siteKeys;
  const adopt = (data) => {
    const utama = typeof data?.turnstile_site_key === 'string' ? data.turnstile_site_key : '';
    const invisible = typeof data?.turnstile_token_site_key === 'string' ? data.turnstile_token_site_key : '';
    return utama ? { utama, invisible, at: Date.now() } : undefined;
  };
  const sources = [
    async () => {
      const cookie = await cookieJar(page);
      const response = await fetch(`${AXCEL_ORIGIN}/api/auth/config`, {
        headers: { 'User-Agent': CHROME_UA, Cookie: cookie, ...CLIENT_HEADER },
        signal: AbortSignal.timeout(45_000)
      });
      return response.json();
    },
    async () => evaluate(page, `fetch('/api/auth/config', { headers: ${JSON.stringify(CLIENT_HEADER)}, signal: AbortSignal.timeout(45000) }).then(r => r.json()).catch(() => ({}))`, { timeout: 60_000 })
  ];
  for (const source of sources) {
    try {
      const data = await source();
      const next = adopt(data);
      if (next) {
        siteKeys = next;
        await writeFile(SITE_KEY_FILE, JSON.stringify({ utama: next.utama, invisible: next.invisible }), { mode: 0o600 }).catch(() => undefined);
        log('site keys ok');
        return siteKeys;
      }
    } catch (error) { log('site keys gagal:', error.message); }
  }
  const cached = adopt(await readKeyFile());
  if (cached) {
    // Keep the timestamp so we retry the origin on the next call, but use what we have now.
    siteKeys = { ...cached, at: 0 };
    log('site keys dari cache');
    return siteKeys;
  }
  throw new Error('site key Turnstile tidak terbaca dari /api/auth/config');
}

/** Page token (`X-Axcel-Token`), minted from an invisible Turnstile solve; cached until 1 min before expiry. */
async function pageTokenFor(page, { force = false, preferVisible = false } = {}) {
  if (!force && pageToken.value && Date.now() < pageToken.expiresAt) return pageToken.value;
  await ensureVisible(page);
  const keys = await ensureSiteKeys(page);
  const keyMain = keys.utama;
  const keyInvisible = preferVisible ? '' : keys.invisible;
  const body = await evaluate(page, `(async () => {
    ${TURNSTILE_HELPER}
    let widget = 'invisible';
    let token = ${JSON.stringify(keyInvisible)} ? await window.__axcelBridge.solve(${JSON.stringify(keyInvisible)}, 'token') : '';
    if (!token || token.startsWith('__')) {
      widget = 'biasa';
      token = await window.__axcelBridge.solve(${JSON.stringify(keyMain)}, 'token');
    }
    if (!token) return { ok: false, why: 'turnstile-kosong' };
    const r = await fetch('/api/keamanan/token', { method: 'POST', credentials: 'same-origin',
      headers: { ...${JSON.stringify(CLIENT_HEADER)}, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnstile: token, widget }) });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  })()`, { timeout: 150_000, userGesture: true });
  if (!body?.ok || !body.data?.token) throw new Error(`token halaman gagal: ${JSON.stringify(body).slice(0, 200)}`);
  pageToken = { value: body.data.token, expiresAt: Date.now() + Math.min(PAGE_TOKEN_TTL_MS, (body.data.umur ?? 1800) * 1000) - 60_000 };
  log('page token ok, umur', body.data.umur);
  return pageToken.value;
}

/** Turnstile token with action `generate` — one per `POST /api/generate`. */
async function generateTurnstile(page) {
  const started = Date.now();
  await ensureVisible(page);
  const { utama: keyMain } = await ensureSiteKeys(page);
  const raw = await evaluate(page, `(async () => {
    ${TURNSTILE_HELPER}
    return await window.__axcelBridge.solve(${JSON.stringify(keyMain)}, 'generate');
  })()`, { timeout: 150_000, userGesture: true });
  log('turnstile generate:', raw ? `${raw.slice(0, 12)}… (${raw.length})` : raw, `${Date.now() - started}ms`);
  if (!raw || raw.startsWith('__')) throw new Error(`Turnstile generate gagal (${raw || 'kosong'}) — coba lagi`);
  return raw;
}

/** Cookie jar for server-side downloads (the media route redirects to a signed CDN URL). */
async function cookieJar(page) {
  const { cookies } = await page.cdp.send('Storage.getCookies', {}, page.sessionId);
  return cookieHeader(cookies);
}

// ---------------------------------------------------------------- Axcel calls

async function callApi(page, path, { method = 'GET', body, headers = {}, token = true, preferVisible = false } = {}) {
  const expression = `(async () => {
    const init = { method: ${JSON.stringify(method)}, credentials: 'same-origin', signal: AbortSignal.timeout(120_000),
      headers: { ...${JSON.stringify(CLIENT_HEADER)}, ...${JSON.stringify(headers)} } };
    ${body === undefined ? '' : `init.body = ${JSON.stringify(typeof body === 'string' ? body : JSON.stringify(body))};
      init.headers['Content-Type'] = 'application/json';`}
    ${token ? `init.headers['X-Axcel-Token'] = ${JSON.stringify(await pageTokenFor(page, { preferVisible }))};` : ''}
    const r = await fetch(${JSON.stringify(path)}, init);
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text.slice(0, 300); }
    return { status: r.status, data };
  })()`;
  const result = await evaluate(page, expression, { timeout: 150_000 });
  return result;
}

async function account() {
  const page = await getPage();
  await ensureLoggedIn(page);
  return (await callApi(page, '/api/account', { token: false })).data;
}

async function catalog() {
  const page = await getPage();
  return (await callApi(page, '/api/catalog', { token: false })).data;
}

/** Submit one job; retries once with a fresh page token when the gate rejects it. */
async function generate(request) {
  const started = Date.now();
  const page = await getPage();
  log('generate: halaman siap', `${Date.now() - started}ms`);
  await ensureLoggedIn(page);
  log('generate: login ok', `${Date.now() - started}ms`);
    const submit = async (attempt) => {
      const [tokens, catalogData] = await Promise.all([generateTurnstile(page), attempt ? Promise.resolve(null) : catalog()]);
      const model = catalogData?.models?.find(m => m.model === request.model);
      const isImage = (model?.type ?? (request.op?.endsWith('i') ? 'image' : 'video')) === 'image';
      const op = request.op || axcelOp({ kind: isImage ? 'image' : 'video', hasStart: !!request.inputs?.start, hasReferences: !!request.inputs?.refimg });
      const supportsAudio = isImage ? false : model?.audio === true;
      const body = axcelPayload({
        model: request.model,
        op,
        prompt: request.prompt,
        ratio: request.ratio,
        duration: isImage ? undefined : pickDuration(request.duration, model?.durations),
        resolution: isImage ? undefined : resolutionNumber(request.resolution),
        audio: request.audio === true && supportsAudio,
        inputs: request.inputs ?? {},
        idempotencyKey: request.idempotencyKey || randomUUID(),
        turnstile: tokens,
        bahasa: request.bahasa || 'id'
      });
      const res = await callApi(page, '/api/generate', { method: 'POST', body });
      log(`generate attempt ${attempt}: HTTP ${res.status}`, res.data?.jobId ?? res.data?.detail?.code ?? '');
      return { body, res };
    };

    let { body, res } = await submit(0);
    // The gate answers the same code with different HTTP statuses (403, 401, 429), so key off the code.
    if (['TOKEN_HALAMAN', 'TURNSTILE'].includes(res.data?.detail?.code)) {
      log('gate menolak, mint token baru (widget biasa) dan ulangi');
      pageToken = { value: '', expiresAt: 0 };
      await new Promise(resolve => setTimeout(resolve, 2_000));
      ({ body, res } = await submit(1));
    }
    if (res.status !== 202 && res.status !== 200) {
      const error = classifyAxcelError(res.status, res.data);
      const err = new Error(error.message);
      err.final = error.final;
      err.code = error.code;
      throw err;
    }
  return { jobId: res.data?.jobId, body };
}

/** Cloudflare answers 502/504 with an HTML page; never let that reach a job's error message. */
const transientStatus = status => status === 0 || status === 408 || status === 429 || status >= 500;

async function job(id) {
  const page = await getPage();
  const res = await callApi(page, `/api/jobs/${encodeURIComponent(id)}`, { token: false });
  if (res.status === 401) throw new Error('Sesi Axcel berakhir — login ulang di Chrome');
  if (res.status === 404) throw Object.assign(new Error('job tidak ditemukan di Axcel'), { final: true });
  if (res.status !== 200) {
    // A flaky origin is not a failed render: report "still running" and let the caller poll on.
    if (transientStatus(res.status) || typeof res.data === 'string') {
      log(`poll ${id}: origin ${res.status}, tunggu`);
      return { jobId: id, status: 'running', note: `origin ${res.status}` };
    }
    const error = classifyAxcelError(res.status, res.data);
    const err = new Error(error.message); err.final = error.final; throw err;
  }
  return res.data;
}

/** Upload one file into the user's Axcel library and return the asset id. */
async function upload({ bytes, name, type }) {
  const page = await getPage();
  await ensureLoggedIn(page);
    const path = /^(video|audio)\//.test(type) ? '/api/uploads/media' : '/api/uploads';
    const result = await evaluate(page, `(async () => {
      const bin = atob(${JSON.stringify(Buffer.from(bytes).toString('base64'))});
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} });
      const form = new FormData();
      form.append('file', file);
      const r = await fetch(${JSON.stringify(path)}, { method: 'POST', credentials: 'same-origin',
        headers: { ...${JSON.stringify(CLIENT_HEADER)}, 'X-Axcel-Token': ${JSON.stringify(await pageTokenFor(page))} }, body: form });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = text.slice(0, 300); }
      return { status: r.status, data };
    })()`, { timeout: 180_000 });
    if (result.status !== 200 && result.status !== 201) {
      const error = classifyAxcelError(result.status, result.data);
      throw new Error(`upload: ${error.message}`);
    }
    return result.data;
}

/** Download a finished result to `OUT_DIR`; returns { path, bytes }. */
async function download({ jobId, kind = 'video', resultUrl }) {
  const url = absoluteMediaUrl(resultUrl);
  if (!url) throw new Error('resultUrl kosong');
  const page = await getPage();
  const cookie = await cookieJar(page);
  // Cloudflare answers 403 to requests without a browser User-Agent, so the download has to look
  // like the tab it came from (UA + client hints), not like a bare HTTP client.
  const response = await fetch(url, {
    headers: {
      'User-Agent': CHROME_UA,
      'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      Accept: '*/*',
      Cookie: cookie,
      ...CLIENT_HEADER,
      Referer: `${AXCEL_ORIGIN}/history`
    },
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`unduh media gagal: HTTP ${response.status}`);
  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    // The CDN sometimes drops the body mid-flight ('terminated'); one retry is enough in practice.
    const retry = await fetch(url, { headers: { 'User-Agent': CHROME_UA, Cookie: cookie, ...CLIENT_HEADER }, redirect: 'follow' });
    if (!retry.ok) throw new Error(`unduh media gagal: HTTP ${retry.status}`);
    bytes = Buffer.from(await retry.arrayBuffer());
  }
  if (bytes.byteLength < 1024) throw new Error('media kosong');
  await mkdir(OUT_DIR, { recursive: true, mode: 0o700 });
  const file = join(OUT_DIR, `${jobId}.${resultExtension(kind)}`);
  await writeFile(file, bytes, { mode: 0o600 });
  return { path: file, bytes: bytes.byteLength };
}

/** Hand the finished file to the Studio server so it lands next to the Flow clips. */
async function handOff({ serverJobId, file, kind, mime }) {
  if (!SERVER_URL || !SERVER_TOKEN || !serverJobId) return { uploaded: false };
  const bytes = await readFile(file);
  const response = await fetch(`${SERVER_URL}/api/flow/bridge/jobs/${encodeURIComponent(serverJobId)}/complete`, {
    method: 'POST',
    headers: {
      'x-flow-bridge-token': SERVER_TOKEN,
      'content-type': mime,
      'x-nirmalab-provider': 'axcel'
    },
    body: bytes,
    signal: AbortSignal.timeout(300_000)
  });
  if (!response.ok) throw new Error(`unggah ke server gagal: HTTP ${response.status} ${(await response.text().catch(() => '')).slice(0, 200)}`);
  return { uploaded: true, bytes: bytes.byteLength };
}

async function reportFailure(serverJobId, message) {
  if (!SERVER_URL || !SERVER_TOKEN || !serverJobId) return;
  await fetch(`${SERVER_URL}/api/flow/bridge/jobs/${encodeURIComponent(serverJobId)}/fail`, {
    method: 'POST',
    headers: { 'x-flow-bridge-token': SERVER_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ error: message }),
    signal: AbortSignal.timeout(30_000)
  }).catch(() => undefined);
}

// ---------------------------------------------------------------- HTTP API

function readBody(request, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('body terlalu besar')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

const send = (reply, status, data) => {
  const payload = JSON.stringify(data ?? {});
  reply.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  reply.end(payload);
};

function authorized(request) {
  if (!TOKEN) return false;
  const header = String(request.headers.authorization || '');
  return header === `Bearer ${TOKEN}`;
}

const server = createServer(async (request, reply) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (!authorized(request)) return send(reply, 401, { error: 'unauthorized' });
  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      const acc = await account();
      return send(reply, 200, {
        ok: true,
        akun: acc?.user?.email ?? null,
        plan: acc?.plan?.plan ?? null,
        planAktif: acc?.plan?.active === true,
        refMedia: acc?.plan?.ref_media === true,
        tokenUmurMs: Math.max(0, pageToken.expiresAt - Date.now())
      });
    }
    if (request.method === 'GET' && url.pathname === '/account') return send(reply, 200, await account());
    if (request.method === 'GET' && url.pathname === '/catalog') return send(reply, 200, await catalog());
    if (request.method === 'POST' && url.pathname === '/generate') {
      const body = JSON.parse((await readBody(request, 1 << 20)).toString() || '{}');
      const serial = generateQueue.then(() => generate(body));
      generateQueue = serial.catch(() => undefined);
      const result = await serial;
      return send(reply, 202, result);
    }
    if (request.method === 'GET' && url.pathname.startsWith('/jobs/')) {
      return send(reply, 200, await job(decodeURIComponent(url.pathname.slice('/jobs/'.length))));
    }
    if (request.method === 'POST' && url.pathname === '/upload') {
      const bytes = await readBody(request);
      const name = decodeURIComponent(String(request.headers['x-nama'] || 'upload.bin'));
      const type = String(request.headers['content-type'] || 'application/octet-stream');
      return send(reply, 200, await upload({ bytes, name, type }));
    }
    if (request.method === 'GET' && url.pathname === '/media') {
      return send(reply, 200, await download({
        jobId: url.searchParams.get('jobId') || `axcel-${Date.now()}`,
        kind: url.searchParams.get('kind') || 'video',
        resultUrl: url.searchParams.get('url') || ''
      }));
    }
    if (request.method === 'POST' && url.pathname === '/collect') {
      // The caller already polled the job to `done`, so no extra status call here: the origin is
      // slow enough that an extra round trip is what blows the caller's timeout.
      const body = JSON.parse((await readBody(request, 1 << 20)).toString() || '{}');
      if (!body.resultUrl) {
        const status = await job(body.jobId);
        if (jobState(status.status) !== 'done') return send(reply, 409, { status, error: `belum selesai (${status.status})` });
        body.resultUrl = status.resultUrl;
      }
      const saved = await download({ jobId: body.jobId, kind: body.kind, resultUrl: body.resultUrl });
      const mime = body.kind === 'image' ? 'image/png' : 'video/mp4';
      const handoff = await handOff({ serverJobId: body.serverJobId, file: saved.path, kind: body.kind, mime });
      log(`collect ${body.jobId}:`, saved.path, saved.bytes, handoff.uploaded ? 'terkirim ke server' : 'lokal');
      return send(reply, 200, { ...saved, ...handoff });
    }
    if (request.method === 'POST' && url.pathname === '/wait') {
      // Wait for a job to finish and download it — one call for the worker.
      const body = JSON.parse((await readBody(request, 1 << 20)).toString() || '{}');
      const started = Date.now();
      for (let round = 1; ; round++) {
        const status = await job(body.jobId);
        log(`wait ${body.jobId} ronde ${round}:`, status.status, `${Date.now() - started}ms`);
        const state = jobState(status.status);
        if (state === 'done') {
          const saved = await download({ jobId: body.jobId, kind: body.kind, resultUrl: status.resultUrl });
          log(`wait ${body.jobId}: unduh`, saved.path, saved.bytes);
          const mime = body.kind === 'image' ? 'image/png' : 'video/mp4';
          const handoff = await handOff({ serverJobId: body.serverJobId, file: saved.path, kind: body.kind, mime });
          return send(reply, 200, { status, ...saved, ...handoff });
        }
        if (state === 'failed') {
          const message = typeof status.error === 'string' ? status.error : 'Axcel gagal';
          await reportFailure(body.serverJobId, message);
          return send(reply, 200, { status, error: message });
        }
        if (Date.now() - started > JOB_TIMEOUT_MS) return send(reply, 200, { status, error: 'timeout' });
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
      }
    }
    return send(reply, 404, { error: 'not found' });
  } catch (error) {
    return send(reply, 502, { error: error instanceof Error ? error.message : String(error), final: error?.final === true });
  }
});

if (!TOKEN || TOKEN.length < 16) {
  console.error('AXCEL_BRIDGE_TOKEN kosong/terlalu pendek — set di ~/.config/opencreator/axcel-bridge.env');
  process.exit(78);
}

server.listen(PORT, BIND, () => {
  console.log(`axcel-bridge listening on http://${BIND}:${PORT} (out ${OUT_DIR})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.close(() => process.exit(0)); });
}
