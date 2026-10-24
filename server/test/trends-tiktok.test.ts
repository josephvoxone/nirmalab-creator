/**
 * TikTok / Douyin source — the self-hosted DTK service. Offline: an injected fetch answers with
 * the recorded DTK v1 envelope shape (`{success, data:{items}, error, meta}`).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DTK_DEFAULT_HASHTAG,
  DTK_PAGE,
  DTK_ROUTES,
  createDouyinSource,
  createTikTokSource,
  dtkPageItems,
  mapDtkContent,
  mapDtkTrending
} from '../src/trends/tiktok.js';

const NOW = 1_792_929_600_000;
const BASE = 'http://dtk.test:8000';

const fixture = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(new URL(`./fixtures/trends/${name}`, import.meta.url), 'utf8')) as Record<string, any>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(answer: (url: URL) => Response | undefined) {
  const calls: URL[] = [];
  const headers: Array<Record<string, string> | undefined> = [];
  const impl = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = new URL(String(input));
    calls.push(url);
    headers.push(init?.headers);
    return answer(url) ?? json({ success: false, data: null, error: { code: 'NOT_FOUND' } }, 404);
  }) as unknown as typeof fetch;
  return { impl, calls, headers };
}

function tiktokFetch() {
  return fakeFetch(url => {
    if (url.pathname === DTK_ROUTES.searchPosts('tiktok')) return json(fixture('tiktok-search.json'));
    if (url.pathname === DTK_ROUTES.hashtag('tiktok')) return json(fixture('tiktok-hashtag.json'));
    if (url.pathname === DTK_ROUTES.hashtagPosts('tiktok')) return json(fixture('tiktok-hashtag-posts.json'));
    return undefined;
  });
}

function douyinFetch() {
  return fakeFetch(url => (url.pathname === DTK_ROUTES.trending('douyin') ? json(fixture('douyin-trending.json')) : undefined));
}

describe('DTK route map', () => {
  it('is the one place the documented paths live', () => {
    expect(DTK_ROUTES.trending('douyin')).toBe('/api/v1/douyin/trending');
    expect(DTK_ROUTES.searchPosts('tiktok')).toBe('/api/v1/tiktok/search/posts');
    expect(DTK_ROUTES.hashtag('tiktok')).toBe('/api/v1/tiktok/hashtag');
    expect(DTK_ROUTES.hashtagPosts('tiktok')).toBe('/api/v1/tiktok/hashtag/posts');
  });

  it('reads a page from the v1 shape and from the old sync shape', () => {
    expect(dtkPageItems({ items: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(dtkPageItems({ itemList: [{ b: 2 }] })).toEqual([{ b: 2 }]);
    expect(dtkPageItems([{ c: 3 }])).toEqual([{ c: 3 }]);
    expect(dtkPageItems({ nope: true })).toEqual([]);
    expect(dtkPageItems(null)).toEqual([]);
  });
});

describe('TikTok source', () => {
  it('is not configured without TRENDS_DTK_URL, and makes no request', async () => {
    const { impl, calls } = tiktokFetch();
    const source = createTikTokSource({ fetch: impl });
    expect(source.id).toBe('tiktok');
    expect(source.configured()).toBe(false);
    await expect(source.fetch({ region: 'ID', windowHours: 24, nowMs: NOW })).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it('searches the niche keyword, with the API key and a wait window', async () => {
    const { impl, calls, headers } = tiktokFetch();
    const source = createTikTokSource({ url: `${BASE}/`, token: 'dtk-key', fetch: impl });
    const items = await source.fetch({ region: 'ID', windowHours: 720, niche: 'ai', nowMs: NOW });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.pathname).toBe('/api/v1/tiktok/search/posts');
    expect(calls[0]!.searchParams.get('keyword')).toBe('ai');
    expect(calls[0]!.searchParams.get('count')).toBe(String(DTK_PAGE));
    expect(calls[0]!.searchParams.get('wait')).toBe('20');
    expect(headers[0]).toEqual({ 'x-api-key': 'dtk-key' });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: '7300000000000000001',
      source: 'tiktok',
      title: 'POV: kamu bangun dan semua poster di kamar bergerak',
      channel: 'Pixel Pasar',
      url: 'https://www.tiktok.com/@pixelpasar/video/7300000000000000001',
      thumbnail: 'https://p16-sign.example-cdn.invalid/cover-01.jpeg',
      views: 1_200_000,
      likes: 98_000,
      comments: 2_400,
      durationSec: 21,
      region: 'ID',
      hook: 'pov',
      shotCount: 6
    });
    expect(items[0]!.velocity).toBe(120_000);
  });

  it('reads the platform string stats (statsV2) and the caption markers', async () => {
    const { impl } = tiktokFetch();
    const source = createTikTokSource({ url: BASE, fetch: impl });
    const items = await source.fetch({ region: 'ID', windowHours: 720, niche: 'ai', nowMs: NOW });
    const second = items.find(item => item.id === '7300000000000000002')!;
    expect(second.views).toBe(430_000);
    expect(second.likes).toBe(51_000);
    expect(second.comments).toBe(980);
    expect(second.audioType).toBe('sound-tren');
    expect(second.captionStyle).toBe('tanpa-caption');
    expect(second.shotCount).toBe(4); // 9.5 s → 3 → clamped up
  });

  it('falls back to the #fyp hashtag when no niche is picked (two documented calls)', async () => {
    const { impl, calls } = tiktokFetch();
    const source = createTikTokSource({ url: BASE, fetch: impl });
    const items = await source.fetch({ region: 'ID', windowHours: 24, nowMs: NOW });

    expect(calls.map(url => url.pathname)).toEqual(['/api/v1/tiktok/hashtag', '/api/v1/tiktok/hashtag/posts']);
    expect(calls[0]!.searchParams.get('name')).toBe(DTK_DEFAULT_HASHTAG);
    expect(calls[1]!.searchParams.get('hashtag_id')).toBe('12859');
    expect(items.map(item => item.id)).toEqual(['7300000000000000003']);
    expect(items[0]).toMatchObject({ hook: 'before-after', audioType: 'musik', durationSec: 14 });
  });

  it('drops posts outside the window', async () => {
    const { impl } = tiktokFetch();
    const source = createTikTokSource({ url: BASE, fetch: impl });
    expect((await source.fetch({ region: 'ID', windowHours: 24, niche: 'ai', nowMs: NOW })).map(item => item.id)).toEqual(['7300000000000000001']);
  });

  it('fails soft: 404, a refusal envelope, a bad body or a throw is zero items', async () => {
    const missing = createTikTokSource({ url: BASE, fetch: fakeFetch(() => undefined).impl });
    await expect(missing.fetch({ region: 'ID', windowHours: 24, niche: 'ai', nowMs: NOW })).resolves.toEqual([]);

    const refused = createTikTokSource({
      url: BASE,
      fetch: fakeFetch(() => json({ success: false, data: null, error: { code: 'UNSUPPORTED_CONTENT' } }, 200)).impl
    });
    await expect(refused.fetch({ region: 'ID', windowHours: 24, nowMs: NOW })).resolves.toEqual([]);

    const garbage = createTikTokSource({ url: BASE, fetch: fakeFetch(() => new Response('nope', { status: 200 })).impl });
    await expect(garbage.fetch({ region: 'ID', windowHours: 24, nowMs: NOW })).resolves.toEqual([]);

    const throwing = createTikTokSource({ url: BASE, fetch: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
    await expect(throwing.fetch({ region: 'ID', windowHours: 24, nowMs: NOW })).resolves.toEqual([]);
  });

  it('skips the hashtag page when the hashtag lookup answers nothing', async () => {
    const { impl, calls } = fakeFetch(url => (url.pathname === DTK_ROUTES.hashtag('tiktok') ? json({ success: true, data: { name: 'fyp' } }) : undefined));
    const source = createTikTokSource({ url: BASE, fetch: impl });
    await expect(source.fetch({ region: 'ID', windowHours: 24, nowMs: NOW })).resolves.toEqual([]);
    expect(calls.map(url => url.pathname)).toEqual(['/api/v1/tiktok/hashtag']);
  });
});

describe('Douyin source', () => {
  it('reads the hot board: phrases with heat, ranks and no publish date', async () => {
    const { impl, calls } = douyinFetch();
    const source = createDouyinSource({ url: BASE, fetch: impl });
    expect(source.id).toBe('douyin');
    const items = await source.fetch({ region: 'ID', windowHours: 24, nowMs: NOW });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.pathname).toBe('/api/v1/douyin/trending');
    expect(calls[0]!.searchParams.get('board')).toBe('hot');

    expect(items).toHaveLength(3); // an unknown publish date stays in the window
    expect(items.map(item => item.id)).toEqual([
      'hot-film-pendek-ai-30-detik',
      'hot-cerita-horor-1-menit',
      'hot-kucing-pulang-kampung'
    ]);
    const top = items[0]!;
    expect(top).toMatchObject({ source: 'douyin', views: 8_123_456, durationSec: 0, publishedAtMs: 0, shotCount: 4 });
    expect(top.title).toBe('film pendek ai 30 detik');
    // The pinned line above the ranking has no heat: a card, not a crash.
    expect(items[2]).toMatchObject({ title: 'kucing pulang kampung', views: 0, url: '' });
  });

  it('maps a content object from either platform shape', () => {
    const seed = mapDtkContent({
      id: '7100000000000000009',
      desc: 'Sunrise over the harbour',
      createTime: 1_716_200_000,
      video: { duration: 21, cover: 'https://cdn.example/legacy-cover.jpeg' },
      author: { uniqueId: 'synthetic.creator', nickname: 'Synthetic Creator' },
      stats: { playCount: 1_204_331, diggCount: 98_230, commentCount: 1_284 },
      music: { title: 'original sound' }
    }, 'tiktok', { region: 'US', windowHours: 24, nowMs: NOW });
    expect(seed).toMatchObject({
      id: '7100000000000000009',
      source: 'tiktok',
      views: 1_204_331,
      likes: 98_230,
      comments: 1_284,
      durationSec: 21,
      publishedAtMs: 1_716_200_000_000,
      region: 'US'
    });
    expect(seed!.url).toBe('https://www.tiktok.com/@synthetic.creator/video/7100000000000000009');
  });

  it('maps a trending phrase, and ignores a line without a word', () => {
    expect(mapDtkTrending({ word: 'Cerita horor 1 menit', rank: 2, hot_value: 5123000, web_url: 'https://www.douyin.com/hot/1' }, 'douyin', { region: 'ID', windowHours: 24 }))
      .toMatchObject({ id: 'hot-cerita-horor-1-menit', views: 5_123_000, publishedAtMs: 0, durationSec: 0 });
    expect(mapDtkTrending({ rank: 1, hot_value: 10 }, 'douyin', { region: 'ID', windowHours: 24 })).toBeUndefined();
  });

  it('fails soft when the board answers an error', async () => {
    const source = createDouyinSource({ url: BASE, fetch: fakeFetch(() => json({ success: false, data: null, error: { code: 'RATE_LIMITED' } }, 429)).impl });
    await expect(source.fetch({ region: 'ID', windowHours: 24, nowMs: NOW })).resolves.toEqual([]);
  });
});
