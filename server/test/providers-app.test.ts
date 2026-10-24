import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const KEY = 'sk-or-v1-app-0123456789abcdefABCD';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4000, 9)]);
const board = {
  title: 'Kucing Hilang',
  audio: 'Audio: voice-over: "{line}"',
  shots: [
    { id: '00-intro', silent: true, prompt: 'Extreme wide shot of a valley.' },
    { id: '01-a', prompt: 'Medium shot of a kitten on a porch.', narration: 'Mimi menunggu.' }
  ]
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function setup(opts: { workerMs?: number; remainingUsd?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-papp-'));
  const calls: string[] = [];
  const fetchImpl = (async (input: string) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/videos/models')) return json({ data: [{ id: 'google/veo-3.1-fast', name: 'Veo', supported_durations: [4, 6, 8], generate_audio: true, pricing_skus: { duration_seconds_with_audio_720p: '0.10' } }] });
    if (url.endsWith('/images/models')) return json({ data: [{ id: 'google/gemini-2.5-flash-image', name: 'NB', supported_parameters: {} }] });
    if (url.endsWith('/key')) return json({ data: { usage: 1, limit: 10, limit_remaining: opts.remainingUsd ?? 9 } });
    if (url.endsWith('/images')) return json({ data: [{ b64_json: PNG.toString('base64') }], usage: { cost: 0.04 } });
    return json({ error: { message: 'unexpected' } }, 404);
  }) as unknown as typeof fetch;
  const server = await buildApp({
    dataDir,
    env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
    stories: { reconcileMs: 0, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined, generateText: async () => JSON.stringify(board) },
    providers: { fetch: fetchImpl, workerMs: opts.workerMs ?? 0 }
  });
  close = () => server.close();
  const res = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    server.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  return { server, req, calls, dataDir };
}

describe('providers wired into the app', () => {
  it('serves /api/providers to an admin', async () => {
    const t = await setup();
    const res = await t.req('GET', '/api/providers');
    expect(res.statusCode).toBe(200);
    expect(res.json().openrouter).toEqual({ configured: false, defaults: {} });
  });

  it('the draft route puts the engine on the drafted storyboard; a bad engine is 400', async () => {
    const t = await setup();
    const engine = { video: { provider: 'openrouter', model: 'google/veo-3.1-fast' } };
    const created = await t.req('POST', '/api/stories/draft', { premise: 'Kucing hilang lalu pulang', engine });
    expect(created.statusCode).toBe(201);
    const story = (await t.req('GET', `/api/stories/${created.json().story.id}`)).json();
    expect(story.storyboard.engine).toEqual(engine);

    const plain = await t.req('POST', '/api/stories/draft', { premise: 'Kucing hilang lalu pulang' });
    expect((await t.req('GET', `/api/stories/${plain.json().story.id}`)).json().storyboard.engine).toBeUndefined();

    expect((await t.req('POST', '/api/stories/draft', { premise: 'Kucing hilang lalu pulang', engine: { video: { provider: 'openrouter' } } })).statusCode).toBe(400);
  });

  it('render with an OpenRouter video engine checks the USD estimate against the OpenRouter balance', async () => {
    const t = await setup({ remainingUsd: 1 });
    await t.req('PUT', '/api/providers/openrouter', { apiKey: KEY });
    const created = await t.req('POST', '/api/stories', { storyboard: { ...board, mode: 'cepat', engine: { video: { provider: 'openrouter', model: 'google/veo-3.1-fast' } } } });
    const id = created.json().story.id;
    const refused = await t.req('POST', `/api/stories/${id}/render`, {});
    expect(refused.json().error).toEqual({ code: 'BUDGET', message: 'Butuh ±$1,20, saldo OpenRouter $1,00' });
    const forced = await t.req('POST', `/api/stories/${id}/render`, { force: true });
    expect(forced.statusCode).toBe(200);
  });

  it('the background worker renders an OpenRouter Studio job once a key is set', async () => {
    const t = await setup({ workerMs: 20 });
    await t.req('PUT', '/api/providers/openrouter', { apiKey: KEY });
    const job = (await t.req('POST', '/api/flow/jobs', { prompt: 'ombak senja', kind: 'image', provider: 'openrouter', model: 'google/gemini-2.5-flash-image' })).json().job;
    let status = 'queued';
    for (let i = 0; i < 100 && status !== 'done'; i += 1) {
      await new Promise(r => setTimeout(r, 20));
      status = (await t.req('GET', '/api/flow/jobs')).json().jobs.find((j: { id: string }) => j.id === job.id).status;
    }
    expect(status).toBe('done');
    const file = await t.req('GET', `/api/flow/jobs/${job.id}/file`);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PNG)).toBe(true);
  });
});
