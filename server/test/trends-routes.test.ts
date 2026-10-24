/**
 * Trend routes: authentication, validation, the 30-minute disk cache, and "Jadikan proyek"
 * (clone → draft story). No network: sources are injected fakes over recorded fixtures, and the
 * clock is fixed.
 */
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { validateBible } from '../src/bible/story.js';
import { UserAuthStore } from '../src/auth/store.js';
import { buildApp } from '../src/app.js';
import { validateStoryboard, type Storyboard } from '../src/stories/storyboard.js';
import { enrichSeeds } from '../src/trends/pipeline.js';
import { TREND_CACHE_MS, registerTrendRoutes } from '../src/trends/routes.js';
import { mapYouTubeVideo } from '../src/trends/youtube.js';
import type { TrendItem, TrendSeed, TrendSource, TrendSourceId } from '../src/trends/types.js';

const NOW = 1_792_929_600_000;
const HOUR = 3_600_000;

const fixture = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(new URL(`./fixtures/trends/${name}`, import.meta.url), 'utf8')) as Record<string, any>;

/** The three YouTube seeds from the recorded fixture, with durations filled in. */
function seeds(): TrendSeed[] {
  const durations: Record<string, number> = { aQ1bC2dE3fG: 42, zY9xW8vU7tS: 198, pL4kM5nB6vC: 3_723 };
  return (fixture('youtube-popular.json').items as Record<string, unknown>[])
    .map(video => mapYouTubeVideo(video as never, 'ID', durations))
    .filter((seed): seed is TrendSeed => !!seed);
}

type FakeSource = { source: TrendSource; calls: () => number };

