import { describe, expect, it } from 'vitest';
import { createPipedSource, PIPED_INSTANCES, seedFromPiped, videoIdOf } from '../src/trends/piped.js';
import type { TrendQuery } from '../src/trends/types.js';

const query: TrendQuery = { region: 'ID', windowHours: 24, niche: null };

const row = (over: Record<string, unknown> = {}) => ({
  url: '/watch?v=deB81Hx-pUk',
  type: 'stream',
  title: 'RAW EGG PEELING LIVE',
  uploaderName: 'Funny hehe',
  thumbnail: 'https://proxy.piped.private.coffee/vi/deB81Hx-pUk/hq720.jpg?sig=1',
  views: 846,
  duration: -1,
  shortDescription: 'RAW EGG PEELING LIVE',
  ...over
});

const reply = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body)
}) as unknown as Response;

describe('piped seeding', () => {
  it('reads the id out of both /watch and /shorts URLs', () => {
    expect(videoIdOf('/watch?v=deB81Hx-pUk')).toBe('deB81Hx-pUk');
    expect(videoIdOf('https://www.youtube.com/shorts/abcdefghijk')).toBe('abcdefghijk');
    expect(videoIdOf('/channel/UC123')).toBe('');
  });

  it('maps a trending row to a seed with a stable thumbnail and no invented numbers', () => {
    const seed = seedFromPiped(row(), 'ID');
    expect(seed).toMatchObject({
      id: 'deB81Hx-pUk',
      source: 'youtube',
      title: 'RAW EGG PEELING LIVE',
      channel: 'Funny hehe',
      url: 'https://www.youtube.com/watch?v=deB81Hx-pUk',
      thumbnail: 'https://i.ytimg.com/vi/deB81Hx-pUk/hqdefault.jpg',
      views: 846,
      likes: 0,
      comments: 0,
      publishedAtMs: 0,
      durationSec: 0,
      region: 'ID'
    });
  });

  it('drops a row without an id or a title instead of rendering an empty card', () => {
    expect(seedFromPiped(row({ url: '/channel/UC123' }), 'ID')).toBeNull();
    expect(seedFromPiped(row({ title: '   ' }), 'ID')).toBeNull();
    expect(seedFromPiped(null, 'ID')).toBeNull();
  });

  it('is configured without any env, so the page never starts empty', () => {
    expect(createPipedSource().configured()).toBe(true);
  });

  it('falls through to the next instance when one fails or answers an empty shelf', async () => {
    const calls: string[] = [];
    const source = createPipedSource({
      instances: ['https://a.test', 'https://b.test', 'https://c.test'],
      fetch: (async (url: string) => {
        calls.push(url);
        if (url.startsWith('https://a.test')) return reply({ error: 'down' }, 500);
        if (url.startsWith('https://b.test')) return reply([]);
        return reply([row()]);
      }) as never
    });
    const seeds = await source.fetch(query);
    expect(seeds.map(s => s.id)).toEqual(['deB81Hx-pUk']);
    expect(calls).toEqual([
      'https://a.test/trending?region=ID',
      'https://b.test/trending?region=ID',
      'https://c.test/trending?region=ID'
    ]);
  });

  it('answers an empty list (never throws) when every instance is down', async () => {
    const source = createPipedSource({
      instances: ['https://a.test'],
      fetch: (async () => { throw new Error('ECONNRESET'); }) as never
    });
    await expect(source.fetch(query)).resolves.toEqual([]);
  });

  it('ships more than one default instance, since these are volunteer servers', () => {
    expect(PIPED_INSTANCES.length).toBeGreaterThan(1);
  });
});
