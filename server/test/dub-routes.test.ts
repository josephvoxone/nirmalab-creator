import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const EL_KEY = 'sk_test_eleven_0123456789abcdef0123456789';
const EL_KEY2 = 'sk_test_eleven_zzzzzzzzzzzzzzzz0123456789';
const GEM_KEY = 'AIzaSyGEMINIKEY_0123456789abcdefghijk';
const MP3 = Buffer.from('ID3-fake-mp3-'.repeat(100));
const board = { title: 'Lentera', scenes: [{ id: 'sc1', title: 'Satu', shots: ['01-a', '02-b'] }], shots: [
  { id: '01-a', prompt: 'Medium shot. A boy waits.', narration: 'Aku menunggu.' },
  { id: '02-b', prompt: 'Close-up. He smiles.', narration: 'Lalu tersenyum.' }
] };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

let ipSeq = 1;
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

type Calls = { tts: Array<{ voice: string; key: string; body: any }>; subscription: number; models: number };
async function setup(opts: { env?: Record<string, string>; subscription?: (key: string) => Response; gemini?: (key: string) => Response; tts?: (key: string) => Response } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-dub-'));
  const calls: Calls = { tts: [], subscription: 0, models: 0 };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const key = ((init?.headers ?? {}) as Record<string, string>)['xi-api-key'] ?? String(((init?.headers ?? {}) as Record<string, string>).authorization ?? '').replace('Bearer ', '');
    if (url.includes('/v1/text-to-speech/')) {
      calls.tts.push({ voice: url.split('/text-to-speech/')[1]!.split('?')[0]!.replace(/\/with-timestamps$/, ''), key, body: JSON.parse(String(init!.body)) });
      return opts.tts ? opts.tts(key) : new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
    if (url.endsWith('/v1/user/subscription')) { calls.subscription++; return opts.subscription ? opts.subscription(key) : json({ tier: 'creator', character_count: 100, character_limit: 100000, next_character_count_reset_unix: 1893456000 }); }
    if (url.includes('/v2/voices')) return json({ voices: [{ voice_id: 'VOICE_ARYA_123456', name: 'Arya', category: 'premade', labels: { gender: 'male', age: 'old' } }], has_more: false });
    if (url.endsWith('/v1beta/openai/models')) { calls.models++; return opts.gemini ? opts.gemini(key) : json({ data: [{ id: 'models/gemini-3.8-flash' }] }); }
    return json({ error: { message: `unexpected ${url}` } }, 404);
  }) as unknown as typeof fetch;
  const server = await buildApp({
    dataDir,
    env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1', ...(opts.env ?? {}) },
    stories: { reconcileMs: 0, probe: async () => ({ durationSec: 3.25, hasAudio: true }), assemble: async () => undefined, generateText: async () => JSON.stringify(board) },
    providers: { fetch: fetchImpl, workerMs: 0 },
    dub: { fetch: fetchImpl, resume: false }
  });
  close = () => server.close();
  // the login rate limiter counts per client IP: every setup is a different "browser"
  const login = await server.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: `10.9.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, anon = false) =>
    server.inject({ method, url, headers: anon ? {} : { cookie }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  const created = await req('POST', '/api/stories/draft', { premise: 'Anak menunggu di jalan' });
  const id = created.json().story.id as string;
  // a draft renumbers its shots and scenes: use what the server made
  const first = (await req('GET', `/api/stories/${id}/dub`)).json().dub;
  const ids = first.shots.map((x: any) => x.shotId) as string[];
  const sceneId = first.shots[0].sceneId as string;
  return { server, req, calls, id, dataDir, ids, sceneId, a: ids[0]!, b: ids[1]! };
}
const secretsIn = (text: string) => [EL_KEY, EL_KEY2, GEM_KEY].filter(k => text.includes(k));
const settle = async (t: Awaited<ReturnType<typeof setup>>, id: string) => {
  for (let i = 0; i < 80; i++) { const st = (await t.req('GET', `/api/stories/${id}/dub`)).json().dub; if (st.totals.active === 0) return st; await new Promise(r => setTimeout(r, 25)); }
  throw new Error('dub did not settle');
};

describe('key pool routes', () => {
  it('needs a login and an admin', async () => {
    const t = await setup();
    expect((await t.req('GET', '/api/providers/keypool', undefined, true)).statusCode).toBe(401);
    expect((await t.req('POST', '/api/providers/keypool/elevenlabs', { key: EL_KEY }, true)).statusCode).toBe(401);
  });

  it('adds a key after proving it works, never returns the secret, and shows it in the list', async () => {
    const t = await setup();
    const added = await t.req('POST', '/api/providers/keypool/elevenlabs', { key: EL_KEY, label: 'Utama' });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ verified: true, key: { label: 'Utama', source: 'store', state: 'ready' } });
    expect(secretsIn(added.body)).toEqual([]);
    const list = await t.req('GET', '/api/providers/keypool');
    expect(list.json().elevenlabs).toMatchObject({ max: 1, keys: [{ label: 'Utama' }], dormant: [] });
    expect(list.json().gemini.keys).toEqual([]);
    expect(secretsIn(list.body)).toEqual([]);
  });

  it('refuses a key the provider rejects, and does not store it', async () => {
    const t = await setup({ subscription: () => json({ detail: { status: 'invalid_api_key' } }, 401) });
    const res = await t.req('POST', '/api/providers/keypool/elevenlabs', { key: EL_KEY });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_KEY');
    expect((await t.req('GET', '/api/providers/keypool')).json().elevenlabs.keys).toEqual([]);
  });

  it('a scoped key without permission to read the subscription is still accepted (it can speak, just not report credits)', async () => {
    const t = await setup({ subscription: () => json({ detail: { status: 'missing_permissions', message: 'needs user_read' } }, 401) });
    const res = await t.req('POST', '/api/providers/keypool/elevenlabs', { key: EL_KEY });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ verified: true, limited: true });
  });

  it('accepts a key when the provider cannot be reached, marked unverified', async () => {
    const t = await setup({ subscription: () => new Response('down', { status: 503 }) });
    const res = await t.req('POST', '/api/providers/keypool/elevenlabs', { key: EL_KEY });
    expect(res.statusCode).toBe(201);
    expect(res.json().verified).toBe(false);
  });

  it('Gemini keys have their own pool and are proven by listing models', async () => {
    const t = await setup();
    const res = await t.req('POST', '/api/providers/keypool/gemini', { key: GEM_KEY });
    expect(res.statusCode).toBe(201);
    expect(t.calls.models).toBe(1);
    expect((await t.req('GET', '/api/providers/keypool')).json().gemini.keys).toHaveLength(1);
    expect((await t.req('POST', '/api/providers/keypool/openai', { key: GEM_KEY })).statusCode).toBe(404);
  });

  it('Gemini holds at most 10 keys and refuses duplicates; ElevenLabs holds exactly one (more in eleven-single-key.test.ts)', async () => {
    const t = await setup();
    const gem = (i: number) => `gemini_test_key_${String(i).padStart(2, '0')}_0123456789abcdef`;
    expect((await t.req('POST', '/api/providers/keypool/gemini', { key: gem(1) })).statusCode).toBe(201);
    expect((await t.req('POST', '/api/providers/keypool/gemini', { key: gem(1) })).statusCode).toBe(400);
    for (let i = 2; i <= 10; i++) expect((await t.req('POST', '/api/providers/keypool/gemini', { key: gem(i) })).statusCode).toBe(201);
    const over = await t.req('POST', '/api/providers/keypool/gemini', { key: gem(11) });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.message).toMatch(/maksimal 10/i);
    expect((await t.req('POST', '/api/providers/keypool/elevenlabs', { key: EL_KEY })).statusCode).toBe(201);
    expect((await t.req('POST', '/api/providers/keypool/elevenlabs', { key: EL_KEY2 })).statusCode).toBe(409);
  });

  it('removes a key; an unknown id is 404', async () => {
    const t = await setup();
    const id = (await t.req('POST', '/api/providers/keypool/elevenlabs', { key: EL_KEY })).json().key.id;
    expect((await t.req('DELETE', `/api/providers/keypool/elevenlabs/${id}`)).statusCode).toBe(200);
    expect((await t.req('DELETE', `/api/providers/keypool/elevenlabs/${id}`)).statusCode).toBe(404);
    expect((await t.req('GET', '/api/providers/keypool')).json().elevenlabs.keys).toEqual([]);
  });

  it('keys from the server environment are listed (masked), usable, and cannot be deleted from the UI', async () => {
    const t = await setup({ env: { ELEVENLABS_API_KEYS: `${EL_KEY},${EL_KEY2}` } });
    const list = (await t.req('GET', '/api/providers/keypool')).json();
    expect(list.elevenlabs.keys.map((k: any) => k.source)).toEqual(['env']); // ONE active key: the first
    expect(list.elevenlabs.dormant.map((k: any) => k.source)).toEqual(['env']); // the second is listed, never used
    expect(secretsIn(JSON.stringify(list))).toEqual([]);
    const del = await t.req('DELETE', `/api/providers/keypool/elevenlabs/${list.elevenlabs.keys[0].id}`);
    expect(del.statusCode).toBe(409);
    expect((await t.req('DELETE', `/api/providers/keypool/elevenlabs/${list.elevenlabs.dormant[0].id}`)).statusCode).toBe(409);
    expect((await t.req('GET', '/api/providers/keypool')).json().elevenlabs.keys).toHaveLength(1);
  });

  it('test: reports the credits left of one key without spending any', async () => {
    const t = await setup();
    const id = (await t.req('POST', '/api/providers/keypool/elevenlabs', { key: EL_KEY })).json().key.id;
    const res = await t.req('POST', `/api/providers/keypool/elevenlabs/${id}/test`);
    expect(res.json()).toMatchObject({ ok: true, tier: 'creator', used: 100, limit: 100000, left: 99900 });
    expect(t.calls.tts).toHaveLength(0);
  });

  it('text routing: choose Gemini as the primary text model and its model name', async () => {
    const t = await setup();
    expect((await t.req('GET', '/api/providers/text-routing')).json()).toMatchObject({ primary: 'opencode-go' });
    const res = await t.req('PUT', '/api/providers/text-routing', { primary: 'gemini', geminiModel: 'gemini-3.6-flash' });
    expect(res.json()).toMatchObject({ primary: 'gemini', geminiModel: 'gemini-3.6-flash' });
    expect((await t.req('PUT', '/api/providers/text-routing', { primary: 'gpt' })).statusCode).toBe(400);
  });
});

describe('dub routes', () => {
  it('needs a login', async () => {
    const t = await setup();
    expect((await t.req('GET', `/api/stories/${t.id}/dub`, undefined, true)).statusCode).toBe(401);
    expect((await t.req('POST', `/api/stories/${t.id}/dub/render`, {}, true)).statusCode).toBe(401);
  });

  it('shows the state of a story: not configured yet, one line per shot, the model list', async () => {
    const t = await setup();
    const dub = (await t.req('GET', `/api/stories/${t.id}/dub`)).json().dub;
    expect(dub.configured).toBe(false);
    expect(dub.shots.map((s: any) => [s.shotId, s.status])).toEqual([[t.a, 'none'], [t.b, 'none']]);
    expect(dub.models.map((m: any) => m.id)).toContain('eleven_multilingual_v2');
    expect((await t.req('GET', '/api/stories/story_0000000000000000/dub')).statusCode).toBe(404);
  });

  it('lists voices through the pool', async () => {
    const t = await setup();
    expect((await t.req('GET', '/api/dub/voices')).statusCode).toBe(400); // no key yet
    await t.req('POST', '/api/providers/keypool/elevenlabs', { key: EL_KEY });
    const res = await t.req('GET', '/api/dub/voices');
    expect(res.json().voices[0]).toMatchObject({ id: 'VOICE_ARYA_123456', name: 'Arya', gender: 'male' });
  });

  it('the whole flow: settings → plan → refuse without confirmation → render with it → audio, always with the one key', async () => {
    const t = await setup();
    await t.req('POST', '/api/providers/keypool/elevenlabs', { key: EL_KEY });
    expect((await t.req('POST', '/api/providers/keypool/elevenlabs', { key: EL_KEY2 })).statusCode).toBe(409); // one key only
    expect((await t.req('PUT', `/api/stories/${t.id}/dub/settings`, { voiceId: 'VOICE_ARYA_123456', modelId: 'eleven_multilingual_v2', voice: { speed: 0.9 } })).json().dub.settings).toMatchObject({ voiceId: 'VOICE_ARYA_123456', voice: { speed: 0.9 } });
    const plan = (await t.req('POST', `/api/stories/${t.id}/dub/plan`, { scope: { kind: 'all' } })).json().plan;
    expect(plan).toMatchObject({ shotIds: [t.a, t.b], chars: 'Aku menunggu.'.length + 'Lalu tersenyum.'.length });
    // the server refuses without the exact confirmation
    const refused = await t.req('POST', `/api/stories/${t.id}/dub/render`, { scope: { kind: 'all' } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('CONFIRM_REQUIRED');
    expect(t.calls.tts).toHaveLength(0);
    const started = await t.req('POST', `/api/stories/${t.id}/dub/render`, { scope: { kind: 'all' }, confirmCredits: plan.credits });
    expect(started.statusCode).toBe(202);
    const done = await settle(t, t.id);
    expect(done.shots.map((s: any) => s.status)).toEqual(['done', 'done']);
    expect(new Set(t.calls.tts.map(c => c.key))).toEqual(new Set([EL_KEY])); // no rotation across accounts
    expect(t.calls.tts[0]!.body.voice_settings.speed).toBe(0.9);
    const audio = await t.req('GET', `/api/stories/${t.id}/dub/shots/${t.a}/audio`);
    expect(audio.statusCode).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/mpeg');
    expect(audio.rawPayload.equals(MP3)).toBe(true);
    // nothing changed: asking again costs nothing and makes no call
    const before = t.calls.tts.length;
    const again = await t.req('POST', `/api/stories/${t.id}/dub/render`, { scope: { kind: 'all' }, confirmCredits: 0 });
    expect(again.statusCode).toBe(202);
    await settle(t, t.id);
    expect(t.calls.tts.length).toBe(before);
  });

  it('per-shot: its own text and voice, scene scope, remove', async () => {
    const t = await setup();
    await t.req('POST', '/api/providers/keypool/elevenlabs', { key: EL_KEY });
    await t.req('PUT', `/api/stories/${t.id}/dub/settings`, { voiceId: 'VOICE_ARYA_123456' });
    await t.req('PUT', `/api/stories/${t.id}/dub/shots/${t.b}`, { text: 'Ia tersenyum pelan.', voiceId: 'VOICE_BAYU_654321' });
    const plan = (await t.req('POST', `/api/stories/${t.id}/dub/plan`, { scope: { kind: 'shots', shotIds: [t.b] } })).json().plan;
    expect(plan.chars).toBe('Ia tersenyum pelan.'.length);
    await t.req('POST', `/api/stories/${t.id}/dub/render`, { scope: { kind: 'shots', shotIds: [t.b] }, confirmCredits: plan.credits });
    await settle(t, t.id);
    expect(t.calls.tts.map(c => [c.voice, c.body.text])).toEqual([['VOICE_BAYU_654321', 'Ia tersenyum pelan.']]);
    const scene = (await t.req('POST', `/api/stories/${t.id}/dub/plan`, { scope: { kind: 'scene', sceneId: t.sceneId } })).json().plan;
    expect(scene.shotIds).toEqual([t.a]); // the second shot is already fresh
    expect((await t.req('DELETE', `/api/stories/${t.id}/dub/shots/${t.b}`)).json().dub.shots[1].status).toBe('none');
    expect((await t.req('GET', `/api/stories/${t.id}/dub/shots/${t.b}/audio`)).statusCode).toBe(404);
  });

  it('rejects bad input with 400/404, not a crash', async () => {
    const t = await setup();
    expect((await t.req('PUT', `/api/stories/${t.id}/dub/settings`, { modelId: 'gpt-voice' })).statusCode).toBe(400);
    expect((await t.req('PUT', `/api/stories/${t.id}/dub/shots/zzz`, { text: 'x' })).statusCode).toBe(404);
    expect((await t.req('POST', `/api/stories/${t.id}/dub/plan`, { scope: { kind: 'planet' } })).statusCode).toBe(400);
    expect((await t.req('POST', `/api/stories/${t.id}/dub/render`, { scope: { kind: 'all' }, confirmCredits: 0 })).statusCode).toBe(400); // no voice chosen yet
  });

  it('a dub change marks a finished video as "assemble again"', async () => {
    const t = await setup();
    await t.req('POST', '/api/providers/keypool/elevenlabs', { key: EL_KEY });
    await t.req('PUT', `/api/stories/${t.id}/dub/settings`, { voiceId: 'VOICE_ARYA_123456' });
    expect(t.id).toMatch(/^story_/); // the story has no video in this test: marking is a no-op and must not fail
    const plan = (await t.req('POST', `/api/stories/${t.id}/dub/plan`, { scope: { kind: 'all' } })).json().plan;
    await t.req('POST', `/api/stories/${t.id}/dub/render`, { scope: { kind: 'all' }, confirmCredits: plan.credits });
    expect((await settle(t, t.id)).totals.done).toBe(2);
  });
});
