import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

const EL_KEY = 'sk_routes_money_key_0123456789';
const MP3 = Buffer.from('ID3-fake-mp3-'.repeat(100));
const LONG = 'Ini adalah kalimat yang sangat panjang sekali, jauh melebihi apa yang muat di dalam satu klip pendek berdurasi enam detik, sehingga harus dipercepat dan dipotong.';
const board = { title: 'Lentera', scenes: [{ id: 'sc1', title: 'Satu', shots: ['01-a', '02-b'] }], shots: [
  { id: '01-a', prompt: 'Medium shot. A boy waits.', narration: 'Aku menunggu.' },
  { id: '02-b', prompt: 'Close-up. He smiles.', narration: 'Lalu tersenyum.' }
] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let ipSeq = 1;
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function setup(subscription: () => Response) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-dubm-'));
  const tts: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/v1/text-to-speech/')) { tts.push(JSON.parse(String(init!.body)).text); return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } }); }
    if (url.endsWith('/v1/user/subscription')) return subscription();
    return json({ error: { message: `unexpected ${url}` } }, 404);
  }) as unknown as typeof fetch;
  const server = await buildApp({
    dataDir, env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
    stories: { reconcileMs: 0, probe: async () => ({ durationSec: 3.25, hasAudio: true }), assemble: async () => undefined, generateText: async () => JSON.stringify(board) },
    providers: { fetch: fetchImpl, workerMs: 0 }, dub: { fetch: fetchImpl, resume: false }
  });
  close = () => server.close();
  const login = await server.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: `10.8.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`, payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => server.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  await req('POST', '/api/providers/keypool/elevenlabs', { key: EL_KEY });
  const id = (await req('POST', '/api/stories/draft', { premise: 'Anak menunggu di jalan' })).json().story.id as string;
  const ids = (await req('GET', `/api/stories/${id}/dub`)).json().dub.shots.map((x: any) => x.shotId) as string[];
  await req('PUT', `/api/stories/${id}/dub/settings`, { voiceId: 'VOICE_ARYA_123456' });
  return { req, id, ids, tts };
}
const ok = () => json({ tier: 'creator', character_count: 100, character_limit: 100000 });

describe('dub routes: fit, TOO_LONG and the balance gate', () => {
  it('the state carries the fit of each line; a far-too-long line is held back (409 TOO_LONG) until acceptTooLong is sent', async () => {
    const t = await setup(ok);
    await t.req('PUT', `/api/stories/${t.id}/dub/shots/${t.ids[0]}`, { text: LONG });
    const state = (await t.req('GET', `/api/stories/${t.id}/dub`)).json().dub;
    expect(state.shots[0].fit).toMatchObject({ level: 'block', suggestChars: expect.any(Number) });
    expect(state.shots[1].fit.level).toBe('ok');
    const plan = (await t.req('POST', `/api/stories/${t.id}/dub/plan`, { scope: { kind: 'all' } })).json().plan;
    expect(plan.blocked).toEqual([t.ids[0]]);
    const refused = await t.req('POST', `/api/stories/${t.id}/dub/render`, { scope: { kind: 'all' }, confirmCredits: plan.credits });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('TOO_LONG');
    expect(t.tts).toHaveLength(0);
    const accepted = await t.req('POST', `/api/stories/${t.id}/dub/render`, { scope: { kind: 'all' }, confirmCredits: plan.credits, acceptTooLong: true });
    expect(accepted.statusCode).toBe(202);
    for (let i = 0; i < 80 && (await t.req('GET', `/api/stories/${t.id}/dub`)).json().dub.totals.active > 0; i++) await new Promise(r => setTimeout(r, 25));
    expect([...t.tts].sort()).toEqual([LONG, 'Lalu tersenyum.'].sort());
  });

  it('a balance below the estimate is refused with 409 INSUFFICIENT before any provider call', async () => {
    const t = await setup(() => json({ tier: 'free', character_count: 9_990, character_limit: 10_000 })); // 10 left
    const plan = (await t.req('POST', `/api/stories/${t.id}/dub/plan`, { scope: { kind: 'all' } })).json().plan;
    expect(plan.credits).toBeGreaterThan(10);
    const refused = await t.req('POST', `/api/stories/${t.id}/dub/render`, { scope: { kind: 'all' }, confirmCredits: plan.credits });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('INSUFFICIENT');
    expect(t.tts).toHaveLength(0);
  });
});
