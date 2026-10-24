#!/usr/bin/env node
/**
 * OpenCreator ⇄ Google Flow bridge (runs on the Mac, not the VPS).
 *
 *   node bridge.mjs run              poll the server queue forever
 *   node bridge.mjs once             process at most one job, then exit (E2E)
 *   node bridge.mjs status <dir>     flow_status for a Chrome profile (no credits)
 *   node bridge.mjs login  <dir>     open Chrome to sign a profile in to Flow
 *
 * Env: FLOW_BRIDGE_TOKEN (required for run/once), CREATOR_URL, FLOW_MCP_DIR,
 *      BRIDGE_ID, POLL_MS, FLOW_PROJECT_TITLE, FLOW_MAX_CREDITS, FLOW_OUTPUT_DIR,
 *      FLOW_RESOLUTION (360p|720p).
 */
import { flowHome } from './src/paths.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { accountsToProbe, cdpReady, preflightUrl, cdpUrlForAccount, cdpUrlFromActivePort, ensureProject, whileAlive, isChromeAccount, parseToolResult, processJob, resultHeaders } from './src/core.mjs';

const env = process.env;
const CREATOR_URL = (env.CREATOR_URL || 'https://creator.nirmalab.com').replace(/\/$/, '');
const FLOW_MCP_DIR = env.FLOW_MCP_DIR || join(homedir(), 'tools', 'google-flow-mcp');
const BRIDGE_ID = env.BRIDGE_ID || hostname();
const POLL_MS = Number(env.POLL_MS || 15_000);
const PROJECT_TITLE = env.FLOW_PROJECT_TITLE || 'OpenCreator Bridge';
const MAX_CREDITS = Number(env.FLOW_MAX_CREDITS || 20);
const OUT_DIR = env.FLOW_OUTPUT_DIR || join(flowHome(env), 'bridge');
const RESOLUTION = env.FLOW_RESOLUTION === '720p' ? '720p' : '360p';
/** 'agent' = current Flow UI (agent composer with credit approval); 'manual' = legacy direct composer. */
const FLOW_MODE = env.FLOW_MODE === 'manual' ? 'manual' : 'agent';
const UA = 'opencreator-flow-bridge/1.0';

const sdk = join(FLOW_MCP_DIR, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client');
const { Client } = await import(pathToFileURL(join(sdk, 'index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(join(sdk, 'stdio.js')).href);

const clients = new Map();
const accountIds = new Map();
const projects = new Map();

function log(...args) {
  console.error(new Date().toISOString(), '[bridge]', ...args);
}

async function clientFor(account) {
  const key = account.profileDir || 'default';
  if (account.id && account.id !== 'cli') accountIds.set(key, account.id);
  if (clients.has(key)) return clients.get(key);
  const childEnv = { ...env, FLOW_MAX_CREDITS_PER_CALL: String(MAX_CREDITS), FLOW_OUTPUT_DIR: OUT_DIR };
  delete childEnv.FLOW_PROFILE_DIR;
  if (isChromeAccount(account)) {
    const activePort = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'DevToolsActivePort');
    let cdp;
    try { cdp = cdpUrlFromActivePort(readFileSync(activePort, 'utf8')); } catch { cdp = undefined; }
    if (!cdp) throw new Error('NOT_SIGNED_IN: Chrome remote debugging is off (enable chrome://inspect/#remote-debugging)');
    childEnv.FLOW_CDP_URL = cdp;
  } else if (cdpUrlForAccount(account)) {
    childEnv.FLOW_CDP_URL = cdpUrlForAccount(account);
  } else if (account.profileDir) {
    childEnv.FLOW_PROFILE_DIR = account.profileDir;
  }
  delete childEnv.FLOW_BRIDGE_TOKEN;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(FLOW_MCP_DIR, 'dist', 'index.js')],
    env: childEnv,
    stderr: 'inherit'
  });
  const client = new Client({ name: 'opencreator-flow-bridge', version: '1.0.0' });
  await client.connect(transport);
  clients.set(key, client);
  log('mcp connected for', account.label ?? key);
  return client;
}

async function callTool(account, name, args) {
  const client = await clientFor(account);
  return client.callTool({ name, arguments: args }, undefined, { timeout: 15 * 60_000 });
}

async function api(path, init = {}) {
  const token = env.FLOW_BRIDGE_TOKEN;
  if (!token) throw new Error('FLOW_BRIDGE_TOKEN is not set');
  const response = await fetch(`${CREATOR_URL}${path}`, {
    ...init,
    headers: { 'user-agent': UA, 'x-flow-bridge-token': token, ...(init.headers ?? {}) }
  });
  return response;
}

async function postJson(path, body) {
  const response = await api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : undefined;
}

let registered = [];
async function heartbeat(again = true) {
  const accounts = [];
  // Open a session for every registered account so credits are always fresh (not only after a job).
  for (const account of registered) await clientFor(account).catch(e => log('open', account.label, e.message));
  for (const [key, client] of clients) {
    try {
      const status = parseToolResult(await client.callTool({ name: 'flow_status', arguments: {} }));
      const id = accountIds.get(key);
      if (id && typeof status?.credits === 'number') accounts.push({ id, credits: status.credits });
    } catch (error) {
      log('status failed for', key, error.message);
    }
  }
  const reply = await postJson('/api/flow/bridge/heartbeat', { bridgeId: BRIDGE_ID, accounts }).catch(e => log('heartbeat', e.message));
  const before = registered.length;
  registered = accountsToProbe(reply?.accounts);
  if (again && registered.length > before) await heartbeat(false);
}

