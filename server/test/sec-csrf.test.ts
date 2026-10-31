/**
 * F6 — CSRF second layer: a state-changing request that carries the session cookie AND says it comes from
 * another site (Origin of another host / Sec-Fetch-Site cross-site|same-site) is refused with 403 before any
 * route runs. Clients that send no Origin (curl, MCP Bearer, the Flow bridge) are untouched.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

type App = Awaited<ReturnType<typeof buildApp>>;
let server: App;
let cookie: string;
let adminId: string;
const HOST = 'creator.example.com';
const BRIDGE = 'b'.repeat(40);
const uniq = () => Math.random().toString(16).slice(2, 10);

async function make(env: NodeJS.ProcessEnv = {}) {
  const email = `admin-${uniq()}@x.io`;
  const app = await buildApp({
    dataDir: mkdtempSync(join(tmpdir(), 'nc-sec-csrf-')),
    env: { OPENCREATOR_ADMIN_EMAIL: email, OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1', OPENCREATOR_FLOW_BRIDGE_TOKEN: BRIDGE, ...env },
    stories: { reconcileMs: 0 }, providers: { workerMs: 0 }, media: { cleanupMs: 0 }, dub: { resume: false }
  });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: HOST }, payload: { email, password: 'admin-pass-1' } });
  expect(login.statusCode).toBe(200);
  return { app, cookie: String(login.headers['set-cookie']).split(';')[0]!, adminId: login.json().user.id as string };
}

beforeAll(async () => { ({ app: server, cookie, adminId } = await make()); });
afterAll(async () => { await server?.close(); });

const post = (headers: Record<string, string>, url = '/api/auth/invites', method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'POST') =>
  server.inject({ method, url, headers: { host: HOST, 'content-type': 'application/json', ...headers }, payload: method === 'DELETE' ? undefined : JSON.stringify({}) });
const invites = async () => (await server.inject({ url: '/api/auth/invites', headers: { cookie, host: HOST } })).json().invites.length as number;

describe('F6 cross-site guard on state-changing requests', () => {
  it('PoC from the audit: a cross-site Origin with the real admin cookie is refused (403) and nothing is created', async () => {
    const before = await invites();
    const res = await post({ cookie, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CROSS_SITE');
    expect(await invites()).toBe(before);
  });

  it('every mutating method is guarded', async () => {
    for (const [method, url] of [['POST', '/api/auth/invites'], ['PUT', '/api/providers/text'], ['PATCH', `/api/auth/members/${adminId}`], ['DELETE', `/api/auth/members/${adminId}`]] as const) {
      const res = await post({ cookie, origin: 'https://evil.example' }, url, method);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('refuses Sec-Fetch-Site cross-site and same-site without any Origin (a sibling subdomain can send the cookie too)', async () => {
    expect((await post({ cookie, 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await post({ cookie, 'sec-fetch-site': 'same-site' })).statusCode).toBe(403);
  });

  it('refuses Origin: null and a malformed Origin', async () => {
    expect((await post({ cookie, origin: 'null' })).statusCode).toBe(403);
    expect((await post({ cookie, origin: 'not a url' })).statusCode).toBe(403);
  });

  it('refuses a lookalike host (suffix/prefix tricks)', async () => {
    for (const origin of [`https://${HOST}.evil.example`, `https://evil-${HOST}`, `https://x.${HOST}`, `https://${HOST}:8443`]) {
      expect((await post({ cookie, origin })).statusCode, origin).toBe(403);
    }
  });

  it('refuses when the Origin matches but the browser says cross-site (the header the page cannot forge wins)', async () => {
    expect((await post({ cookie, origin: `https://${HOST}`, 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
  });

  it('allows the app itself: same Origin (with or without default port), Sec-Fetch-Site same-origin / none', async () => {
    expect((await post({ cookie, origin: `https://${HOST}`, 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    expect((await post({ cookie, origin: `https://${HOST}:443` })).statusCode).toBe(200);
    expect((await post({ cookie, origin: `http://${HOST}` })).statusCode).toBe(200);
    expect((await post({ cookie, 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    expect((await post({ cookie, 'sec-fetch-site': 'none' })).statusCode).toBe(200);
  });

  it('allows clients that send no Origin and no Sec-Fetch-Site even with the cookie (curl, scripts)', async () => {
    expect((await post({ cookie })).statusCode).toBe(200);
  });

  it('behind the proxy: the public host arrives in X-Forwarded-Host (trusted hop) and still matches', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/auth/invites', remoteAddress: '172.18.0.5',
      headers: { host: 'app:3000', 'x-forwarded-host': HOST, cookie, origin: `https://${HOST}`, 'content-type': 'application/json' }, payload: '{}' });
    expect(res.statusCode).toBe(200);
    // The same header from a PUBLIC peer is not believed, so the Origin no longer matches the (internal) Host.
    const spoof = await server.inject({ method: 'POST', url: '/api/auth/invites', remoteAddress: '203.0.113.9',
      headers: { host: 'app:3000', 'x-forwarded-host': HOST, cookie, origin: `https://${HOST}`, 'content-type': 'application/json' }, payload: '{}' });
    expect(spoof.statusCode).toBe(403);
  });

  it('does not touch requests without the session cookie: Bearer MCP and the bridge token with a foreign Origin', async () => {
    const mcp = await server.inject({ method: 'POST', url: '/mcp', headers: { host: HOST, origin: 'https://evil.example', authorization: 'Bearer nope', 'content-type': 'application/json' }, payload: '{}' });
    expect(mcp.statusCode).toBe(401); // reached the MCP auth, was not stopped by the guard
    const bridge = await server.inject({ method: 'POST', url: '/api/flow/bridge/claim', headers: { host: HOST, origin: 'https://evil.example', 'x-flow-bridge-token': BRIDGE, 'content-type': 'application/json' }, payload: '{}' });
    expect(bridge.statusCode).not.toBe(403);
    expect(bridge.statusCode).not.toBe(401);
    const anon = await server.inject({ method: 'POST', url: '/api/auth/login', headers: { host: HOST, origin: 'https://evil.example', 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'nobody@x.io', password: 'wrong-wrong-1' }) });
    expect(anon.statusCode).toBe(401);
  });

  it('reads are never blocked', async () => {
    const res = await server.inject({ url: '/api/auth/me', headers: { host: HOST, cookie, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
    expect(res.statusCode).toBe(200);
  });

  it('ALLOWED_ORIGINS lists extra trusted origins (a dev server on another port); others stay refused', async () => {
    const t = await make({ ALLOWED_ORIGINS: 'http://localhost:5173, https://studio.example.com' });
    const send = (origin: string) => t.app.inject({ method: 'POST', url: '/api/auth/invites', headers: { host: HOST, cookie: t.cookie, origin, 'content-type': 'application/json' }, payload: '{}' });
    expect((await send('http://localhost:5173')).statusCode).toBe(200);
    expect((await send('https://studio.example.com')).statusCode).toBe(200);
    expect((await send('https://evil.example')).statusCode).toBe(403);
    await t.app.close();
  });
});