function fakeSource(id: TrendSourceId, options: { configured?: boolean; seeds?: TrendSeed[]; throw?: boolean } = {}): FakeSource {
  let calls = 0;
  const source: TrendSource = {
    id,
    configured: () => options.configured ?? true,
    async fetch(query): Promise<TrendItem[]> {
      calls += 1;
      if (options.throw) throw new Error('platform down');
      return enrichSeeds(options.seeds ?? seeds(), query, query.nowMs);
    }
  };
  return { source, calls: () => calls };
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup(options: {
  sources?: TrendSource[];
  ttlMs?: number;
  now?: () => number;
  store?: UserAuthStore;
  stories?: { create: (board: Storyboard, opts?: { createdBy?: string }) => Promise<unknown> };
} = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'oc-trends-'));
  const store = options.store ?? new UserAuthStore(dataDir);
  const admin = await store.createUser({ email: `admin${Math.random()}@x.io`, password: 'admin-pass-1', isAdmin: true });
  const member = await store.createUser({ email: `member${Math.random()}@x.io`, password: 'member-pass-1', isAdmin: false });
  const adminCookie = `oc_session=${store.createSession(admin.id).token}`;
  const memberCookie = `oc_session=${store.createSession(member.id).token}`;

  const created: Storyboard[] = [];
  const stories = options.stories ?? {
    create: async (board: Storyboard) => {
      created.push(board);
      return { id: 'story_0123456789abcdef', title: board.title, status: 'draft' as const };
    }
  };

  const server: FastifyInstance = Fastify({ logger: false });
  await registerTrendRoutes(server, {
    userAuthStore: store,
    dataDir,
    stories: stories as never,
    sources: options.sources ?? [],
    nowMs: options.now ?? (() => NOW),
    ...(options.ttlMs === undefined ? {} : { cacheTtlMs: options.ttlMs })
  });
  await server.ready();
  close = () => server.close();

  const get = (url: string, cookie: string) => server.inject({ method: 'GET', url, headers: { cookie } });
  const post = (url: string, cookie: string, payload?: unknown) =>
    server.inject({ method: 'POST', url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  return { dataDir, server, admin, member, adminCookie, memberCookie, get, post, created };
}

describe('GET /api/trends', () => {
  it('requires a session', async () => {
    const t = await setup({ sources: [fakeSource('youtube').source] });
    const res = await t.server.inject({ method: 'GET', url: '/api/trends' });
    expect(res.statusCode).toBe(401);
  });

  it('serves cards to a member, with per-source flags and the generation time', async () => {
    const youtube = fakeSource('youtube');
    const tiktok = fakeSource('tiktok', { configured: false });
    const t = await setup({ sources: [youtube.source, tiktok.source] });
    const res = await t.get('/api/trends?region=ID&window=24h', t.memberCookie);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ region: 'ID', window: '24h', windowHours: 24, niche: null, generatedAtMs: NOW, cached: false });
    expect(body.configured).toBe(true);
    expect(body.sources).toEqual({ youtube: true, tiktok: false });
    expect(body.missing).toEqual(['TRENDS_DTK_URL']);
    expect(body.detail).toEqual({
      youtube: { configured: true, items: 1 },
      tiktok: { configured: false, items: 0 }
    });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: 'aQ1bC2dE3fG', source: 'youtube', score: 75 });
    expect(tiktok.calls()).toBe(0); // unconfigured sources are never called
  });

  it('defaults to ID / 24 h and accepts the window by name or by hours', async () => {
    const t = await setup({ sources: [fakeSource('youtube').source] });
    expect((await t.get('/api/trends', t.memberCookie)).json()).toMatchObject({ region: 'ID', window: '24h', windowHours: 24 });
    expect((await t.get('/api/trends?window=7d', t.memberCookie)).json()).toMatchObject({ window: '7d', windowHours: 168 });
    expect((await t.get('/api/trends?window=720', t.memberCookie)).json()).toMatchObject({ window: '30d', windowHours: 720 });
    expect((await t.get('/api/trends?region=us', t.memberCookie)).json()).toMatchObject({ region: 'US' });
  });

  it('is 400 for a bad region, window or niche', async () => {
    const t = await setup({ sources: [fakeSource('youtube').source] });
    for (const [query, message] of [
      ['?region=XX', 'region harus salah satu dari: ID, US, JP, KR, BR, GB'],
      ['?window=48h', 'window harus 24h, 7d atau 30d'],
      ['?window=48', 'window harus 24h, 7d atau 30d'],
      ['?niche=horor', 'niche harus salah satu dari: ai, cinematic, faceless, anak, cerita']
    ] as const) {
      const res = await t.get(`/api/trends${query}`, t.memberCookie);
      expect(res.statusCode, query).toBe(400);
      expect(res.json().error).toEqual({ code: 'INVALID_INPUT', message });
    }
  });

  it('serves the cache for 30 minutes: a hit makes no fetch at all', async () => {
    const youtube = fakeSource('youtube');
    const t = await setup({ sources: [youtube.source] });
    const first = (await t.get('/api/trends?region=ID&window=24h&niche=ai', t.memberCookie)).json();
    const second = (await t.get('/api/trends?region=ID&window=24h&niche=ai', t.memberCookie)).json();

    expect(youtube.calls()).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.generatedAtMs).toBe(first.generatedAtMs);
    expect(second.items).toEqual(first.items);

    // The cache is per (region, window, niche): another niche is another key.
    await t.get('/api/trends?region=ID&window=24h&niche=cerita', t.memberCookie);
    expect(youtube.calls()).toBe(2);

    const files = readdirSync(join(t.dataDir, 'trends', 'cache')).sort();
    expect(files).toEqual(['ID-24h-ai.json', 'ID-24h-cerita.json']);
  });

  it('refetches once the 30-minute cache is stale', async () => {
    const youtube = fakeSource('youtube');
    let clock = NOW;
    const t = await setup({ sources: [youtube.source], now: () => clock });
    await t.get('/api/trends?region=ID&window=24h', t.memberCookie);

    clock = NOW + TREND_CACHE_MS - 1;
    expect((await t.get('/api/trends?region=ID&window=24h', t.memberCookie)).json().cached).toBe(true);
    expect(youtube.calls()).toBe(1);

    clock = NOW + TREND_CACHE_MS + 1;
    const stale = (await t.get('/api/trends?region=ID&window=24h', t.memberCookie)).json();
    expect(stale.cached).toBe(false);
    expect(stale.generatedAtMs).toBe(clock);
    expect(youtube.calls()).toBe(2);
  });

  it('survives a source that throws: the page is empty, not broken', async () => {
    const t = await setup({ sources: [fakeSource('youtube', { throw: true }).source, fakeSource('tiktok').source] });
    const res = await t.get('/api/trends?region=ID&window=24h', t.memberCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().sources).toEqual({ youtube: true, tiktok: true });
    expect(res.json().detail.youtube).toEqual({ configured: true, items: 0 });
    expect(res.json().detail.tiktok).toEqual({ configured: true, items: 1 });
    expect(res.json().items).toHaveLength(1);
  });

  it('reports every platform as unconfigured instead of failing (P3a with P3b blocked)', async () => {
    const t = await setup({ sources: [fakeSource('youtube', { configured: false }).source, fakeSource('tiktok', { configured: false }).source] });
    const res = await t.get('/api/trends', t.memberCookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configured: false, sources: { youtube: false, tiktok: false }, items: [] });
    expect(res.json().missing).toEqual(['YOUTUBE_API_KEY', 'TRENDS_DTK_URL']);
    expect(res.json().sources.youtube).toBe(false);
  });
});

