import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { UserAuthStore } from '../src/auth/store.js';
import { FlowStore } from '../src/flow/store.js';
import { OpenRouterConfigStore } from '../src/providers/config.js';
import { registerQuotaRoutes } from '../src/quota.js';

let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

async function setup(balance: () => Promise<{ usedUsd: number; limitUsd: number | null; remainingUsd: number | null } | null> = async () => null) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-quota-'));
  const auth = new UserAuthStore(mkdtempSync(join(tmpdir(), 'nc-quota-auth-')));
  const member = await auth.createUser({ email: 'm@x.io', password: 'member-pass-1', isAdmin: false });
  const flow = new FlowStore(join(dataDir, 'flow'));
  server = Fastify();
  await registerQuotaRoutes(server, { userAuthStore: auth, dataDir, flow, balance });
  await server.ready();
  const cookie = `oc_session=${auth.createSession(member.id).token}`;
  return { dataDir, flow, get: () => server!.inject({ method: 'GET', url: '/api/quota', headers: { cookie } }) };
}

describe('GET /api/quota', () => {
  it('needs a session (401) but not admin', async () => {
    const t = await setup();
    expect((await server!.inject('/api/quota')).statusCode).toBe(401);
    expect((await t.get()).statusCode).toBe(200);
  });

  it('sums Flow credits, today usage and caps of enabled accounts; bridge online; storage bytes', async () => {
    const t = await setup();
    const a = await t.flow.addAccount({ label: 'A', email: 'a@x.io' });
    const b = await t.flow.addAccount({ label: 'B', email: 'b@x.io' });
    const c = await t.flow.addAccount({ label: 'C', email: 'c@x.io' });
    await t.flow.updateAccount(a.id, { dailyCreditCap: 100 });
    await t.flow.updateAccount(b.id, { dailyCreditCap: 50 });
    await t.flow.updateAccount(c.id, { enabled: false, dailyCreditCap: 999 });
    await t.flow.heartbeat('bridge-1', [{ id: a.id, credits: 40 }, { id: b.id, credits: 3 }]);
    mkdirSync(join(t.dataDir, 'stories', 'story_0000000000000001'), { recursive: true });
    writeFileSync(join(t.dataDir, 'stories', 'story_0000000000000001', 'final.mp4'), Buffer.alloc(5000));
    const body = (await t.get()).json();
    expect(body.flow).toMatchObject({ credits: 43, usedToday: 0, capToday: 150, accounts: 2, online: true, running: 0, waiting: 0, resumeAtMs: null });
    expect(body.openrouter).toEqual({ configured: false, remainingUsd: null, usedUsd: null });
    expect(body.storage.usedBytes).toBeGreaterThanOrEqual(5000);
    expect(body.storage).toHaveProperty('diskFreeBytes');
  });

  it('render status: clips running, clips waiting for credits and when they resume, credits per account', async () => {
    const t = await setup();
    const a = await t.flow.addAccount({ label: 'VPS 01', email: 'a@x.io' });
    const b = await t.flow.addAccount({ label: 'VPS 02', email: 'b@x.io' });
    await t.flow.heartbeat('bridge-1', [{ id: a.id, credits: 50 }, { id: b.id, credits: 50 }]);
    const first = await t.flow.createJob({ prompt: 'c0', kind: 'video' });
    await t.flow.claimJob('bridge-1');                       // A starts its cycle and renders c0
    await t.flow.heartbeat('bridge-1', [{ id: a.id, credits: 0 }, { id: b.id, credits: 0 }]);
    await t.flow.createJob({ prompt: 'c1', kind: 'video', startImage: '/1.png' });
    await t.flow.createJob({ prompt: 'c2', kind: 'video', startImage: '/2.png' });
    const body = (await t.get()).json();
    expect(body.flow).toMatchObject({ running: 1, waiting: 2 });
    const cycle = (await t.flow.listAccounts()).find(x => x.id === a.id)!.cycleStartMs!;
    expect(body.flow.resumeAtMs).toBe(cycle + 24 * 3_600_000);
    expect(body.flow.pool).toEqual([
      { label: 'VPS 01', credits: 0, refillAtMs: cycle + 24 * 3_600_000 },
      { label: 'VPS 02', credits: 0, refillAtMs: null }
    ]);
    expect(first.id).toBeTruthy();
  });

  it('no accounts: credits and cap are null; OpenRouter balance when a key is configured', async () => {
    const t = await setup(async () => ({ usedUsd: 1.25, limitUsd: 10, remainingUsd: 8.75 }));
    await new OpenRouterConfigStore(t.dataDir).update({ apiKey: 'sk-or-v1-abcdefghijklmnop' });
    const body = (await t.get()).json();
    expect(body.flow).toMatchObject({ credits: null, capToday: null, accounts: 0, online: false });
    expect(body.openrouter).toEqual({ configured: true, remainingUsd: 8.75, usedUsd: 1.25 });
  });

  it('a failing balance lookup keeps the endpoint up', async () => {
    const t = await setup(async () => { throw new Error('down'); });
    await new OpenRouterConfigStore(t.dataDir).update({ apiKey: 'sk-or-v1-abcdefghijklmnop' });
    const res = await t.get();
    expect(res.statusCode).toBe(200);
    expect(res.json().openrouter).toEqual({ configured: true, remainingUsd: null, usedUsd: null });
  });
});
