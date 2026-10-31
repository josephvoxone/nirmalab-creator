/**
 * F5 — the login rate limit must key on an IP the client cannot choose.
 * `clientIp` used to take the FIRST element of the raw X-Forwarded-For (written by the client), so rotating
 * the header gave unlimited attempts. The key is now Fastify's `request.ip` with `trustProxy` = a number of
 * trusted hops (env TRUST_PROXY_HOPS, default 1): only the entries the trusted proxies themselves appended count.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loginAttemptCount } from '../src/auth/routes.js';

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

const TRAEFIK = '172.18.0.5';
const CLOUDFLARE = '172.70.34.9';
const uniq = () => Math.random().toString(16).slice(2, 10);

async function appWith(extra: { trustProxyHops?: number; env?: NodeJS.ProcessEnv } = {}) {
  const adminEmail = `admin-${uniq()}@x.io`;
  const server = await buildApp({
    dataDir: mkdtempSync(join(tmpdir(), 'nc-sec-ip-')),
    env: { OPENCREATOR_ADMIN_EMAIL: adminEmail, OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1', ...(extra.env ?? {}) },
    ...(extra.trustProxyHops !== undefined ? { trustProxyHops: extra.trustProxyHops } : {}),
    stories: { reconcileMs: 0 }, providers: { workerMs: 0 }, media: { cleanupMs: 0 }, dub: { resume: false }
  });
  apps.push(server);
  return { server, adminEmail };
}

const wrongLogin = (server: App, email: string, remoteAddress: string, xff?: string) => server.inject({
  method: 'POST', url: '/api/auth/login', remoteAddress,
  ...(xff ? { headers: { 'x-forwarded-for': xff } } : {}),
  payload: { email, password: 'definitely-wrong-1' }
}).then(res => res.statusCode);

async function adminIp(server: App, adminEmail: string, remoteAddress: string, xff?: string) {
  const login = await server.inject({ method: 'POST', url: '/api/auth/login', remoteAddress, payload: { email: adminEmail, password: 'admin-pass-1' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const res = await server.inject({ url: '/api/auth/client-ip', remoteAddress, headers: { cookie, ...(xff ? { 'x-forwarded-for': xff } : {}) } });
  return { status: res.statusCode, body: res.json() as { ip: string; hops: number } };
}

describe('F5 login rate limit key', () => {
  it('PoC from the audit: 40 wrong logins with a rotating X-Forwarded-For from one TCP peer → 429 from the 11th (no trusted proxy)', async () => {
    const { server } = await appWith({ trustProxyHops: 0 });
    const email = `victim-${uniq()}@x.io`;
    const codes: number[] = [];
    for (let i = 0; i < 40; i += 1) codes.push(await wrongLogin(server, email, '203.0.113.50', `198.51.100.${i + 1}`));
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(codes.slice(10)).toEqual(Array(30).fill(429));
  }, 60_000);

  it('2-hop chain (client, Cloudflare, Traefik as peer): a forged prefix rotated on every try does not change the key', async () => {
    const { server } = await appWith({ trustProxyHops: 2 });
    const email = `victim-${uniq()}@x.io`;
    const codes: number[] = [];
    // Cloudflare appends the real client to whatever the attacker sent; Traefik appends Cloudflare.
    for (let i = 0; i < 40; i += 1) codes.push(await wrongLogin(server, email, TRAEFIK, `10.${i}.${i}.1, 198.51.100.7, ${CLOUDFLARE}`));
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(codes.slice(10)).toEqual(Array(30).fill(429));
  }, 60_000);

  it('2-hop chain: the real client IP (first IP, then Cloudflare) is the one read, not Cloudflare and not a forged entry', async () => {
    const { server, adminEmail } = await appWith({ trustProxyHops: 2 });
    const got = await adminIp(server, adminEmail, TRAEFIK, `66.66.66.66, 198.51.100.7, ${CLOUDFLARE}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ ip: '198.51.100.7', hops: 2 });
  });

  it('a PUBLIC client that sends a long chain itself cannot borrow trust (Fastify 5 refuses bare hop counts for this reason)', async () => {
    const { server, adminEmail } = await appWith({ trustProxyHops: 2 });
    const direct = await adminIp(server, adminEmail, '203.0.113.77', '66.66.66.66, 55.55.55.55');
    expect(direct.body.ip).toBe('203.0.113.77');
    const email = `victim-${uniq()}@x.io`;
    const codes: number[] = [];
    for (let i = 0; i < 15; i += 1) codes.push(await wrongLogin(server, email, '203.0.113.78', `10.0.${i}.1, 10.1.${i}.1`));
    expect(codes.slice(10)).toEqual(Array(5).fill(429));
  }, 60_000);

  it('default is ONE trusted hop (Traefik always fronts the app): a forged prefix cannot choose the key even through Cloudflare', async () => {
    const { server, adminEmail } = await appWith();
    expect((await adminIp(server, adminEmail, TRAEFIK, `66.66.66.66, 198.51.100.7, ${CLOUDFLARE}`)).body).toMatchObject({ ip: CLOUDFLARE, hops: 1 });
    const email = `victim-${uniq()}@x.io`;
    const codes: number[] = [];
    for (let i = 0; i < 20; i += 1) codes.push(await wrongLogin(server, email, TRAEFIK, `10.${i}.${i}.1, 198.51.100.${i + 1}, ${CLOUDFLARE}`));
    // The key is the Cloudflare address here, so rotating the "real" client part does not help either: the limit is still hit.
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(codes.slice(10)).toEqual(Array(10).fill(429));
  }, 60_000);

  it('does not lock everyone together: another real client (same Cloudflare edge) and another email keep logging in', async () => {
    const { server } = await appWith({ trustProxyHops: 2 });
    const shared = `shared-${uniq()}@x.io`;
    const other = `other-${uniq()}@x.io`;
    const chainOf = (real: string) => `${real}, ${CLOUDFLARE}`;
    for (let i = 0; i < 11; i += 1) await wrongLogin(server, shared, TRAEFIK, chainOf('198.51.100.1'));
    expect(await wrongLogin(server, shared, TRAEFIK, chainOf('198.51.100.1'))).toBe(429);
    // A different person on the same Cloudflare edge address, same account: own counter, not blocked.
    expect(await wrongLogin(server, shared, TRAEFIK, chainOf('198.51.100.2'))).toBe(401);
    // The first person trying another account is not blocked either (the key is ip + email).
    expect(await wrongLogin(server, other, TRAEFIK, chainOf('198.51.100.1'))).toBe(401);
  }, 60_000);

  it('TRUST_PROXY_HOPS env sets the hop count; garbage falls back to the safe default instead of trusting more', async () => {
    const { server, adminEmail } = await appWith({ env: { TRUST_PROXY_HOPS: '2' } });
    expect((await adminIp(server, adminEmail, TRAEFIK, `198.51.100.7, ${CLOUDFLARE}`)).body).toMatchObject({ ip: '198.51.100.7', hops: 2 });
    for (const bad of ['abc', '-1', '1.5', '99', 'true', '']) {
      const t = await appWith({ env: { TRUST_PROXY_HOPS: bad } });
      expect((await adminIp(t.server, t.adminEmail, TRAEFIK, `198.51.100.7, ${CLOUDFLARE}`)).body.hops, `TRUST_PROXY_HOPS=${bad}`).toBe(1);
    }
    const zero = await appWith({ env: { TRUST_PROXY_HOPS: '0' } });
    expect((await adminIp(zero.server, zero.adminEmail, '203.0.113.9', '1.2.3.4')).body).toMatchObject({ ip: '203.0.113.9', hops: 0 });
  }, 60_000);

  it('the client-ip diagnostic is admin only', async () => {
    const { server } = await appWith();
    expect((await server.inject({ url: '/api/auth/client-ip' })).statusCode).toBe(401);
  });

  it('the attempt table does not grow without bound under many different keys', async () => {
    const { server } = await appWith({ trustProxyHops: 0 });
    for (let i = 0; i < 6000; i += 1) {
      await server.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.60', payload: { email: `x${i}-${uniq()}@x.io`, password: 'a' } });
    }
    expect(loginAttemptCount()).toBeLessThanOrEqual(5100);
  }, 120_000);
});
