/** F9 — session cookie `Secure` behind HTTPS, and one constant-time comparison path for session/invite token hashes. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { UserAuthStore } from '../src/auth/store.js';

vi.mock('node:crypto', async importOriginal => {
  const mod = await importOriginal<typeof import('node:crypto')>();
  return { ...mod, timingSafeEqual: vi.fn(mod.timingSafeEqual) };
});
const crypto = await import('node:crypto');
const tse = vi.mocked(crypto.timingSafeEqual);

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });
const uniq = () => Math.random().toString(16).slice(2, 10);

async function appWith(env: NodeJS.ProcessEnv = {}) {
  const email = `admin-${uniq()}@x.io`;
  const server = await buildApp({
    dataDir: mkdtempSync(join(tmpdir(), 'nc-sec-cookie-')),
    env: { OPENCREATOR_ADMIN_EMAIL: email, OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1', ...env },
    stories: { reconcileMs: 0 }, providers: { workerMs: 0 }, media: { cleanupMs: 0 }, dub: { resume: false }
  });
  apps.push(server);
  const login = (headers: Record<string, string> = {}, remoteAddress = '172.18.0.5') => server.inject({
    method: 'POST', url: '/api/auth/login', remoteAddress, headers, payload: { email, password: 'admin-pass-1' }
  });
  return { server, email, login };
}
const setCookie = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']);

describe('F9 Secure session cookie', () => {
  it('login behind the HTTPS edge (X-Forwarded-Proto: https from the proxy) sets Secure, keeping HttpOnly + SameSite=Lax', async () => {
    const { login } = await appWith();
    const cookie = setCookie(await login({ 'x-forwarded-proto': 'https' }));
    expect(cookie).toMatch(/; Secure(;|$)/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });

  it('plain http (local dev, no proxy header) does not get Secure, so login still works there', async () => {
    const { login } = await appWith();
    expect(setCookie(await login())).not.toMatch(/Secure/);
  });

  it('a public client cannot make the app think it is https by sending the header itself', async () => {
    const { login } = await appWith();
    expect(setCookie(await login({ 'x-forwarded-proto': 'https' }, '203.0.113.9'))).not.toMatch(/Secure/);
  });

  it('COOKIE_SECURE=1 forces it, COOKIE_SECURE=0 turns it off', async () => {
    const on = await appWith({ COOKIE_SECURE: '1' });
    expect(setCookie(await on.login())).toMatch(/; Secure(;|$)/);
    const off = await appWith({ COOKIE_SECURE: '0' });
    expect(setCookie(await off.login({ 'x-forwarded-proto': 'https' }))).not.toMatch(/Secure/);
  });

  it('logout and invite-accept use the same attributes', async () => {
    const { server, login } = await appWith();
    const https = { 'x-forwarded-proto': 'https' };
    const cookie = setCookie(await login(https)).split(';')[0]!;
    const out = await server.inject({ method: 'POST', url: '/api/auth/logout', remoteAddress: '172.18.0.5', headers: { ...https, cookie } });
    expect(setCookie(out)).toMatch(/; Secure(;|$)/);
    expect(setCookie(out)).toContain('Max-Age=0');
    const adminCookie = setCookie(await login(https)).split(';')[0]!;
    const invite = (await server.inject({ method: 'POST', url: '/api/auth/invites', remoteAddress: '172.18.0.5', headers: { ...https, cookie: adminCookie, 'content-type': 'application/json' }, payload: '{}' })).json();
    const accept = await server.inject({ method: 'POST', url: '/api/auth/invites/accept', remoteAddress: '172.18.0.5', headers: https, payload: { token: invite.token, email: `m-${uniq()}@x.io`, password: 'member-pass-1' } });
    expect(accept.statusCode).toBe(200);
    expect(setCookie(accept)).toMatch(/; Secure(;|$)/);
  });
});

describe('F9 constant-time token hash comparison', () => {
  const store = async () => {
    const s = new UserAuthStore(mkdtempSync(join(tmpdir(), 'nc-sec-tse-')));
    const user = await s.createUser({ email: `a-${uniq()}@x.io`, password: 'admin-pass-1', isAdmin: true });
    return { s, user };
  };

  it('resolveSession compares every stored session with timingSafeEqual (no early exit), match or one-character miss', async () => {
    const { s, user } = await store();
    const a = s.createSession(user.id).token;
    const b = s.createSession(user.id).token;
    s.createSession(user.id);
    tse.mockClear();
    expect(s.resolveSession(b)).toMatchObject({ id: user.id });
    expect(tse).toHaveBeenCalledTimes(3);
    expect(tse.mock.calls.every(([x, y]) => x.byteLength === 32 && y.byteLength === 32)).toBe(true);
    tse.mockClear();
    const off = a.slice(0, -1) + (a.endsWith('A') ? 'B' : 'A');
    expect(s.resolveSession(off)).toBeUndefined();
    expect(tse).toHaveBeenCalledTimes(3);
  });

  it('expired sessions still never resolve', async () => {
    const { s, user } = await store();
    const { token } = s.createSession(user.id);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31 * 24 * 3600 * 1000);
    expect(s.resolveSession(token)).toBeUndefined();
    vi.useRealTimers();
  });

  it('destroySession, peekInvite and acceptInvite use it too', async () => {
    const { s, user } = await store();
    const { token } = s.createSession(user.id);
    s.createSession(user.id);
    tse.mockClear();
    s.destroySession(token);
    expect(tse).toHaveBeenCalledTimes(2);
    expect(s.resolveSession(token)).toBeUndefined();
    const invite = s.createInvite({ createdBy: user.id });
    s.createInvite({ createdBy: user.id });
    tse.mockClear();
    expect(s.peekInvite(invite.token)).toBeTruthy();
    expect(tse).toHaveBeenCalledTimes(2);
    tse.mockClear();
    await s.acceptInvite({ token: invite.token, email: `i-${uniq()}@x.io`, password: 'member-pass-1' });
    expect(tse.mock.calls.length).toBeGreaterThanOrEqual(2);
    await expect(s.acceptInvite({ token: invite.token, email: 'z@x.io', password: 'member-pass-1' })).rejects.toThrow();
  });
});
