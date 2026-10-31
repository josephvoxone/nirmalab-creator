import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { QuotaError } from '../src/quota/errors.js';
import { SpendLedger } from '../src/quota/ledger.js';
import { LimitsStore } from '../src/quota/limits.js';
import type { Storyboard } from '../src/stories/storyboard.js';
import { creditsFor, ID, makeHarness, type Harness } from './dub-harness.js';

const ID2 = 'story_bbbbbbbbbbbbbbbb';
const all = { kind: 'all' } as const;
/** 21 shots of 68 characters = 1.428: the size of the Lentera project (1.426 characters). */
const lentera = (): Storyboard => ({
  title: 'Lentera', scenes: [{ id: 'sc', title: 'Satu', shots: Array.from({ length: 21 }, (_, i) => `s${i + 1}`) }],
  shots: Array.from({ length: 21 }, (_, i) => ({ id: `s${i + 1}`, prompt: `p${i + 1}`, narration: `Kalimat nomor ${String(i + 1).padStart(2, '0')} ${'a'.repeat(68 - 'Kalimat nomor 00 '.length - 1)}.` }))
} as Storyboard);
const big = (chars: number): Storyboard => ({ title: 'Panjang', scenes: [{ id: 'sc', title: 'Satu', shots: ['s1', 's2', 's3'] }], shots: ['s1', 's2', 's3'].map((id, i) => ({ id, prompt: id, narration: `${'b'.repeat(Math.floor(chars / 3) - 1 - i)}.` })) } as Storyboard);

let hs: Harness[] = [];
let dirs: string[] = [];
afterEach(() => { hs.forEach(h => h.cleanup()); dirs.forEach(d => rmSync(d, { recursive: true, force: true })); hs = []; dirs = []; });

function ledgerFor(admins: string[] = []) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-eq-')); dirs.push(dataDir);
  const limits = new LimitsStore(dataDir, id => admins.includes(id));
  const ledger = new SpendLedger(dataDir, { limitFor: limits.resolve });
  return { dataDir, limits, ledger };
}
function harness(ledger: SpendLedger, board: Storyboard, extra: Parameters<typeof makeHarness>[0] = {}) {
  const h = makeHarness({ board, quota: ledger, ...extra }); hs.push(h); return h;
}
const render = async (h: Harness, id: string, owner: string, scope: Parameters<Harness['svc']['plan']>[1] = all, extra: { acceptTooLong?: boolean } = {}) => {
  await h.svc.updateSettings(id, { voiceId: 'V1' });
  return h.svc.render(id, scope, { owner, confirmCredits: (await h.svc.plan(id, scope)).credits, ...extra });
};

