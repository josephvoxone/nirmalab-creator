import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { UserAuthStore } from '../src/auth/store.js';
import { registerFlowRoutes } from '../src/flow/routes.js';
import { FlowStore } from '../src/flow/store.js';

const BRIDGE_TOKEN = 'bridge-token-0123456789abcdef';
let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'flow-pool-routes-'));
  const store = new FlowStore(join(dataDir, 'flow'));
  const auth = new UserAuthStore(mkdtempSync(join(tmpdir(), 'flow-auth-')));
  const admin = await auth.createUser({ email: 'admin@x.io', password: 'admin-pass-1', isAdmin: true });
  const member = await auth.createUser({ email: 'member@x.io', password: 'member-pass-1', isAdmin: false });
  const adminCookie = `oc_session=${auth.createSession(admin.id).token}`;
  const memberCookie = `oc_session=${auth.createSession(member.id).token}`;
  server = Fastify();
  await registerFlowRoutes(server, { userAuthStore: auth, dataDir, bridgeToken: BRIDGE_TOKEN, store });
  await server.ready();
  return { store, admin, member, adminCookie, memberCookie };
}

const req = (method: 'GET' | 'PUT' | 'PATCH' | 'POST', url: string, cookie?: string, payload?: unknown) =>
  server!.inject({ method, url, ...(cookie ? { headers: { cookie } } : {}), ...(payload === undefined ? {} : { payload: payload as object }) });

describe('pool management routes are admin only', () => {
  it.each([
    ['PATCH', '/api/flow/accounts/acc_x', { enabled: false }],
    ['GET', '/api/flow/pool', undefined],
    ['PUT', '/api/flow/pool', { rotation: 'priority' }],
    ['GET', '/api/flow/usage', undefined]
  ] as const)('%s %s: 401 anonymous, 403 member', async (method, url, payload) => {
    const { memberCookie } = await setup();
    expect((await req(method, url, undefined, payload)).statusCode).toBe(401);
    expect((await req(method, url, memberCookie, payload)).statusCode).toBe(403);
  });
});

describe('PATCH /api/flow/accounts/:id', () => {
  it('updates enabled/priority/cap/label and clears the cap with null', async () => {
    const { store, adminCookie } = await setup();
    const a = await store.addAccount({ label: 'A', email: 'a@x' });
    const res = await req('PATCH', `/api/flow/accounts/${a.id}`, adminCookie, { label: 'Utama', enabled: false, priority: 2, dailyCreditCap: 150 });
    expect(res.statusCode).toBe(200);
    expect(res.json().account).toMatchObject({ id: a.id, label: 'Utama', enabled: false, priority: 2, dailyCreditCap: 150 });
    const cleared = await req('PATCH', `/api/flow/accounts/${a.id}`, adminCookie, { dailyCreditCap: null });
    expect(cleared.json().account.dailyCreditCap).toBeUndefined();
    expect(await store.getAccount(a.id)).toMatchObject({ label: 'Utama', enabled: false, priority: 2 });
  });

  it('400 INVALID_INPUT on bad values, 404 for an unknown account, 409 on duplicate label', async () => {
    const { store, adminCookie } = await setup();
    const a = await store.addAccount({ label: 'A', email: 'a@x' });
    await store.addAccount({ label: 'B', email: 'b@x' });
    for (const body of [{ priority: 1.5 }, { priority: '1' }, { dailyCreditCap: -5 }, { dailyCreditCap: 'lots' }, { enabled: 'yes' }, { label: 7 }, {}]) {
      const res = await req('PATCH', `/api/flow/accounts/${a.id}`, adminCookie, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe('INVALID_INPUT');
    }
    expect((await req('PATCH', '/api/flow/accounts/acc_nope', adminCookie, { enabled: false })).statusCode).toBe(404);
    expect((await req('PATCH', `/api/flow/accounts/${a.id}`, adminCookie, { label: 'B' })).statusCode).toBe(409);
    expect(await store.getAccount(a.id)).toMatchObject({ label: 'A', enabled: true, priority: 0 });
  });
});

describe('GET/PUT /api/flow/pool', () => {
  it('reads the default and saves a rotation', async () => {
    const { store, adminCookie } = await setup();
    expect((await req('GET', '/api/flow/pool', adminCookie)).json()).toEqual({ pool: { rotation: 'least-used' } });
    const put = await req('PUT', '/api/flow/pool', adminCookie, { rotation: 'round-robin' });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ pool: { rotation: 'round-robin' } });
    expect(await store.getPool()).toEqual({ rotation: 'round-robin' });
  });

  it('rejects a bad rotation with 400 INVALID_INPUT', async () => {
    const { store, adminCookie } = await setup();
    const res = await req('PUT', '/api/flow/pool', adminCookie, { rotation: 'random' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_INPUT');
    expect(await store.getPool()).toEqual({ rotation: 'least-used' });
  });
});

describe('usage attribution + GET /api/flow/usage', () => {
  it('POST /api/flow/jobs records the session user as createdBy', async () => {
    const { store, admin, adminCookie } = await setup();
    const res = await req('POST', '/api/flow/jobs', adminCookie, { prompt: 'ombak' });
    expect(res.json().job.createdBy).toBe(admin.id);
    expect((await store.getJob(res.json().job.id))!.createdBy).toBe(admin.id);
  });

  it('reports usage with member emails, unknown members, and the default 7-day range', async () => {
    const { store, admin, adminCookie } = await setup();
    const a = await store.addAccount({ label: 'A', email: 'a@x' });
    await req('POST', '/api/flow/jobs', adminCookie, { prompt: 'clip' });
    await store.createJob({ prompt: 'legacy', kind: 'image' });
    const claimed = await store.claimJob('mac');
    await store.completeJob(claimed!.id, { filePath: '/x.mp4' });

    const res = await req('GET', '/api/flow/usage', adminCookie);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.range.days).toBe(7);
    expect(body.byDay).toHaveLength(7);
    expect(body.totals).toMatchObject({ jobs: 2, done: 1, queued: 1, credits: 10 });
    expect(body.byKind.video).toEqual({ jobs: 1, done: 1, credits: 10 });
    expect(body.byAccount).toEqual([expect.objectContaining({ accountId: a.id, label: 'A', jobs: 1, done: 1, credits: 10, creditsUsedToday: 10, enabled: true })]);
    expect(body.byMember).toEqual([
      { userId: admin.id, email: 'admin@x.io', jobs: 1, done: 1, credits: 10 },
      { userId: 'unknown', jobs: 1, done: 0, credits: 0 }
    ]);
  });

  it('clamps days to 1..90 and falls back to 7 on junk', async () => {
    const { adminCookie } = await setup();
    expect((await req('GET', '/api/flow/usage?days=0', adminCookie)).json().byDay).toHaveLength(1);
    expect((await req('GET', '/api/flow/usage?days=30', adminCookie)).json().byDay).toHaveLength(30);
    expect((await req('GET', '/api/flow/usage?days=9999', adminCookie)).json().range.days).toBe(90);
    expect((await req('GET', '/api/flow/usage?days=abc', adminCookie)).json().range.days).toBe(7);
  });
});
