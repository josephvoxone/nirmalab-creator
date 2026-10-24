import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { UserAuthStore } from '../src/auth/store.js';
import { registerFlowRoutes } from '../src/flow/routes.js';

const BRIDGE_TOKEN = 'bridge-token-0123456789abcdef';
let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-pfr-'));
  const auth = new UserAuthStore(mkdtempSync(join(tmpdir(), 'nc-pfr-auth-')));
  const admin = await auth.createUser({ email: 'admin@x.io', password: 'admin-pass-1', isAdmin: true });
  const cookie = `oc_session=${auth.createSession(admin.id).token}`;
  server = Fastify();
  await registerFlowRoutes(server, { userAuthStore: auth, dataDir, bridgeToken: BRIDGE_TOKEN });
  await server.ready();
  const post = (payload: unknown) => server!.inject({ method: 'POST', url: '/api/flow/jobs', headers: { cookie }, payload: payload as Record<string, unknown> });
  return { cookie, post };
}

describe('flow job routes with providers', () => {
  it('POST /api/flow/jobs queues an openrouter job with its model', async () => {
    const { post } = await setup();
    const res = await post({ prompt: 'ombak senja', kind: 'image', provider: 'openrouter', model: 'google/gemini-2.5-flash-image' });
    expect(res.statusCode).toBe(200);
    expect(res.json().job).toMatchObject({ provider: 'openrouter', model: 'google/gemini-2.5-flash-image', kind: 'image', status: 'queued' });
  });

  it('400 for an unknown provider or an openrouter job without a valid model', async () => {
    const { post } = await setup();
    expect((await post({ prompt: 'x', provider: 'midjourney' })).statusCode).toBe(400);
    expect((await post({ prompt: 'x', provider: 'openrouter' })).statusCode).toBe(400);
    expect((await post({ prompt: 'x', provider: 'openrouter', model: 'bad model' })).statusCode).toBe(400);
  });

  it('provider flow (or none) stays a bridge job', async () => {
    const { post } = await setup();
    expect((await post({ prompt: 'x', provider: 'flow' })).json().job.provider).toBeUndefined();
    expect((await post({ prompt: 'x' })).json().job.provider).toBeUndefined();
  });

  it('the bridge claim route never hands out an openrouter job', async () => {
    const { post, cookie } = await setup();
    await server!.inject({ method: 'POST', url: '/api/flow/accounts', headers: { cookie }, payload: { label: 'A', email: 'a@b.c' } });
    await post({ prompt: 'or clip', provider: 'openrouter', model: 'google/veo-3.1-fast' });
    const claim = await server!.inject({ method: 'POST', url: '/api/flow/bridge/claim', headers: { 'x-flow-bridge-token': BRIDGE_TOKEN }, payload: { bridgeId: 'mac' } });
    expect(claim.statusCode).toBe(204);
  });
});