async function handle(claim) {
  const { job, account } = claim;
  const key = `${account.profileDir || 'default'}|${account.id}`;
  log(`job ${job.id} on ${account.label}: ${job.prompt.slice(0, 80)}`);
  const result = await processJob(claim, {
    callTool,
    resolveProject: async acc => {
      if (!projects.has(key)) projects.set(key, await ensureProject(acc, callTool, PROJECT_TITLE));
      return projects.get(key);
    },
    mode: FLOW_MODE,
    projectTitle: PROJECT_TITLE,
    maxCredits: MAX_CREDITS,
    outDir: OUT_DIR,
    resolution: RESOLUTION,
    readFile: path => readFile(path),
    complete: async (id, bytes, meta = {}) => {
      const response = await api(`/api/flow/bridge/jobs/${id}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', ...resultHeaders(meta) },
        body: bytes
      });
      if (!response.ok) throw new Error(`upload HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    },
    fail: (id, error, cooldownMs) => postJson(`/api/flow/bridge/jobs/${id}/fail`, { error, cooldownMs }),
    // Chrome fault: leave the job running under this bridge id; the next claim re-queues it
    // without burning an attempt. After 3 strikes in a row, give up on it the normal way.
    ...(chromeStrikes < 3 ? { release: async (id, error) => log(`job ${id} released (Chrome fault): ${error.slice(0, 120)}`) } : {})
  });
  log(`job ${job.id} -> ${result.status}`, result.error ?? `${result.bytes} bytes, quote ${result.quotedCredits}`);
  return result;
}

let chromeStrikes = 0;

/** Restart the dedicated Flow Chrome (only a process started with our flow profile + this port). */
async function restartFlowChrome(cdp) {
  const port = new URL(cdp).port || '9333';
  try {
    const pids = execFileSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    for (const pid of pids) {
      const cmd = execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' });
      if (cmd.includes(`--remote-debugging-port=${port}`) && cmd.includes('.google-flow-mcp/chrome')) { process.kill(Number(pid)); log(`killed stale Flow Chrome pid ${pid}`); }
      else log(`not killing pid ${pid} on :${port} — not the Flow Chrome`);
    }
  } catch (error) { log('restart: lsof/kill failed', error.message); }
  for (const client of clients.values()) await client.close().catch(() => {});
  clients.clear();
  await new Promise(r => setTimeout(r, 3000));
  try { execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.nirmalab.flow-chrome`]); } catch (error) { log('restart: kickstart failed', error.message); }
  for (let i = 0; i < 20 && !(await cdpReady(cdp)); i++) await new Promise(r => setTimeout(r, 1500));
  await new Promise(r => setTimeout(r, 5000));
}

async function loop(once) {
  log(`bridge ${BRIDGE_ID} -> ${CREATOR_URL} (max ${MAX_CREDITS} credits/clip, ${RESOLUTION}, ${FLOW_MODE} mode)`);
  await heartbeat();
  let lastBeat = Date.now();
  const cdp = preflightUrl(env);
  let chromeUp;
  for (;;) {
    if (cdp) {
      const up = await cdpReady(cdp);
      if (up !== chromeUp) { log(up ? `Flow Chrome ready on ${cdp}` : `Flow Chrome not reachable on ${cdp} — waiting (jobs stay queued; run ./flow-chrome.sh)`); chromeUp = up; }
      if (!up) {
        if (once) return { status: 'chrome-offline' };
        if (Date.now() - lastBeat > 30_000) { await heartbeat(); lastBeat = Date.now(); }
        await new Promise(resolve => setTimeout(resolve, Math.max(POLL_MS, 10_000)));
        continue;
      }
    }
    let claim;
    try {
      claim = await postJson('/api/flow/bridge/claim', { bridgeId: BRIDGE_ID });
    } catch (error) {
      log('claim failed:', error.message);
    }
    if (claim?.job) {
      // Light ping only (no Chrome calls) so the app shows the bridge online while it renders.
      const result = await whileAlive(() => handle(claim), () => postJson('/api/flow/bridge/heartbeat', { bridgeId: BRIDGE_ID, accounts: [] }));
      if (result.status === 'chrome-broken') {
        chromeStrikes++;
        if (cdp) await restartFlowChrome(cdp);
      } else if (result.status === 'done') chromeStrikes = 0;
      if (chromeStrikes >= 3 && result.status === 'failed') chromeStrikes = 0;
      await heartbeat();
      if (once) return result;
    } else if (once) {
      log('queue empty');
      return { status: 'empty' };
    }
    if (Date.now() - lastBeat > 30_000) { await heartbeat(); lastBeat = Date.now(); }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

async function shutdown(code = 0) {
  for (const client of clients.values()) await client.close().catch(() => {});
  process.exit(code);
}

const [command = 'run', arg] = process.argv.slice(2);
try {
  if (command === 'status') {
    const status = parseToolResult(await callTool({ id: 'cli', profileDir: arg }, 'flow_status', {}));
    console.log(JSON.stringify(status));
    await shutdown(0);
  } else if (command === 'login') {
    const child = spawn(process.execPath, [join(FLOW_MCP_DIR, 'dist', 'login.js')], {
      stdio: 'inherit', env: { ...env, ...(arg ? { FLOW_PROFILE_DIR: arg } : {}) }
    });
    child.on('exit', code => process.exit(code ?? 0));
  } else if (command === 'once' || command === 'run') {
    process.on('SIGINT', () => void shutdown(0));
    process.on('SIGTERM', () => void shutdown(0));
    const result = await loop(command === 'once');
    console.log(JSON.stringify(result));
    await shutdown(result?.status === 'failed' ? 1 : 0);
  } else {
    console.error('usage: bridge.mjs run|once|status <profileDir>|login <profileDir>');
    process.exit(2);
  }
} catch (error) {
  log('fatal:', error.message);
  await shutdown(1);
}
