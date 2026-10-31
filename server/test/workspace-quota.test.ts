/**
 * W4 — quota per workspace: the ledger counts by workspace, the platform admin sets the workspace limits, and the ElevenLabs
 * gate stays per PERSON. RED first: written before the workspaceId ledger/lines existed.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { UserAuthStore } from '../src/auth/store.js';
import { SpendLedger } from '../src/quota/ledger.js';
import { LimitsStore } from '../src/quota/limits.js';
import { QuotaError } from '../src/quota/errors.js';
import { registerQuotaLimitRoutes } from '../src/quota/routes.js';
import { registerQuotaRoutes } from '../src/quota.js';
import type { FlowStore } from '../src/flow/store.js';

const cookie = (token: string) => ({ cookie: `oc_session=${token}` });

async function world() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-ws-quota-'));
  const auth = new UserAuthStore(dataDir);
  const admin = await auth.createUser({ email: 'joseph@x.io', password: 'admin-pass-1', isAdmin: true });
  const member = await auth.createUser({ email: 'elfree@x.io', password: 'member-pass-1', isAdmin: false });
  const limits = new LimitsStore(dataDir, id => auth.findUserById(id)?.isAdmin === true);
  await limits.init();
  const workspaceOf = (userId: string) => (userId === admin.id ? 'ws_a' : userId === member.id ? 'ws_b' : undefined);
  const ledger = new SpendLedger(dataDir, {
    limitFor: limits.resolve,
    workspaceOf,
    limitForWorkspace: limits.resolveWorkspace
  });
  return { dataDir, auth, admin, member, limits, ledger };
}

type World = Awaited<ReturnType<typeof world>>;

const codeOf = async (fn: () => Promise<unknown>) => {
  try { await fn(); return undefined; } catch (error) { return error instanceof QuotaError ? `${error.window}:${error.limit}` : String(error); }
};

describe('W4 kuota per workspace (ledger)', () => {
  it('stamps the workspace of the person on every reservation and counts it apart from the person', async () => {
    const w = await world();
    await w.ledger.reserve({ key: 'k1', userId: w.admin.id, kind: 'flowCredits', amount: 4 });
    await w.ledger.commit('k1', 4);
    const entries = await w.ledger.open();
    expect(entries).toEqual([]);
    const mine = await w.ledger.usage(w.admin.id);
    expect(mine.flowCredits.day).toBe(4);
    const ws = await w.ledger.workspaceUsage('ws_a');
    expect(ws.flowCredits.day).toBe(4);
    expect((await w.ledger.workspaceUsage('ws_b')).flowCredits.day).toBe(0);
  });

  it('enforces the limit the platform admin set for the workspace, on top of the person\'s own limit', async () => {
    const w = await world();
    await w.limits.setWorkspace('ws_a', { flowCredits: { perDay: 10 } });
    await w.ledger.reserve({ key: 'a1', userId: w.admin.id, kind: 'flowCredits', amount: 6 });
    await w.ledger.commit('a1', 6);
    const blocked = await codeOf(() => w.ledger.reserve({ key: 'a2', userId: w.admin.id, kind: 'flowCredits', amount: 6 }));
    expect(blocked).toBe('day:10');
    // the same person in ANOTHER workspace is unaffected by ws_a's limit
    await w.ledger.reserve({ key: 'b1', userId: w.admin.id, kind: 'flowCredits', amount: 6, workspaceId: 'ws_other' }).catch(() => undefined);
    expect((await w.ledger.workspaceUsage('ws_other')).flowCredits.day).toBe(0);
    // and a workspace with no limit set is unlimited
    expect(await codeOf(() => w.ledger.reserve({ key: 'c1', userId: w.member.id, kind: 'flowCredits', amount: 500 }))).toBeUndefined();
  });

  it('keeps the ElevenLabs gate per PERSON: two members of one workspace each get their own 2.000/day', async () => {
    const w = await world();
    const ws = 'ws_shared';
    const other = await w.auth.createUser({ email: 'third@x.io', password: 'third-pass-1', isAdmin: false });
    await w.ledger.reserve({ key: 'p1', userId: w.member.id, kind: 'elevenChars', amount: 1500, workspaceId: ws });
    await w.ledger.commit('p1', 1500);
    // the second person has spent nothing of their own 2.000 although the workspace total is 1.500
    expect(await codeOf(() => w.ledger.reserve({ key: 'p2', userId: other.id, kind: 'elevenChars', amount: 1500, workspaceId: ws }))).toBeUndefined();
    await w.ledger.commit('p2', 1500);
    // the first person is now over their own daily limit
    expect(await codeOf(() => w.ledger.reserve({ key: 'p3', userId: w.member.id, kind: 'elevenChars', amount: 600, workspaceId: ws }))).toBe('day:2000');
    expect((await w.ledger.workspaceUsage(ws)).elevenChars.day).toBe(3000);
    // and the workspace limit, when the admin sets one, applies in addition
    await w.limits.setWorkspace(ws, { elevenChars: { perDay: 3200 } });
    expect(await codeOf(() => w.ledger.reserve({ key: 'p4', userId: other.id, kind: 'elevenChars', amount: 400, workspaceId: ws }))).toBe('day:3200');
  });
});

describe('W4 kuota per workspace (rute)', () => {
  async function app(w: World) {
    const server = Fastify();
    const flow = {
      listAccounts: async () => [{ label: 'A', credits: 100, enabled: true, creditsUsedToday: 1 }],
      queueStatus: async () => ({ running: 0, waitingForCredits: 0, resumeAtMs: null, accounts: [] }),
      bridgeStatus: async () => ({ online: false })
    } as unknown as FlowStore;
    await registerQuotaRoutes(server, {
      userAuthStore: w.auth, dataDir: w.dataDir, flow, balance: async () => null,
      quotaLedger: { ledger: w.ledger, limits: w.limits },
      workspace: { roleOf: (userId, workspaceId) => (userId === w.admin.id && workspaceId === 'ws_a' ? 'owner' : undefined), ledger: w.ledger, limits: w.limits }
    });
    await registerQuotaLimitRoutes(server, { userAuthStore: w.auth, ledger: w.ledger, limits: w.limits, workspaceExists: id => id === 'ws_a' });
    await server.ready();
    return server;
  }

  it('GET /api/quota?workspace=<id> answers the numbers of THAT workspace to its members only', async () => {
    const w = await world();
    const server = await app(w);
    await w.ledger.reserve({ key: 'q1', userId: w.admin.id, kind: 'flowCredits', amount: 7 });
    await w.ledger.commit('q1', 7);
    expect((await server.inject({ method: 'GET', url: '/api/quota?workspace=ws_a' })).statusCode).toBe(401);
    const mine = await server.inject({ method: 'GET', url: '/api/quota?workspace=ws_a', headers: cookie(w.auth.createSession(w.admin.id).token) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({ workspace: { id: 'ws_a', role: 'owner' }, usage: { flowCredits: { day: 7 } } });
    expect(mine.json().workspace).not.toHaveProperty('ownerId');
    // a non-member: the same 404 as an unknown workspace (no oracle)
    const denied = await server.inject({ method: 'GET', url: '/api/quota?workspace=ws_a', headers: cookie(w.auth.createSession(w.member.id).token) });
    expect(denied.statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: '/api/quota?workspace=ws_nope', headers: cookie(w.auth.createSession(w.admin.id).token) })).statusCode).toBe(404);
    // without ?workspace the answer is unchanged (the caller's own numbers)
    const own = await server.inject({ method: 'GET', url: '/api/quota', headers: cookie(w.auth.createSession(w.admin.id).token) });
    expect(own.json().mine.usage.flowCredits.day).toBe(7);
    await server.close();
  });

  it('PUT /api/admin/workspaces/:id/limits lets the platform admin set workspace limits; members cannot', async () => {
    const w = await world();
    const server = await app(w);
    const put = await server.inject({ method: 'PUT', url: '/api/admin/workspaces/ws_a/limits', headers: cookie(w.auth.createSession(w.admin.id).token), payload: { limits: { flowCredits: { perDay: 50 } } } });
    expect(put.statusCode).toBe(200, put.body);
    expect(put.json()).toMatchObject({ workspaceId: 'ws_a', limits: { flowCredits: { perDay: 50 } }, effective: { flowCredits: { perDay: 50 } } });
    const got = await server.inject({ method: 'GET', url: '/api/admin/workspaces/ws_a/limits', headers: cookie(w.auth.createSession(w.admin.id).token) });
    expect(got.json().effective.flowCredits.perDay).toBe(50);
    const memberPut = await server.inject({ method: 'PUT', url: '/api/admin/workspaces/ws_a/limits', headers: cookie(w.auth.createSession(w.member.id).token), payload: { limits: {} } });
    expect(memberPut.statusCode).toBe(403);
    expect((await server.inject({ method: 'PUT', url: '/api/admin/workspaces/ws_a/limits', headers: cookie(w.auth.createSession(w.admin.id).token), payload: { limits: { flowCredits: { perDay: -1 } } } })).statusCode).toBe(400);
    // the numbers never carry project content; unknown workspace 404
    const body = JSON.stringify(got.json());
    expect(body).not.toContain('title');
    expect((await server.inject({ method: 'GET', url: '/api/admin/workspaces/ws_nope/limits', headers: cookie(w.auth.createSession(w.admin.id).token) })).statusCode).toBe(404);
    await server.close();
  });
});
