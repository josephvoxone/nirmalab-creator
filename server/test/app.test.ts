import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-data-'));
  const webDist = mkdtempSync(join(tmpdir(), 'nc-web-'));
  mkdirSync(join(webDist, 'assets'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(webDist, 'assets', 'app.js'), 'console.log(1)');
  return { dataDir, webDist };
}

async function app() {
  const f = fixture();
  return buildApp({ ...f, env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' }, logger: false });
}

async function login(server: Awaited<ReturnType<typeof app>>) {
  const res = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

describe('buildApp', () => {
  it('health is public and reports the build', async () => {
    const server = await app();
    const res = await server.inject('/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, app: 'shotweave-studio' });
  });

  it('auth lives under /api/auth and protects the modules', async () => {
    const server = await app();
    expect((await server.inject('/api/auth/me')).statusCode).toBe(401);
    expect((await server.inject('/api/flow/jobs')).statusCode).toBe(401);
    expect((await server.inject('/api/generate/status')).statusCode).toBe(401);
    expect((await server.inject('/api/publish/status')).statusCode).toBe(401);
    const cookie = await login(server);
    expect((await server.inject({ url: '/api/auth/me', headers: { cookie } })).json().user.email).toBe('admin@x.io');
    expect((await server.inject({ url: '/api/flow/jobs', headers: { cookie } })).statusCode).toBe(200);
  });

  it('bridge routes need the bridge token, not a session', async () => {
    const server = await app();
    const res = await server.inject({ method: 'POST', url: '/api/flow/bridge/claim', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('serves the SPA with clean-URL fallback, but unknown API paths stay JSON 404', async () => {
    const server = await app();
    const page = await server.inject('/studio');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain('id="root"');
    expect((await server.inject('/join/abc')).body).toContain('id="root"');
    const asset = await server.inject('/assets/app.js');
    expect(asset.statusCode).toBe(200);
    const api = await server.inject('/api/nope');
    expect(api.statusCode).toBe(404);
    expect(api.headers['content-type']).toMatch(/json/);
    expect((await server.inject('/assets/missing.js')).statusCode).toBe(404);
  });

  it('sends basic security headers', async () => {
    const server = await app();
    const res = await server.inject('/studio');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('same-origin');
  });
});