describe('T5b ElevenLabs quota (DubService.render / renderShot)', () => {
  it('non-admin: a Lentera-sized dub (1.426 chars) passes, a second project the same day is refused with the numbers — and the provider is not called', async () => {
    const t = ledgerFor();
    const h = harness(t.ledger, lentera());
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const chars = (await h.svc.plan(ID, all)).chars;
    expect(chars).toBeGreaterThan(1400); expect(chars).toBeLessThan(1500);
    await render(h, ID, 'member'); await h.svc.idle(ID);
    expect(h.calls).toHaveLength(21);
    expect((await t.ledger.usage('member')).elevenChars).toMatchObject({ day: chars, d30: chars, reserved: 0 });
    const before = h.calls.length;
    const refused = await render(h, ID2, 'member').catch(e => e as QuotaError);
    expect(refused).toBeInstanceOf(QuotaError);
    expect(refused.message).toBe(`Batas dubbing hari ini habis: terpakai ${String(chars).replace(/\B(?=(\d{3})+$)/g, '.')} dari 2.000 karakter; dubbing ini ${String(chars).replace(/\B(?=(\d{3})+$)/g, '.')} karakter. Coba lagi besok atau persingkat teksnya.`);
    await h.svc.idle(ID2);
    expect(h.calls).toHaveLength(before);
    expect((await h.svc.state(ID2)).shots.every(s => s.status === 'none')).toBe(true); // nothing marked queued
    expect((await t.ledger.usage('member')).elevenChars.reserved).toBe(0);
  });

  it('admin: no ElevenLabs limit, however much they dub', async () => {
    const t = ledgerFor(['boss']);
    const h = harness(t.ledger, lentera());
    for (const id of [ID, ID2, 'story_cccccccccccccccc']) { await render(h, id, 'boss'); await h.svc.idle(id); }
    expect(h.calls).toHaveLength(63);
    expect((await t.ledger.usage('boss')).elevenChars.day).toBeGreaterThan(4000);
  });

  it("user A using up their limit does not touch B's", async () => {
    const t = ledgerFor();
    const h = harness(t.ledger, lentera());
    await render(h, ID, 'a'); await h.svc.idle(ID);
    await expect(render(h, ID2, 'a')).rejects.toBeInstanceOf(QuotaError);
    await render(h, ID2, 'b'); await h.svc.idle(ID2);
    expect((await t.ledger.usage('b')).elevenChars.day).toBeGreaterThan(1400);
  });

  it('two renders at the same moment cannot both take the last room (non-admin, 2.000/day, two 1.428-char projects)', async () => {
    const t = ledgerFor();
    const h = harness(t.ledger, lentera(), { delayMs: 30 });
    await h.svc.updateSettings(ID, { voiceId: 'V1' }); await h.svc.updateSettings(ID2, { voiceId: 'V1' });
    const credits = (await h.svc.plan(ID, all)).credits;
    const results = await Promise.allSettled([ID, ID2].map(id => h.svc.render(id, all, { owner: 'member', confirmCredits: credits })));
    await Promise.all([h.svc.idle(ID), h.svc.idle(ID2)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(h.calls).toHaveLength(21);
  });

  it('more than 2.500 characters in one render: refused with the per-render message, even for a fresh day', async () => {
    const t = ledgerFor();
    const h = harness(t.ledger, big(2700));
    const refused = await render(h, ID, 'member', all, { acceptTooLong: true }).catch(e => e as QuotaError);
    expect(refused).toBeInstanceOf(QuotaError);
    expect(refused).toMatchObject({ window: 'render', limit: 2500 });
    expect(refused.message).toMatch(/^Satu dubbing maksimal 2\.500 karakter; yang ini 2\.[67]\d\d\. Pecah per scene\.$/);
    expect(h.calls).toHaveLength(0);
    // the same text one scene (one shot) at a time fits
    await h.svc.render(ID, { kind: 'shots', shotIds: ['s1'] }, { owner: 'member', confirmCredits: await creditsFor(h, { kind: 'shots', shotIds: ['s1'] }), acceptTooLong: true });
    await h.svc.idle(ID);
    expect(h.calls).toHaveLength(1);
  });

  it('two identical dub/render requests: one reservation, the provider is called once per shot', async () => {
    const t = ledgerFor();
    const h = harness(t.ledger, lentera(), { delayMs: 20 });
    await h.svc.updateSettings(ID, { voiceId: 'V1' });
    const credits = (await h.svc.plan(ID, all)).credits;
    await Promise.all([h.svc.render(ID, all, { owner: 'member', confirmCredits: credits }), h.svc.render(ID, all, { owner: 'member', confirmCredits: credits })]);
    await h.svc.idle(ID);
    expect(h.calls).toHaveLength(21);
    const chars = (await h.svc.plan(ID, all, { force: false })).chars; // everything is fresh now
    expect(chars).toBe(0);
    expect((await t.ledger.usage('member')).elevenChars.day).toBeGreaterThan(1400);
    expect((await t.ledger.usage('member')).elevenChars.day).toBeLessThan(1500);
  });

  it('a failed synthesis gives the reservation back (nothing was billed)', async () => {
    const t = ledgerFor();
    const h = harness(t.ledger, lentera(), { fail: () => new Error('boom') });
    await render(h, ID, 'member'); await h.svc.idle(ID);
    expect((await t.ledger.usage('member')).elevenChars).toMatchObject({ day: 0, reserved: 0 });
    expect((await h.svc.state(ID)).totals.failed).toBe(21);
  });

  it('cancel before a shot starts gives its reservation back', async () => {
    const t = ledgerFor();
    const h = harness(t.ledger, lentera(), { concurrency: 1, delayMs: 40 });
    await render(h, ID, 'member');
    await new Promise(r => setTimeout(r, 15));
    await h.svc.cancel(ID); await h.svc.idle(ID);
    const u = (await t.ledger.usage('member')).elevenChars;
    expect(u.reserved).toBe(0);
    expect(u.day).toBeLessThan(200); // at most the shot that was already being made
  });

  it('resume after a restart uses the reservation made before it: the dub is counted once', async () => {
    const t = ledgerFor();
    const first = harness(t.ledger, lentera(), { hang: true });
    await render(first, ID, 'member', { kind: 'shots', shotIds: ['s1'] });
    await new Promise(r => setTimeout(r, 30));
    expect(first.calls).toHaveLength(1);
    const open = await t.ledger.open();
    expect(open).toHaveLength(1);
    // "restart": a new ledger instance on the same file, a new service on the same story files
    const ledger2 = new SpendLedger(t.dataDir, { limitFor: t.limits.resolve });
    const second = harness(ledger2, lentera(), { dir: first.dir });
    await second.svc.resume([ID]); await second.svc.idle(ID);
    expect(second.calls).toHaveLength(1);
    const u = (await ledger2.usage('member')).elevenChars;
    expect(u.reserved).toBe(0);
    expect(u.day).toBe(open[0]!.amount);
  });

  it('a limit changed by an admin counts for the NEXT reservation only', async () => {
    const t = ledgerFor();
    await t.limits.init();
    const h = harness(t.ledger, lentera());
    await render(h, ID, 'member'); await h.svc.idle(ID); // 1.428 of 2.000 used
    await t.limits.set('member', { elevenChars: { perDay: 5000, per30d: 5000, perRender: 2500 } });
    await render(h, ID2, 'member'); await h.svc.idle(ID2); // 2.856 now fits
    expect(h.calls).toHaveLength(42);
  });
});

describe('T5b ElevenLabs quota over HTTP', () => {
  it('admin sets a limit on themselves: dub/render answers 429 QUOTA and ElevenLabs is never called; remove the limit and it renders', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-eqh-')); dirs.push(dataDir);
    const tts: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v1/text-to-speech/')) { tts.push(JSON.parse(String(init!.body)).text); return new Response(Buffer.from('ID3-fake-mp3-'.repeat(100)), { status: 200, headers: { 'content-type': 'audio/mpeg' } }); }
      if (url.endsWith('/v1/user/subscription')) return new Response(JSON.stringify({ tier: 'creator', character_count: 100, character_limit: 100000 }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ error: { message: 'unexpected' } }), { status: 404 });
    }) as unknown as typeof fetch;
    const server = await buildApp({
      dataDir, env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
      stories: { reconcileMs: 0, probe: async () => ({ durationSec: 3.25, hasAudio: true }), assemble: async () => undefined, generateText: async () => JSON.stringify(lentera()) },
      providers: { fetch: fetchImpl, workerMs: 0 }, dub: { fetch: fetchImpl, resume: false }
    });
    try {
      const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0]!;
      const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => server.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
      await req('POST', '/api/providers/keypool/elevenlabs', { key: 'sk_test_0123456789abcdef' });
      const id = (await req('POST', '/api/stories/draft', { premise: 'Anak menunggu di jalan' })).json().story.id as string;
      await req('PUT', `/api/stories/${id}/dub/settings`, { voiceId: 'VOICE_ARYA_123456' });
      const me = (await req('GET', '/api/auth/me')).json().user.id as string;
      expect((await req('PUT', `/api/quota/limits/${me}`, { limits: { elevenChars: { perDay: 500 } } })).statusCode).toBe(200);
      const plan = (await req('POST', `/api/stories/${id}/dub/plan`, { scope: { kind: 'all' } })).json();
      const credits = (plan.plan ?? plan).credits as number;
      const refused = await req('POST', `/api/stories/${id}/dub/render`, { scope: { kind: 'all' }, confirmCredits: credits });
      expect(refused.statusCode).toBe(429);
      expect(refused.json().error).toMatchObject({ code: 'QUOTA', kind: 'elevenChars', window: 'day', limit: 500 });
      expect(tts).toHaveLength(0);
      expect((await req('PUT', `/api/quota/limits/${me}`, { limits: {} })).statusCode).toBe(200); // admin default: unlimited
      const ok = await req('POST', `/api/stories/${id}/dub/render`, { scope: { kind: 'all' }, confirmCredits: credits });
      expect(ok.statusCode).toBe(202);
    } finally { await server.close(); }
  });
});
