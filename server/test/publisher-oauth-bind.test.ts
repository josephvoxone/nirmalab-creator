import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuthStateStore } from '../src/publisher/oauth-state.js';
import { publisherWorld } from './publisher-world.js';

const errorOf = (res: { headers: Record<string, unknown> }): { connected: string | null; error: string | null; platform: string | null } => {
  const url = new URL(String(res.headers.location));
  return { connected: url.searchParams.get('connected'), error: url.searchParams.get('error'), platform: url.searchParams.get('platform') };
};

afterEach(() => { vi.useRealTimers(); });

describe('T7.3 — OAuth state is bound to the user who started it (the callback is a PUBLIC route)', () => {
  it('PoC hijack: B (own session) replays A\'s state with the attacker\'s code → refused, nothing is stored for A or B', async () => {
    const w = await publisherWorld();
    const { state } = await w.connect(w.cookies.joseph);
    const stolen = await w.callback(w.cookies.bina, state, 'EVIL');
    expect(stolen.statusCode).toBe(302);
    const out = errorOf(stolen);
    expect(out.connected).toBeNull();
    expect(out.error).toMatch(/akun lain/i);
    expect((await w.yt(w.cookies.joseph)).connected).toBe(false);
    expect((await w.yt(w.cookies.bina)).connected).toBe(false);
    expect(w.google.uploads).toEqual([]);
  });

  it('PoC login-CSRF: an anonymous browser (victim not logged in) with the attacker\'s state is refused with a "log in first" message', async () => {
    const w = await publisherWorld();
    const { state } = await w.connect(w.cookies.bina); // attacker starts a flow with their own account
    const res = await w.callback(undefined, state, 'ATTACKER-ACCOUNT');
    const out = errorOf(res);
    expect(out.connected).toBeNull();
    expect(out.error).toMatch(/belum masuk/i);
    expect((await w.yt(w.cookies.bina)).connected).toBe(false);
  });

  it('PoC login-CSRF: the attacker\'s state delivered to a logged-in VICTIM is refused (victim\'s account is not linked to the attacker\'s channel)', async () => {
    const w = await publisherWorld();
    const { state } = await w.connect(w.cookies.bina);
    const res = await w.callback(w.cookies.joseph, state, 'ATTACKER-ACCOUNT');
    expect(errorOf(res).connected).toBeNull();
    expect((await w.yt(w.cookies.joseph)).connected).toBe(false);
    expect((await w.yt(w.cookies.bina)).connected).toBe(false);
  });

  it('a refused attempt does not burn the state: the rightful user still completes their own connection', async () => {
    const w = await publisherWorld();
    const { state } = await w.connect(w.cookies.joseph);
    expect(errorOf(await w.callback(w.cookies.bina, state, 'EVIL')).connected).toBeNull();
    expect(errorOf(await w.callback(undefined, state, 'EVIL')).connected).toBeNull();
    const ok = await w.callback(w.cookies.joseph, state, 'A1');
    expect(errorOf(ok).connected).toBe('youtube');
    expect(await w.yt(w.cookies.joseph)).toMatchObject({ connected: true, accountLabel: 'Channel(at-A1)' });
    expect((await w.yt(w.cookies.bina)).connected).toBe(false);
  });

  it('the state is single-use: replaying a completed callback is refused and changes nothing', async () => {
    const w = await publisherWorld();
    const { state } = await w.connect(w.cookies.joseph);
    expect(errorOf(await w.callback(w.cookies.joseph, state, 'A1')).connected).toBe('youtube');
    const replay = await w.callback(w.cookies.joseph, state, 'A2');
    expect(errorOf(replay).connected).toBeNull();
    expect(errorOf(replay).error).toMatch(/kedaluwarsa/i);
    expect(await w.yt(w.cookies.joseph)).toMatchObject({ accountLabel: 'Channel(at-A1)' });
  });

  it('the state expires (10 minutes) and a state for another platform is refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const w = await publisherWorld();
    const { state } = await w.connect(w.cookies.joseph);
    expect(errorOf(await w.callback(w.cookies.joseph, state, 'A1', 'tiktok')).connected).toBeNull();
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1000);
    const late = await w.callback(w.cookies.joseph, state, 'A1');
    expect(errorOf(late).connected).toBeNull();
    expect(errorOf(late).error).toMatch(/kedaluwarsa/i);
    expect((await w.yt(w.cookies.joseph)).connected).toBe(false);
  });

  it('a made-up or missing state is refused; a provider error comes back as a plain message', async () => {
    const w = await publisherWorld();
    expect(errorOf(await w.callback(w.cookies.joseph, 'f'.repeat(48), 'A1')).connected).toBeNull();
    const denied = await w.server.inject({ url: '/api/publish/youtube/callback?error=access_denied&state=x', headers: { cookie: w.cookies.joseph } });
    expect(errorOf(denied).error).toMatch(/izin akses ditolak/i);
    const empty = await w.server.inject({ url: '/api/publish/youtube/callback', headers: { cookie: w.cookies.joseph } });
    expect(errorOf(empty).connected).toBeNull();
  });

  it('every refusal message is plain Indonesian and names the platform', async () => {
    const w = await publisherWorld();
    const { state } = await w.connect(w.cookies.joseph, 'youtube');
    const wrong = errorOf(await w.callback(w.cookies.bina, state, 'EVIL'));
    const anon = errorOf(await w.callback(undefined, state, 'EVIL'));
    expect(wrong.platform).toBe('youtube');
    expect(wrong.error).toBe('Tautan ini dimulai dari akun lain. Masuk dengan akun yang menghubungkan YouTube, lalu coba lagi.');
    expect(anon.error).toBe('Kamu belum masuk. Masuk ke Nirmalab Creator dulu, lalu hubungkan YouTube lagi.');
  });
});

describe('OAuthStateStore', () => {
  it('create binds the user; consume needs the same user and removes the state only on success', () => {
    const store = new OAuthStateStore();
    const state = store.create('youtube', 'u_alpha');
    expect(store.consume(state, 'youtube', 'u_beta')).toEqual({ ok: false, reason: 'wrong-user' });
    expect(store.consume(state, 'youtube', undefined)).toEqual({ ok: false, reason: 'anonymous' });
    expect(store.consume(state, 'tiktok', 'u_alpha')).toEqual({ ok: false, reason: 'unknown' });
    const ok = store.consume(state, 'youtube', 'u_alpha');
    expect(ok).toMatchObject({ ok: true, record: { userId: 'u_alpha', platform: 'youtube' } });
    expect(store.consume(state, 'youtube', 'u_alpha')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('states are unique and unguessable (192 random bits)', () => {
    const store = new OAuthStateStore();
    const seen = new Set(Array.from({ length: 200 }, () => store.create('youtube', 'u_alpha')));
    expect(seen.size).toBe(200);
    for (const s of seen) expect(s).toMatch(/^[0-9a-f]{48}$/);
  });

  it('revokeAllFor drops that user\'s pending states only', () => {
    const store = new OAuthStateStore();
    const a = store.create('youtube', 'u_alpha');
    const b = store.create('youtube', 'u_beta');
    expect(store.revokeAllFor('u_alpha')).toBe(1);
    expect(store.consume(a, 'youtube', 'u_alpha')).toEqual({ ok: false, reason: 'unknown' });
    expect(store.consume(b, 'youtube', 'u_beta').ok).toBe(true);
  });
});
