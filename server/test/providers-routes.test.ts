import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { UserAuthStore } from '../src/auth/store.js';
import { FlowStore } from '../src/flow/store.js';
import { registerProviderRoutes } from '../src/providers/routes.js';

const KEY = 'sk-or-v1-routes-0123456789abcdefQRST';
let server: FastifyInstance | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

async function setup(handler: (url: string, auth: string | null) => Response = () => new Response('{}', { status: 404 })) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-prov-routes-'));
  const auth = new UserAuthStore(mkdtempSync(join(tmpdir(), 'nc-prov-auth-')));
  const admin = await auth.createUser({ email: 'admin@x.io', password: 'admin-pass-1', isAdmin: true });
  const member = await auth.createUser({ email: 'member@x.io', password: 'member-pass-1', isAdmin: false });
  const flow = new FlowStore(join(dataDir, 'flow'));
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    return handler(String(url), new Headers(init?.headers).get('authorization'));
  }) as unknown as typeof fetch;
  server = Fastify();
  await registerProviderRoutes(server, { userAuthStore: auth, dataDir, flow, fetch: fetchImpl });
  await server.ready();
  const as = (cookie: string) => (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
    server!.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  return {
    dataDir, flow, calls,
    admin: as(`oc_session=${auth.createSession(admin.id).token}`),
    member: as(`oc_session=${auth.createSession(member.id).token}`)
  };
}

