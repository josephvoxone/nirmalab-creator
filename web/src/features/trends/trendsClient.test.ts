import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS, aspectOf, filtersQuery, fmtCount, fmtDuration, fmtPct, fmtRate, hookLabel, hookNote,
  missingEnv, readFilters, rhythmOf, sortItems, suggestLook, type TrendItem
} from './trendsClient.js';

const item = (over: Partial<TrendItem> = {}): TrendItem => ({
  id: 'x', source: 'youtube', title: 't', url: 'https://x', thumbnail: '/t.jpg', views: 0,
  publishedAtMs: 0, durationSec: 60, region: 'ID', velocity: 0, engagement: 0, hook: 'unknown', score: 0, ...over
});

describe('filter state lives in the URL', () => {
  it('falls back to Indonesia / 7 days / all niches', () => {
    expect(readFilters('')).toEqual(DEFAULT_FILTERS);
    expect(readFilters('?region=ZZ&window=99y&niche=knitting')).toEqual(DEFAULT_FILTERS);
  });

  it('reads and writes only the keys the API takes', () => {
    expect(readFilters('?region=KR&window=24h&niche=ai&sort=views')).toEqual({ region: 'KR', range: '24h', niche: 'ai' });
    expect(filtersQuery({ region: 'KR', range: '24h', niche: 'ai' })).toBe('region=KR&window=24h&niche=ai');
    expect(filtersQuery(DEFAULT_FILTERS)).toBe('region=ID&window=7d');
  });
});

describe('card + drawer formatting', () => {
  it('counts in Indonesian compact form without a non-breaking space', () => {
    expect(fmtCount(1_240_000)).toBe('1,2 jt');
    expect(fmtCount(890_000)).toBe('890 rb');
    expect(fmtCount(52)).toBe('52');
    expect(fmtRate(20_666)).toBe('20,7 rb/jam');
    expect(fmtPct(0.043)).toBe('4,3%');
  });

  it('never prints a raw float duration', () => {
    expect(fmtDuration(42)).toBe('0:42');
    expect(fmtDuration(754)).toBe('12:34');
    expect(fmtDuration(undefined)).toBe('');
  });

  it('picks the frame shape from the item, not from a guess when the server says', () => {
    expect(aspectOf(item({ aspect: '16:9', durationSec: 40 }))).toBe('16:9');
    expect(aspectOf(item({ source: 'tiktok', durationSec: 300 }))).toBe('9:16');
    expect(aspectOf(item({ source: 'youtube', durationSec: 42 }))).toBe('9:16');
    expect(aspectOf(item({ source: 'youtube', durationSec: 600 }))).toBe('16:9');
  });

  it('explains a hook and admits when it could not read one', () => {
    expect(hookLabel('question')).toBe('Pertanyaan');
    expect(hookLabel('pov')).toBe('POV');
    expect(hookLabel('unknown')).toBe('Belum terbaca');
    expect(hookNote('question')).toMatch(/jawabannya/i);
    expect(hookNote('unknown')).toMatch(/belum terbaca/i);
  });

  it('summarises rhythm from the shot count and average cut', () => {
    expect(rhythmOf(item({ shotCount: 14, avgShotSec: 3 }))).toBe('±14 shot · potongan rata-rata 3 dtk');
    expect(rhythmOf(item({ shotCount: 10, durationSec: 25 }))).toBe('±10 shot · potongan rata-rata 2,5 dtk');
    expect(rhythmOf(item({ shotCount: 10, durationSec: 30, avgShotSec: 3 }))).toBe('±10 shot · potongan rata-rata 3 dtk');
    expect(rhythmOf(item())).toBeNull();
  });

  it('suggests a look only when the item carries the hint', () => {
    expect(suggestLook(item({ look: { family: 'film-real', variant: 'cinematic-drama' } }))).toBe('Film realis · Drama sinematik');
    expect(suggestLook(item({ look: { family: 'clay', variant: 'pixar-3d' } }))).toBe('Clay & mainan · Animasi 3D');
    expect(suggestLook(item({ look: { family: 'stop-motion' } }))).toBe('stop-motion');
    expect(suggestLook(item())).toBeNull();
  });
});

describe('sorting is client-side and non-destructive', () => {
  const items = [item({ id: 'a', velocity: 10, engagement: 0.2, views: 100, publishedAtMs: 5 }), item({ id: 'b', velocity: 30, engagement: 0.1, views: 900, publishedAtMs: 1 })];

  it('orders by the chosen metric', () => {
    expect(sortItems(items, 'velocity').map(i => i.id)).toEqual(['b', 'a']);
    expect(sortItems(items, 'engagement').map(i => i.id)).toEqual(['a', 'b']);
    expect(sortItems(items, 'views').map(i => i.id)).toEqual(['b', 'a']);
  });

  it('newest first for "recent", and the input stays untouched', () => {
    expect(sortItems(items, 'recent').map(i => i.id)).toEqual(['a', 'b']);
    expect(items.map(i => i.id)).toEqual(['a', 'b']);
  });
});

describe('not-configured names the exact env key, never a secret', () => {
  it('maps each inactive source to its env key', () => {
    expect(missingEnv({ sources: { youtube: false, tiktok: false, instagram: false } })).toEqual([
      { source: 'youtube', env: 'YOUTUBE_API_KEY' },
      { source: 'tiktok', env: 'TRENDS_DTK_URL' },
      { source: 'instagram', env: 'TRENDS_IG_FILE' }
    ]);
    expect(missingEnv({ sources: { youtube: true, tiktok: true, instagram: true } })).toEqual([]);
  });

  it('prefers the names the server reports', () => {
    expect(missingEnv({ sources: { youtube: false }, missing: ['YT_API_KEY_V2'] })).toEqual([{ source: 'youtube', env: 'YT_API_KEY_V2' }]);
  });
});