describe('POST /api/trends/:id/clone', () => {
  it('ignores a cache file written by an older wire shape instead of serving it', async () => {
    const t = await setup({ sources: [fakeSource('youtube', { seeds: seeds().slice(0, 1) }).source] });
    const first = await t.get('/api/trends?region=ID&window=24h', t.memberCookie);
    expect(first.json().configured).toBe(true);
    const file = join(t.dataDir, 'trends', 'cache', 'ID-24h-semua.json');
    const legacy = JSON.parse(readFileSync(file, 'utf8'));
    delete legacy.v;
    legacy.configured = ['youtube'];
    writeFileSync(file, JSON.stringify(legacy));
    const second = await t.get('/api/trends?region=ID&window=24h', t.memberCookie);
    expect(second.json().cached).toBe(false);
    expect(typeof second.json().configured).toBe('boolean');
    expect(Array.isArray(second.json().missing)).toBe(true);
  });

  it('is 409 when nothing has been cached yet, 404 when the id is unknown', async () => {
    const t = await setup({ sources: [fakeSource('youtube').source] });
    expect((await t.post('/api/trends/aQ1bC2dE3fG/clone', t.adminCookie)).statusCode).toBe(409);
    expect((await t.post('/api/trends/aQ1bC2dE3fG/clone', t.adminCookie)).json().error.code).toBe('NO_TREND_DATA');

    await t.get('/api/trends?region=ID&window=24h', t.memberCookie);
    const missing = await t.post('/api/trends/nope-123/clone', t.adminCookie);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toMatchObject({ code: 'TREND_NOT_FOUND' });
  });

  it('is admin only', async () => {
    const t = await setup({ sources: [fakeSource('youtube').source] });
    await t.get('/api/trends?region=ID&window=24h', t.memberCookie);
    expect((await t.post('/api/trends/aQ1bC2dE3fG/clone', t.memberCookie)).statusCode).toBe(403);
    expect((await t.post('/api/trends/aQ1bC2dE3fG/clone', '')).statusCode).toBe(401);
  });

  it('creates a draft story with a bible and empty shots, and returns it', async () => {
    const t = await setup({ sources: [fakeSource('youtube').source] });
    await t.get('/api/trends?region=ID&window=24h', t.memberCookie);
    const res = await t.post('/api/trends/aQ1bC2dE3fG/clone', t.adminCookie);

    expect(res.statusCode).toBe(201);
    expect(res.json().story).toMatchObject({ id: 'story_0123456789abcdef', status: 'draft' });
    expect(Object.keys(res.json())).toEqual(['story']);

    const board = t.created[0]!;
    expect(board.title).toBe('Kenapa AI bikin film terasa aneh? (versi baru)');
    expect(validateStoryboard(board)).toEqual([]);
    expect(validateBible(board.bible)).toEqual([]);
    expect(board.bible!.structure.map(beat => beat.act)).toEqual(['hook', 'setup', 'turn', 'payoff']);
    expect(board.shots).toHaveLength(12);
    expect(board.shots.every(shot => shot.intent?.subject === '' && shot.prompt === '')).toBe(true);
    expect(board.scenes!.map(scene => scene.id)).toEqual(['hook', 'setup', 'turn', 'payoff']);
  });

  it('records who cloned it', async () => {
    const seen: Array<{ createdBy?: string } | undefined> = [];
    const t = await setup({
      sources: [fakeSource('youtube').source],
      stories: { create: async (board: Storyboard, opts?: { createdBy?: string }) => { seen.push(opts); return { id: 'story_x', title: board.title }; } }
    });
    await t.get('/api/trends?region=ID&window=24h', t.memberCookie);
    await t.post('/api/trends/aQ1bC2dE3fG/clone', t.adminCookie);
    expect(seen).toEqual([{ createdBy: t.admin.id }]);
  });

  it('finds the item in any cached window, not only the first file', async () => {
    const t = await setup({ sources: [fakeSource('youtube').source] });
    await t.get('/api/trends?region=ID&window=24h', t.memberCookie);
    // zY9xW8vU7tS is 3 days old: only the 30-day cache carries it.
    await t.get('/api/trends?region=ID&window=30d', t.memberCookie);
    expect((await t.post('/api/trends/zY9xW8vU7tS/clone', t.adminCookie)).statusCode).toBe(201);
  });

  it('is 400 for a malformed id, and for a story service that rejects the board', async () => {
    const t = await setup({
      sources: [fakeSource('youtube').source],
      stories: { create: async () => { throw new Error('storyboard has no shots'); } }
    });
    expect((await t.post('/api/trends/nope!id/clone', t.adminCookie)).statusCode).toBe(400);
    await t.get('/api/trends?region=ID&window=24h', t.memberCookie);
    const res = await t.post('/api/trends/aQ1bC2dE3fG/clone', t.adminCookie);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'INVALID_STORY', message: 'storyboard has no shots' });
  });

  it('ignores an unreadable cache file instead of failing the lookup', async () => {
    const t = await setup({ sources: [fakeSource('youtube').source] });
    await t.get('/api/trends?region=ID&window=24h', t.memberCookie);
    writeFileSync(join(t.dataDir, 'trends', 'cache', 'broken.json'), '{ not json');
    expect((await t.post('/api/trends/aQ1bC2dE3fG/clone', t.adminCookie)).statusCode).toBe(201);
  });
});

describe('wired into the app', () => {
  it('GET /api/trends answers for a logged-in admin with every source unconfigured', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'oc-trends-app-'));
    const server = await buildApp({
      dataDir,
      env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
      stories: { reconcileMs: 0, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined },
      providers: { workerMs: 0 },
      media: { cleanupMs: 0 }
    });
    close = () => server.close();

    const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const res = await server.inject({ method: 'GET', url: '/api/trends?region=ID&window=24h', headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configured: false, items: [] });
    expect(Object.keys(res.json().sources).sort()).toEqual(['douyin', 'instagram', 'tiktok', 'youtube']);
    expect(res.json().sources.youtube).toBe(false);
    expect(res.json().detail.youtube).toEqual({ configured: false, items: 0 });
  });
});
