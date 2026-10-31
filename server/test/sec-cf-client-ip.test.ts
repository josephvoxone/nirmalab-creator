/**
 * F5b — found on PRODUCTION after wave 1: behind Cloudflare → Traefik the app sees X-Forwarded-For = a Cloudflare EDGE
 * address (it differs from request to request), so a rate limit keyed on it never reaches its cap (14 wrong logins → 14×401).
 * The real visitor is in `CF-Connecting-IP`, trusted ONLY when the connection really came from a Cloudflare range
 * (otherwise a direct hit on the origin could forge it).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { isCloudflarePeer, resolveClientIp } from '../src/auth/proxy.js';

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });
const TRAEFIK = '10.0.1.4';
const uniq = () => Math.random().toString(16).slice(2, 10);

async function app() {
  const adminEmail = `admin-${uniq()}@x.io`;
  const server = await buildApp({
    dataDir: mkdtempSync(join(tmpdir(), 'nc-sec-cf-')),
    env: { OPENCREATOR_ADMIN_EMAIL: adminEmail, OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
    stories: { reconcileMs: 0 }, providers: { workerMs: 0 }, media: { cleanupMs: 0 }, dub: { resume: false }
  });
  apps.push(server);
  return { server, adminEmail };
}
const wrong = (server: App, email: string, headers: Record<string, string>) => server.inject({
  method: 'POST', url: '/api/auth/login', remoteAddress: TRAEFIK, headers, payload: { email, password: 'definitely-wrong-1' }
}).then(r => r.statusCode);
const EDGES = ['172.70.208.152', '162.158.108.35', '104.23.170.5', '172.71.2.9', '108.162.226.40', '141.101.76.3', '188.114.97.2'];

describe('isCloudflarePeer', () => {
  it('knows the published Cloudflare ranges (v4 and v6) and nothing else', () => {
    for (const ip of ['172.70.208.152', '162.158.108.35', '104.23.170.5', '173.245.48.9', '2606:4700::6810:1', '2a06:98c0::1']) expect(isCloudflarePeer(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '203.0.113.9', '10.0.1.4', '2001:db8::1', '172.72.0.1', 'not-an-ip', '']) expect(isCloudflarePeer(ip), ip).toBe(false);
  });
});

describe('resolveClientIp', () => {
  it('uses CF-Connecting-IP only when the resolved peer is a Cloudflare address and the value is an IP', () => {
    expect(resolveClientIp('172.70.208.152', '203.0.113.9')).toBe('203.0.113.9');
    expect(resolveClientIp('172.70.208.152', ['203.0.113.9', '1.1.1.1'])).toBe('203.0.113.9');
    expect(resolveClientIp('198.51.100.7', '203.0.113.9')).toBe('198.51.100.7');     // direct hit on the origin: forged header ignored
    expect(resolveClientIp('172.70.208.152', 'not-an-ip')).toBe('172.70.208.152');
    expect(resolveClientIp('172.70.208.152', undefined)).toBe('172.70.208.152');
  });
});

describe('F5b login rate limit behind Cloudflare', () => {
  it('PoC from production: wrong logins whose Cloudflare edge address changes every time, same visitor → 429 from the 11th', async () => {
    const { server } = await app();
    const email = `victim-${uniq()}@x.io`;
    const codes: number[] = [];
    for (let i = 0; i < 14; i += 1) codes.push(await wrong(server, email, { 'x-forwarded-for': EDGES[i % EDGES.length]!, 'cf-connecting-ip': '203.0.113.9' }));
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(codes.slice(10)).toEqual(Array(4).fill(429));
  }, 60_000);

  it('another visitor on the same edge is not locked out with them', async () => {
    const { server } = await app();
    const email = `victim-${uniq()}@x.io`;
    for (let i = 0; i < 12; i += 1) await wrong(server, email, { 'x-forwarded-for': EDGES[0]!, 'cf-connecting-ip': '203.0.113.9' });
    expect(await wrong(server, email, { 'x-forwarded-for': EDGES[0]!, 'cf-connecting-ip': '203.0.113.77' })).toBe(401);
  }, 60_000);

  it('a direct hit on the origin cannot choose its key with a forged CF-Connecting-IP (peer is not Cloudflare)', async () => {
    const { server } = await app();
    const email = `victim-${uniq()}@x.io`;
    const codes: number[] = [];
    for (let i = 0; i < 14; i += 1) codes.push(await wrong(server, email, { 'x-forwarded-for': '198.51.100.7', 'cf-connecting-ip': `203.0.113.${i + 1}` }));
    expect(codes.slice(10)).toEqual(Array(4).fill(429));
  }, 60_000);

  it('a malformed CF-Connecting-IP falls back to the edge address and does not crash', async () => {
    const { server } = await app();
    expect(await wrong(server, `victim-${uniq()}@x.io`, { 'x-forwarded-for': EDGES[0]!, 'cf-connecting-ip': 'garbage' })).toBe(401);
  });

  it('the admin diagnostic shows the visitor address and that Cloudflare was recognised', async () => {
    const { server, adminEmail } = await app();
    const login = await server.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: TRAEFIK, payload: { email: adminEmail, password: 'admin-pass-1' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const res = await server.inject({ url: '/api/auth/client-ip', remoteAddress: TRAEFIK, headers: { cookie, 'x-forwarded-for': EDGES[0]!, 'cf-connecting-ip': '203.0.113.9' } });
    expect(res.json()).toMatchObject({ ip: '203.0.113.9', edge: EDGES[0], viaCloudflare: true });
  });
});