describe('provider routes', () => {
  it('are admin-only: 401 without a session, 403 for a member', async () => {
    const t = await setup();
    expect((await server!.inject('/api/providers')).statusCode).toBe(401);
    expect((await t.member('GET', '/api/providers')).statusCode).toBe(403);
    expect((await t.member('PUT', '/api/providers/openrouter', { apiKey: KEY })).statusCode).toBe(403);
    expect((await t.member('POST', '/api/providers/openrouter/test')).statusCode).toBe(403);
    expect((await t.member('GET', '/api/providers/openrouter/models')).statusCode).toBe(403);
  });

  it('GET /api/providers reports flow accounts, known credits, bridge and openrouter state', async () => {
    const t = await setup();
    const a = await t.flow.addAccount({ label: 'A', email: 'a@b.c' });
    await t.flow.addAccount({ label: 'B', email: 'b@b.c' });
    expect((await t.admin('GET', '/api/providers')).json()).toEqual({
      axcel: { configured: false, health: null, url: 'http://127.0.0.1:8899' },
      flow: { accounts: 2, credits: null, online: false },
      openrouter: { configured: false, defaults: {}, auditModel: 'google/gemini-2.5-flash' }
    });
    await t.flow.heartbeat('mac', [{ id: a.id, credits: 120 }]);
    expect((await t.admin('GET', '/api/providers')).json().flow).toEqual({ accounts: 2, credits: 120, online: true });
  });

  it('PUT stores the key (0600) and answers keyHint only; GET never returns the key', async () => {
    const t = await setup();
    const put = await t.admin('PUT', '/api/providers/openrouter', { apiKey: KEY, defaults: { video: 'google/veo-3.1-fast' } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ configured: true, keyHint: '••••QRST', defaults: { video: 'google/veo-3.1-fast' }, auditModel: 'google/gemini-2.5-flash' });
    expect(put.body).not.toContain(KEY);
    const get = await t.admin('GET', '/api/providers');
    expect(get.body).not.toContain(KEY);
    expect(get.json().openrouter.keyHint).toBe('••••QRST');
    const file = join(t.dataDir, 'providers', 'openrouter.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain(KEY);
  });

  it('PUT validates the body and clears the key with null', async () => {
    const t = await setup();
    expect((await t.admin('PUT', '/api/providers/openrouter', { apiKey: 'short' })).statusCode).toBe(400);
    expect((await t.admin('PUT', '/api/providers/openrouter', { apiKey: 42 })).statusCode).toBe(400);
    expect((await t.admin('PUT', '/api/providers/openrouter', { defaults: { image: 'bad id' } })).statusCode).toBe(400);
    await t.admin('PUT', '/api/providers/openrouter', { apiKey: KEY });
    expect((await t.admin('PUT', '/api/providers/openrouter', { apiKey: null })).json()).toEqual({ configured: false, defaults: {}, auditModel: 'google/gemini-2.5-flash' });
  });

  it('PUT auditModel: default, a vision pick, and a catalog-known video model is refused', async () => {
    const t = await setup(url => new Response(JSON.stringify(url.endsWith('/videos/models')
      ? { data: [{ id: 'google/veo-3.1-fast', name: 'Veo', supported_durations: [6] }] }
      : { data: [] }), { status: 200 }));
    expect((await t.admin('GET', '/api/providers')).json().openrouter.auditModel).toBe('google/gemini-2.5-flash');
    const ok = await t.admin('PUT', '/api/providers/openrouter', { auditModel: 'google/gemini-2.5-pro' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().auditModel).toBe('google/gemini-2.5-pro');
    expect((await t.admin('GET', '/api/providers')).json().openrouter.auditModel).toBe('google/gemini-2.5-pro');

    const video = await t.admin('PUT', '/api/providers/openrouter', { auditModel: 'google/veo-3.1-fast' });
    expect(video.statusCode).toBe(400);
    expect(video.json().error.message).toMatch(/model video/);
    expect((await t.admin('PUT', '/api/providers/openrouter', { auditModel: 'not a model' })).statusCode).toBe(400);
    expect((await t.admin('PUT', '/api/providers/openrouter', { auditModel: null })).json().auditModel).toBe('google/gemini-2.5-flash');
  });

  it('POST test: 400 without a key, balance with a good key, 400 with the Indonesian message for a rejected key', async () => {
    let status = 200;
    const t = await setup((url, auth) => {
      expect(url).toBe('https://openrouter.ai/api/v1/key');
      expect(auth).toBe(`Bearer ${KEY}`);
      return new Response(JSON.stringify(status === 200 ? { data: { usage: 2.5, limit: 20, limit_remaining: 17.5 } } : { error: { message: 'User not found.' } }), { status });
    });
    const none = await t.admin('POST', '/api/providers/openrouter/test');
    expect(none.statusCode).toBe(400);
    expect(none.json().error.message).toMatch(/API key/);
    await t.admin('PUT', '/api/providers/openrouter', { apiKey: KEY });
    const ok = await t.admin('POST', '/api/providers/openrouter/test');
    expect(ok.json()).toEqual({ ok: true, balance: { usedUsd: 2.5, limitUsd: 20, remainingUsd: 17.5 } });
    status = 401;
    const bad = await t.admin('POST', '/api/providers/openrouter/test');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toBe('API key OpenRouter ditolak');
    expect(bad.body).not.toContain(KEY);
  });

  it('GET models maps both catalogs to ModelInfo', async () => {
    const t = await setup(url => new Response(JSON.stringify(url.endsWith('/videos/models')
      ? { data: [{ id: 'google/veo-3.1-fast', name: 'Veo', supported_aspect_ratios: ['9:16'], supported_durations: [4, 6, 8], generate_audio: true, supported_frame_images: ['first_frame'], pricing_skus: { duration_seconds_with_audio_720p: '0.10' } }] }
      : { data: [{ id: 'openai/gpt-image-1', name: 'GPT Image', supported_parameters: { aspect_ratio: { values: ['1:1'] }, input_references: { max: 16 } } }] }), { status: 200 }));
    const res = await t.admin('GET', '/api/providers/openrouter/models');
    expect(res.statusCode).toBe(200);
    expect(res.json().video[0]).toMatchObject({ id: 'google/veo-3.1-fast', durations: [4, 6, 8], audio: true, firstFrame: true, priceLabel: '±$0,60 / klip 6 dtk' });
    expect(res.json().video[0].usdPerClip).toBeCloseTo(0.6, 6);
    expect(res.json().image[0]).toMatchObject({ id: 'openai/gpt-image-1', references: true, aspects: ['1:1'] });
  });

  it('GET models answers 502 when OpenRouter is down and nothing is cached', async () => {
    const t = await setup(() => new Response('down', { status: 503 }));
    const res = await t.admin('GET', '/api/providers/openrouter/models');
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toMatch(/OpenRouter/);
  });
});
