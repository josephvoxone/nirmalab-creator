import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { installPolicyGuard, ROUTE_POLICY, routeKey, type Policy } from '../src/tenancy/policy.js';

const POLICIES: Policy[] = ['PUBLIK', 'PENGGUNA-PEMILIK', 'PENGGUNA-BERSAMA', 'SISTEM-ADMIN', 'BRIDGE-TOKEN', 'MCP-TOKEN'];
const ENV = { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' };

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-pol-data-'));
  const webDist = mkdtempSync(join(tmpdir(), 'nc-pol-web-'));
  mkdirSync(join(webDist, 'assets'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(webDist, 'assets', 'app.js'), 'console.log(1)');
  // Production's dist has more loose files: each one becomes a static GET route (fastify-static wildcard:false).
  writeFileSync(join(webDist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return { dataDir, webDist };
}

type Seen = { method: string; url: string };

async function liveApp(extra: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const seen: Seen[] = [];
  const server = await buildApp({
    ...fixture(), env: ENV, logger: false,
    stories: { reconcileMs: 0 }, providers: { workerMs: 0 }, dub: { resume: false }, media: { cleanupMs: 0 },
    onRoute: r => { for (const method of [r.method].flat()) seen.push({ method, url: r.url }); },
    ...extra
  });
  return { server, seen };
}

const appRoutes = (seen: Seen[]) => seen.filter(r => r.method !== 'HEAD' && r.method !== 'OPTIONS');
const fill = (url: string) => url.replace(/:[A-Za-z]+/g, 'x').replace('*', 'x');

describe('T0 route policy registry', () => {
  it('lists exactly the routes the app registers (no missing, no stale entries), wave 1 included', async () => {
    const { server, seen } = await liveApp();
    await server.close();
    const live = appRoutes(seen).map(r => routeKey(r.method, r.url));
    // The static plugin registers each loose dist file: those are covered by the PUBLIK static scope, not by name.
    const named = live.filter(k => !/^GET \/(index\.html|favicon\.svg|assets\/app\.js)$/.test(k));
    const registry = Object.keys(ROUTE_POLICY).filter(k => !/^GET \/(index\.html|favicon\.svg)$/.test(k));
    expect(registry.length).toBeGreaterThan(100);
    expect(named.filter(k => !(k in ROUTE_POLICY)).sort()).toEqual([]);
    expect(registry.filter(k => !named.includes(k)).sort()).toEqual([]);
    for (const wave1 of ['POST /api/flow/jobs/:id/cancel', 'POST /api/stories/:id/motion-check', 'GET /api/auth/client-ip']) {
      expect(ROUTE_POLICY[wave1], wave1).toBeDefined();
      expect(live).toContain(wave1);
    }
  });

  it('every entry uses one of the six policies; owned routes name their resource', () => {
    for (const [key, entry] of Object.entries(ROUTE_POLICY)) {
      expect(POLICIES, key).toContain(entry.policy);
      if (entry.policy === 'PENGGUNA-PEMILIK') expect(entry.resource, key).toBeDefined();
    }
    const count = (p: Policy) => Object.values(ROUTE_POLICY).filter(e => e.policy === p).length;
    expect([count('PUBLIK'), count('PENGGUNA-PEMILIK'), count('PENGGUNA-BERSAMA'), count('SISTEM-ADMIN'), count('BRIDGE-TOKEN'), count('MCP-TOKEN')]).toEqual([12, 61, 6, 50, 5, 1]);   // 36 + 5 wave-2 quota/key-activation routes + 9 T8 admin-console routes (all SISTEM-ADMIN, metadata/numbers only)
  });

  it('fail-closed: a route nobody registered a policy for stops the server from booting', async () => {
    // At the root Fastify throws while the route is added; inside a plugin it rejects ready(): either way nothing boots.
    const bootWith = async (register: (server: ReturnType<typeof Fastify>) => void) => {
      const plain = Fastify();
      installPolicyGuard(plain);
      try { register(plain); await plain.ready(); return 'booted'; } catch (error) { return (error as Error).message; }
    };
    expect(await bootWith(s => { s.get('/api/zz', async () => ({ ok: true })); })).toContain('Rute tanpa kebijakan: GET /api/zz');
    expect(await bootWith(s => { void s.register(async scoped => { scoped.post('/zz/:id', async () => ({ ok: true })); }, { prefix: '/api' }); })).toContain('Rute tanpa kebijakan: POST /api/zz/:id');
  });

  it('fail-closed: the real app refuses to boot when its registry misses a live route', async () => {
    const registry = { ...ROUTE_POLICY };
    delete registry['GET /api/health'];
    const outcome = await buildApp({ ...fixture(), env: ENV, logger: false, stories: { reconcileMs: 0 }, providers: { workerMs: 0 }, dub: { resume: false }, media: { cleanupMs: 0 }, tenancy: { policyRegistry: registry } })
      .then(() => 'booted', (error: Error) => error.message);
    expect(outcome).toContain('Rute tanpa kebijakan: GET /api/health');
  });

  it('a route may carry its own config.policy (static plugin scope) and HEAD/OPTIONS twins are not asked for a policy', async () => {
    const plain = Fastify();
    installPolicyGuard(plain, { registry: {} });
    plain.get('/own', { config: { policy: 'PUBLIK' } }, async () => ({ ok: true }));
    await plain.ready();
    expect((await plain.inject('/own')).statusCode).toBe(200);
    expect((await plain.inject({ method: 'HEAD', url: '/own' })).statusCode).toBe(200);
  });

  it('behaviour is unchanged: the guard reports an open non-public route but still answers as before', async () => {
    const findings: Array<{ key: string; policy: string; status: number }> = [];
    const plain = Fastify();
    installPolicyGuard(plain, { registry: { 'GET /open': { policy: 'SISTEM-ADMIN' }, 'GET /pub': { policy: 'PUBLIK' } }, report: f => findings.push(f) });
    plain.get('/open', async () => ({ leaked: true }));
    plain.get('/pub', async () => ({ ok: true }));
    await plain.ready();
    const open = await plain.inject('/open');
    expect(open.statusCode).toBe(200);
    expect(open.json()).toEqual({ leaked: true });
    expect((await plain.inject('/pub')).statusCode).toBe(200);
    expect(findings).toEqual([{ key: 'GET /open', policy: 'SISTEM-ADMIN', status: 200 }]);
  });

  it('every non-public route answers an anonymous caller with 401 (the registry matches today\'s guards; nothing reports)', async () => {
    const findings: unknown[] = [];
    const { server, seen } = await liveApp({ tenancy: { report: f => findings.push(f) } });
    const wrong: string[] = [];
    let probed = 0;
    for (const r of appRoutes(seen)) {
      const key = routeKey(r.method, r.url);
      const entry = ROUTE_POLICY[key];
      if (!entry || entry.policy === 'PUBLIK' || entry.policy === 'MCP-TOKEN' && key !== 'POST /mcp') continue;
      const res = await server.inject({ method: r.method as 'GET', url: fill(r.url), ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { payload: {} }) });
      probed += 1;
      if (res.statusCode !== 401) wrong.push(`${key} → ${res.statusCode}`);
    }
    await server.close();
    expect(probed).toBeGreaterThan(95);
    expect(wrong).toEqual([]);
    expect(findings).toEqual([]);
  });

  it('static dist files (every loose file of web/dist) need no registry entry and the SPA still loads', async () => {
    const { server } = await liveApp();
    expect((await server.inject('/favicon.svg')).statusCode).toBe(200);
    expect((await server.inject('/assets/app.js')).statusCode).toBe(200);
    expect((await server.inject('/studio')).statusCode).toBe(200);
    await server.close();
  });
});
