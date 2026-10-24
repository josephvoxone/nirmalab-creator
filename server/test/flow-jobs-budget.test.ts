import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { UserAuthStore } from '../src/auth/store.js';
import { registerFlowRoutes } from '../src/flow/routes.js';

let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

async function setup(price: number | null, remaining: number | null) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-fjb-'));
  const auth = new UserAuthStore(mkdtempSync(join(tmpdir(), 'nc-fjb-auth-')));
  const admin = await auth.createUser({ email: 'admin@x.io', password: 'admin-pass-1', isAdmin: true });
  const cookie = `oc_session=${auth.createSession(admin.id).token}`;
  server = Fastify();
  await registerFlowRoutes(server, {
    userAuthStore: auth, dataDir, bridgeToken: 'bridge-token-0123456789abcdef',
    openRouter: { usdPerClip: async () => price, balance: async () => (remaining === null ? null : { usedUsd: 1, limitUsd: 5, remainingUsd: remaining }) }
  });
  await server.ready();
  return (payload: Record<string, unknown>) => server!.inject({ method: 'POST', url: '/api/flow/jobs', headers: { cookie }, payload });
}

const video = { prompt: 'ombak senja', kind: 'video', provider: 'openrouter', model: 'google/veo-3.1-lite' };

describe('Studio OpenRouter budget (POST /api/flow/jobs)', () => {
  it('refuses a clip that costs more than the balance with 402 BUDGET; force queues it', async () => {
    const post = await setup(0.3, 0.1);
    const refused = await post(video);
    expect(refused.statusCode).toBe(402);
    expect(refused.json().error).toEqual({ code: 'BUDGET', message: 'Butuh ±$0,30, saldo OpenRouter $0,10' });
    const forced = await post({ ...video, force: true });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().job).toMatchObject({ provider: 'openrouter', model: 'google/veo-3.1-lite' });
  });

  it('queues when the balance covers it, the price or balance is unknown, or it is a Flow job', async () => {
    expect((await (await setup(0.3, 5))(video)).statusCode).toBe(200);
    expect((await (await setup(null, 0.1))(video)).statusCode).toBe(200);
    expect((await (await setup(0.3, null))(video)).statusCode).toBe(200);
    expect((await (await setup(0.3, 0.1))({ prompt: 'x', kind: 'video' })).statusCode).toBe(200);
  });
});
