/**
 * YouTube source — the official Data API v3, never scraping (spec §9.7 decision 1).
 *
 * Two calls, exactly as documented by Google:
 *   1. videos.list?part=snippet,statistics&chart=mostPopular&regionCode=..&maxResults=25
 *      (+ videoCategoryId when the picked niche maps to a category)
 *   2. videos.list?part=contentDetails&id=<comma separated>  → durations
 *
 * The first call already carries statistics; the second exists only because duration lives in
 * contentDetails and batching it into the first call would hide which field came from where.
 * Each call is 1 quota unit, so a page costs 2 of the 10 000 free units per day.
 *
 * Env: `YOUTUBE_API_KEY`. Unset → `configured()` is false and no request is ever made.
 */
import { getJson, isObject, num, str, type FetchLike } from './http.js';
import { enrichSeeds } from './pipeline.js';
import type { Niche, TrendItem, TrendQuery, TrendSeed, TrendSource } from './types.js';

export const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
export const YOUTUBE_PAGE = 25;

/**
 * Niche → YouTube category id. Unmapped niches send no `videoCategoryId`, which is what the
 * UI means by "all niches": most popular overall, not most popular in one shelf.
 */
export const YOUTUBE_CATEGORY: Partial<Record<Niche, string>> = {
  ai: '28', // Science & Technology
  cinematic: '1', // Film & Animation
  faceless: '22', // People & Blogs
  anak: '24', // Entertainment (kids channels sit here; Google has no "kids" category)
  cerita: '24' // Entertainment
};

/**
 * ISO 8601 duration → seconds (`PT1H2M3S`). Zero for `P0D`, garbage or a value we cannot read:
 * a missing duration must not become a random one.
 */
export function parseIsoDuration(iso: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso.trim());
  if (!match) return 0;
  const [, d, h, m, s] = match;
  const seconds = num(d) * 86_400 + num(h) * 3_600 + num(m) * 60 + num(s);
  return Math.max(Math.round(seconds), 0);
}

type YtVideo = {
  id?: unknown;
  snippet?: {
    title?: unknown;
    channelTitle?: unknown;
    description?: unknown;
    publishedAt?: unknown;
    thumbnails?: Record<string, { url?: unknown } | undefined>;
  };
  statistics?: { viewCount?: unknown; likeCount?: unknown; commentCount?: unknown };
  contentDetails?: { duration?: unknown };
};

function thumbnailOf(snippet: YtVideo['snippet']): string {
  const thumbs = snippet?.thumbnails ?? {};
  for (const size of ['maxres', 'standard', 'high', 'medium', 'default']) {
    const url = str(thumbs[size]?.url, 500);
    if (url) return url;
  }
  return '';
}

/** One `videos.list` item → a seed. `durations[id]` fills what the snippet call cannot know. */
export function mapYouTubeVideo(raw: YtVideo, region: string, durations: Record<string, number> = {}): TrendSeed | undefined {
  const id = str(raw.id, 40);
  if (!id) return undefined;
  const snippet = raw.snippet ?? {};
  const published = Date.parse(str(snippet.publishedAt, 40));
  return {
    id,
    source: 'youtube',
    title: str(snippet.title, 300) || '(tanpa judul)',
    channel: str(snippet.channelTitle, 120),
    url: `https://www.youtube.com/watch?v=${id}`,
    thumbnail: thumbnailOf(snippet),
    views: num(raw.statistics?.viewCount),
    likes: num(raw.statistics?.likeCount),
    comments: num(raw.statistics?.commentCount),
    publishedAtMs: Number.isFinite(published) ? published : 0,
    durationSec: durations[id] ?? parseIsoDuration(str(raw.contentDetails?.duration, 40)),
    region,
    description: str(snippet.description, 2000)
  };
}

export type YouTubeOptions = {
  apiKey?: string;
  fetch?: FetchLike;
  /** Override for tests; defaults to the public API. */
  baseUrl?: string;
  limit?: number;
};

export function createYouTubeSource(options: YouTubeOptions = {}): TrendSource {
  const apiKey = options.apiKey?.trim() ?? '';
  const fetchImpl = options.fetch ?? fetch;
  const base = options.baseUrl ?? YOUTUBE_API;
  const limit = Math.min(Math.max(options.limit ?? YOUTUBE_PAGE, 1), 50);

  return {
    id: 'youtube',
    configured: () => apiKey.length > 0,
    async fetch(query: TrendQuery): Promise<TrendItem[]> {
      if (!apiKey) return [];
      const params = new URLSearchParams({
        part: 'snippet,statistics',
        chart: 'mostPopular',
        regionCode: query.region,
        maxResults: String(limit),
        key: apiKey
      });
      const category = query.niche ? YOUTUBE_CATEGORY[query.niche] : undefined;
      if (category) params.set('videoCategoryId', category);

      const listing = await getJson(fetchImpl, `${base}/videos?${params.toString()}`);
      if (!listing.ok || !isObject(listing.body)) return [];
      const rawItems = Array.isArray((listing.body as { items?: unknown }).items) ? (listing.body as { items: unknown[] }).items : [];
      const videos = rawItems.filter(isObject) as YtVideo[];
      if (!videos.length) return [];

      // Durations: one extra call for every id we got. A failure leaves duration 0 (unknown).
      const ids = videos.map(v => str(v.id, 40)).filter(Boolean);
      const durations: Record<string, number> = {};
      if (ids.length) {
        const detail = await getJson(fetchImpl, `${base}/videos?${new URLSearchParams({
          part: 'contentDetails',
          id: ids.join(','),
          maxResults: String(Math.max(ids.length, 1)),
          key: apiKey
        }).toString()}`);
        if (detail.ok && isObject(detail.body)) {
          const details = (detail.body as { items?: unknown }).items;
          for (const item of Array.isArray(details) ? details : []) {
            if (!isObject(item)) continue;
            const id = str(item.id, 40);
            const duration = parseIsoDuration(str((item.contentDetails as { duration?: unknown } | undefined)?.duration, 40));
            if (id && duration > 0) durations[id] = duration;
          }
        }
      }

      const seeds = videos
        .map(video => mapYouTubeVideo(video, query.region, durations))
        .filter((seed): seed is TrendSeed => !!seed);
      return enrichSeeds(seeds, query);
    }
  };
}
