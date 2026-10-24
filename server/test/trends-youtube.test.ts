/**
 * YouTube source (official Data API v3). Offline: every request goes through an injected fetch
 * that answers with the recorded fixture shapes.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { YOUTUBE_CATEGORY, createYouTubeSource, parseIsoDuration } from '../src/trends/youtube.js';

const NOW = 1_792_929_600_000; // 2026-10-25T12:00:00Z

const fixture = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(new URL(`./fixtures/trends/${name}`, import.meta.url), 'utf8')) as Record<string, any>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(answer: (url: string) => Response | undefined) {
  const calls: string[] = [];
  const impl = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    return answer(url) ?? json({ error: { message: 'unexpected' } }, 404);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const listing = () => fixture('youtube-popular.json');
const durations = () => fixture('youtube-durations.json');

function youtubeFetch() {
  return fakeFetch(url => (url.includes('part=contentDetails') ? json(durations()) : url.includes('chart=mostPopular') ? json(listing()) : undefined));
}

describe('ISO 8601 durations', () => {
  it('reads seconds, minutes, hours and days', () => {
    expect(parseIsoDuration('PT42S')).toBe(42);
    expect(parseIsoDuration('PT3M18S')).toBe(198);
    expect(parseIsoDuration('PT1H2M3S')).toBe(3_723);
    expect(parseIsoDuration('P1DT2H')).toBe(93_600);
  });

  it('is 0 for P0D and for anything unreadable (never a random duration)', () => {
    expect(parseIsoDuration('P0D')).toBe(0);
    expect(parseIsoDuration('')).toBe(0);
    expect(parseIsoDuration('42 seconds')).toBe(0);
    expect(parseIsoDuration('PT')).toBe(0);
  });
});

describe('YouTube source', () => {
  it('is not configured without YOUTUBE_API_KEY, and makes no request', async () => {
    const { impl, calls } = youtubeFetch();
    const source = createYouTubeSource({ fetch: impl });
    expect(source.id).toBe('youtube');
    expect(source.configured()).toBe(false);
    await expect(source.fetch({ region: 'ID', windowHours: 24, nowMs: NOW })).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it('is not configured for a blank key', () => {
    expect(createYouTubeSource({ apiKey: '   ' }).configured()).toBe(false);
    expect(createYouTubeSource({ apiKey: 'k' }).configured()).toBe(true);
  });

  it('asks for chart=mostPopular by region, then contentDetails for the durations', async () => {
    const { impl, calls } = youtubeFetch();
    const source = createYouTubeSource({ apiKey: 'test-key', fetch: impl, baseUrl: 'https://yt.test/v3' });
    await source.fetch({ region: 'ID', windowHours: 720, nowMs: NOW });

    expect(calls).toHaveLength(2);
    const [list, detail] = calls.map(url => new URL(url));
    expect(`${list!.origin}${list!.pathname}`).toBe('https://yt.test/v3/videos');
    expect(list!.searchParams.get('chart')).toBe('mostPopular');
    expect(list!.searchParams.get('regionCode')).toBe('ID');
    expect(list!.searchParams.get('maxResults')).toBe('25');
    expect(list!.searchParams.get('part')).toBe('snippet,statistics');
    expect(list!.searchParams.get('key')).toBe('test-key');
    expect(list!.searchParams.get('videoCategoryId')).toBeNull();

    expect(detail!.searchParams.get('part')).toBe('contentDetails');
    expect(detail!.searchParams.get('id')!.split(',')).toEqual(['aQ1bC2dE3fG', 'zY9xW8vU7tS', 'pL4kM5nB6vC']);
  });

  it('maps a fixture video onto the UI contract', async () => {
    const { impl } = youtubeFetch();
    const source = createYouTubeSource({ apiKey: 'test-key', fetch: impl, baseUrl: 'https://yt.test/v3' });
    const items = await source.fetch({ region: 'ID', windowHours: 720, niche: 'ai', nowMs: NOW });
    const item = items.find(entry => entry.id === 'aQ1bC2dE3fG')!;

    expect(item).toMatchObject({
      id: 'aQ1bC2dE3fG',
      source: 'youtube',
      title: 'Kenapa AI bikin film terasa aneh?',
      channel: 'Studio Nirmala',
      url: 'https://www.youtube.com/watch?v=aQ1bC2dE3fG',
      thumbnail: 'https://i.ytimg.com/vi/aQ1bC2dE3fG/maxresdefault.jpg',
      views: 812_345,
      likes: 52_310,
      comments: 1_840,
      durationSec: 42,
      region: 'ID',
      hook: 'pertanyaan',
      shotCount: 12,
      avgShotSec: 3.5
    });
    expect(item.publishedAtMs).toBe(NOW - 18 * 3_600_000);
    expect(item.velocity).toBe(45_130.3);
    expect(item.engagement).toBeCloseTo(0.0667, 4);
    expect(item.score).toBe(80);
    expect(item.beats.map(beat => beat.atSec)).toEqual([0, 8.4, 23.1, 33.6]);
    // Never leaks the seed-only fields into the card.
    expect(Object.keys(item).sort()).toEqual([
      'audioType', 'avgShotSec', 'beats', 'captionStyle', 'channel', 'comments', 'durationSec', 'engagement',
      'hook', 'id', 'likes', 'publishedAtMs', 'region', 'score', 'shotCount', 'source', 'thumbnail', 'title',
      'url', 'velocity', 'views'
    ]);
  });

  it('filters to the window: 24 h keeps only yesterday', async () => {
    const { impl } = youtubeFetch();
    const source = createYouTubeSource({ apiKey: 'test-key', fetch: impl, baseUrl: 'https://yt.test/v3' });
    expect((await source.fetch({ region: 'ID', windowHours: 24, nowMs: NOW })).map(item => item.id)).toEqual(['aQ1bC2dE3fG']);
    expect((await source.fetch({ region: 'ID', windowHours: 168, nowMs: NOW })).map(item => item.id).sort()).toEqual(['aQ1bC2dE3fG', 'zY9xW8vU7tS']);
    expect(await source.fetch({ region: 'ID', windowHours: 720, nowMs: NOW })).toHaveLength(3);
  });

  it('asks for the category when a niche maps to one', async () => {
    const { impl, calls } = youtubeFetch();
    const source = createYouTubeSource({ apiKey: 'test-key', fetch: impl, baseUrl: 'https://yt.test/v3' });
    await source.fetch({ region: 'US', windowHours: 24, niche: 'cinematic', nowMs: NOW });
    expect(new URL(calls[0]!).searchParams.get('videoCategoryId')).toBe(YOUTUBE_CATEGORY.cinematic);
    expect(new URL(calls[0]!).searchParams.get('regionCode')).toBe('US');
  });

  it('fails soft: an HTTP error, a non-JSON body or a network throw is zero items', async () => {
    const serverError = createYouTubeSource({ apiKey: 'k', fetch: fakeFetch(() => json({ error: { message: 'quota' } }, 403)).impl });
    await expect(serverError.fetch({ region: 'ID', windowHours: 24, nowMs: NOW })).resolves.toEqual([]);

    const garbage = createYouTubeSource({ apiKey: 'k', fetch: fakeFetch(() => new Response('<html>', { status: 200 })).impl });
    await expect(garbage.fetch({ region: 'ID', windowHours: 24, nowMs: NOW })).resolves.toEqual([]);

    const throwing = createYouTubeSource({
      apiKey: 'k',
      fetch: (async () => { throw new Error('ETIMEDOUT'); }) as unknown as typeof fetch
    });
    await expect(throwing.fetch({ region: 'ID', windowHours: 24, nowMs: NOW })).resolves.toEqual([]);
  });

  it('keeps the cards when only the duration call fails (unknown duration, not a lost page)', async () => {
    const { impl } = fakeFetch(url => (url.includes('chart=mostPopular') ? json(listing()) : json({ error: { message: 'quota' } }, 403)));
    const source = createYouTubeSource({ apiKey: 'k', fetch: impl, baseUrl: 'https://yt.test/v3' });
    const items = await source.fetch({ region: 'ID', windowHours: 720, nowMs: NOW });
    expect(items).toHaveLength(3);
    expect(items[0]!.durationSec).toBe(0);
    expect(items[0]!.shotCount).toBe(4); // the 15 s default pacing
  });

  it('ignores an empty result page', async () => {
    const source = createYouTubeSource({ apiKey: 'k', fetch: fakeFetch(() => json({ items: [] })).impl, baseUrl: 'https://yt.test/v3' });
    await expect(source.fetch({ region: 'ID', windowHours: 24, nowMs: NOW })).resolves.toEqual([]);
  });
});
