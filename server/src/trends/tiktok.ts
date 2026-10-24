/**
 * TikTok / Douyin source — the self-hosted `Evil0ctal/Douyin_TikTok_Download_API` (DTK),
 * Apache-2.0, run in our own Docker next to its own Postgres (see docker/trends.compose.yml).
 *
 * Why self-hosted: TikTok's and Douyin's guest access is throttled and region-gated, and a
 * paid API would put a credit card in the path of a free feature (spec §8). DTK keeps the
 * identity pool, rotation, rate limits and caching on our own box.
 *
 * Endpoints (DTK v1 REST, `documents/en/11-api.md` in the DTK repo):
 *   GET /api/v1/{platform}/trending?board=hot      Douyin + Bilibili only — a board of PHRASES
 *   GET /api/v1/{platform}/search/posts?keyword=   TikTok only (Douyin refuses guest search)
 *   GET /api/v1/{platform}/hashtag?name=           TikTok hashtag lookup by name
 *   GET /api/v1/{platform}/hashtag/posts?hashtag_id= TikTok posts under a hashtag
 *
 * Paths are uncertain territory in the DTK project (its releases renamed everything from the
 * old `/api/tiktok/web/fetch_*` sync API to `/api/v1/...` with API keys), so every path lives
 * in ONE constant map (`DTK_ROUTES`) and every call FAILS SOFT: an unknown route, a 404, a
 * rotated key or a platform refusal yields zero items instead of an exception. That is what
 * lets P3b ship later than P3a without breaking the page (spec §9.7).
 *
 * Env: `TRENDS_DTK_URL` (e.g. http://127.0.0.1:8000), optional `TRENDS_DTK_TOKEN` (API key,
 * sent as `X-API-Key`). Without the URL the source is not configured and nothing is called.
 */
import { getJson, isObject, num, str, type FetchLike } from './http.js';
import { enrichSeeds } from './pipeline.js';
import { NICHE_KEYWORDS } from './score.js';
import type { TrendItem, TrendQuery, TrendSeed, TrendSource, TrendSourceId } from './types.js';

/**
 * The only place a DTK path is written. If DTK moves a route, this map is the single edit —
 * nothing else in the app knows the shape of the URL.
 */
export const DTK_ROUTES = {
  /** A trending board of phrases. `board=hot` is the main one. */
  trending: (platform: 'douyin' | 'tiktok' | 'bilibili') => `/api/v1/${platform}/trending`,
  /** Posts a keyword finds. */
  searchPosts: (platform: 'douyin' | 'tiktok' | 'bilibili') => `/api/v1/${platform}/search/posts`,
  /** One hashtag, looked up by `name` on TikTok. */
  hashtag: (platform: 'douyin' | 'tiktok' | 'bilibili') => `/api/v1/${platform}/hashtag`,
  /** Posts under one hashtag id. */
  hashtagPosts: (platform: 'douyin' | 'tiktok' | 'bilibili') => `/api/v1/${platform}/hashtag/posts`
} as const;

/** TikTok has no trending board; the #fyp feed is the closest documented equivalent. */
export const DTK_DEFAULT_HASHTAG = 'fyp';
export const DTK_PAGE = 25;
/** DTK answers lists asynchronously; `wait` asks it to hold the call until the task is done. */
export const DTK_WAIT_SEC = 20;

export type DtkOptions = {
  /** Base URL of the instance, e.g. `http://127.0.0.1:8000`. Empty/absent = not configured. */
  url?: string;
  /** API key minted with `POST /api/v1/admin/api-keys` on the instance. */
  token?: string;
  fetch?: FetchLike;
  limit?: number;
};

type DtkClient = {
  get(path: string, params: Record<string, string>): Promise<{ data: unknown } | undefined>;
};

function clientOf(options: DtkOptions): DtkClient {
  const base = (options.url ?? '').trim().replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch;
  const headers = options.token?.trim() ? { 'x-api-key': options.token.trim() } : undefined;
  return {
    async get(path, params) {
      if (!base) return undefined;
      const url = `${base}${path}?${new URLSearchParams({ ...params, wait: String(DTK_WAIT_SEC) }).toString()}`;
      const result = await getJson(fetchImpl, url, { headers, timeoutMs: (DTK_WAIT_SEC + 10) * 1000 });
      if (!result.ok) return undefined;
      // Envelope: { success, data, error, meta }. `success:false` is a refusal we skip, not a crash.
      if (isObject(result.body) && 'success' in result.body) {
        if (result.body.success !== true) return undefined;
        return { data: result.body.data };
      }
      return { data: result.body };
    }
  };
}

/** The list inside a DTK page: `{items:[...]}` in v1, `{itemList:[...]}` in the old sync API. */
export function dtkPageItems(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!isObject(data)) return [];
  for (const key of ['items', 'itemList', 'list', 'aweme_list']) {
    const value = data[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

const seconds = (value: unknown): number => {
  const n = num(value);
  return n > 0 ? n : 0;
};

/** Milliseconds field, or a seconds field, or an ISO timestamp → epoch ms. */
function epochMs(raw: unknown, isoValue?: unknown): number {
  const ms = num(raw);
  if (ms > 0) return ms > 1e12 ? Math.round(ms) : Math.round(ms * 1000);
  const iso = str(isoValue, 40);
  const parsed = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * One DTK content object → seed. Reads the v1 normalized shape (`content_id`, `stats.play_count`,
 * `created_at` ISO, `duration_ms`) and the legacy raw platform shape (`id`, `stats.playCount`,
 * `createTime` seconds, `video.duration`) in the same pass, because self-hosted instances age
 * at different rates and neither shape should produce a card full of zeroes.
 */
export function mapDtkContent(raw: unknown, source: TrendSourceId, query: TrendQuery): TrendSeed | undefined {
  if (!isObject(raw)) return undefined;
  const id = str(raw.content_id, 40) || str(raw.id, 40) || str(raw.aweme_id, 40);
  if (!id) return undefined;
  const description = str(raw.description, 2000) || str(raw.desc, 2000);
  const stats = isObject(raw.stats) ? raw.stats : {};
  const statsV2 = isObject(raw.statsV2) ? raw.statsV2 : {};
  const legacyStats = isObject(raw.statistics) ? raw.statistics : {};
  const author = isObject(raw.author) ? raw.author : {};
  const media = isObject(raw.media) ? raw.media : {};
  const video = isObject(raw.video) ? raw.video : {};
  const covers = Array.isArray(media.covers) ? media.covers : [];
  const cover = isObject(covers[0]) ? covers[0] : {};
  const channel = str(author.nickname, 80) || str(author.unique_id, 80) || str(author.uniqueId, 80);
  const durationSec = seconds(raw.duration_ms) > 0
    ? seconds(raw.duration_ms) / 1000
    : num(video.duration) > 0
      ? num(video.duration)
      : seconds(raw.duration) / (seconds(raw.duration) > 1000 ? 1000 : 1);
  const web = str(raw.web_url, 400);
  const uniqueId = str(author.unique_id, 80) || str(author.uniqueId, 80);
  const platform = source === 'douyin' ? 'douyin' : 'tiktok';
  return {
    id,
    source,
    title: str(raw.title, 300) || description.slice(0, 120) || '(tanpa judul)',
    channel,
    url: web || `https://www.${platform}.com/@${uniqueId || 'user'}/video/${id}`,
    thumbnail: str(cover.url, 500) || str(video.cover, 500) || str(video.originCover, 500),
    views: num(stats.play_count) || num(stats.playCount) || num(statsV2.playCount) || num(legacyStats.play_count),
    likes: num(stats.digg_count) || num(stats.diggCount) || num(statsV2.diggCount) || num(legacyStats.digg_count),
    comments: num(stats.comment_count) || num(stats.commentCount) || num(statsV2.commentCount) || num(legacyStats.comment_count),
    publishedAtMs: epochMs(raw.createTime, raw.created_at),
    durationSec,
    region: str(raw.locationCreated, 8) || query.region,
    ...(description ? { description } : {})
  };
}

const slug = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'topik';

/**
 * A trending board is a list of PHRASES, not posts (`rank`, `hot_value`, `web_url`): there is
 * no view count and no publish date, so the card carries the heat as views and leaves the
 * duration unknown (the deconstruction then uses its 15 s default and says so).
 */
export function mapDtkTrending(raw: unknown, source: TrendSourceId, query: TrendQuery): TrendSeed | undefined {
  if (!isObject(raw)) return undefined;
  const word = str(raw.word, 160) || str(raw.title, 160);
  if (!word) return undefined;
  const cover = isObject(raw.cover) ? raw.cover : {};
  return {
    id: `hot-${slug(word)}`,
    source,
    title: word,
    channel: source === 'douyin' ? 'Papan hot Douyin' : 'Papan hot',
    url: str(raw.web_url, 400),
    thumbnail: str(cover.url, 500),
    views: num(raw.hot_value),
    likes: 0,
    comments: 0,
    publishedAtMs: 0,
    durationSec: 0,
    region: query.region
  };
}

function seedsFromPosts(data: unknown, source: TrendSourceId, query: TrendQuery): TrendSeed[] {
  return dtkPageItems(data)
    .map(item => mapDtkContent(item, source, query))
    .filter((seed): seed is TrendSeed => !!seed);
}

function seedsFromTrending(data: unknown, source: TrendSourceId, query: TrendQuery): TrendSeed[] {
  return dtkPageItems(data)
    .map(item => mapDtkTrending(item, source, query))
    .filter((seed): seed is TrendSeed => !!seed);
}

/** TikTok: search by the niche's keyword, or the #fyp hashtag when no chip is picked. */
export function createTikTokSource(options: DtkOptions = {}): TrendSource {
  const dtk = clientOf(options);
  const limit = options.limit ?? DTK_PAGE;
  return {
    id: 'tiktok',
    configured: () => !!options.url?.trim(),
    async fetch(query: TrendQuery): Promise<TrendItem[]> {
      if (!options.url?.trim()) return [];
      const keyword = query.niche ? NICHE_KEYWORDS[query.niche][0] : undefined;
      if (keyword) {
        const page = await dtk.get(DTK_ROUTES.searchPosts('tiktok'), { keyword, count: String(limit) });
        if (page) return enrichSeeds(seedsFromPosts(page.data, 'tiktok', query), query);
      }
      const tag = await dtk.get(DTK_ROUTES.hashtag('tiktok'), { name: DTK_DEFAULT_HASHTAG });
      const tagId = isObject(tag?.data) ? str(tag!.data.hashtag_id, 40) || str(tag!.data.challenge_id, 40) : '';
      if (!tagId) return [];
      const posts = await dtk.get(DTK_ROUTES.hashtagPosts('tiktok'), { hashtag_id: tagId, count: String(limit) });
      return posts ? enrichSeeds(seedsFromPosts(posts.data, 'tiktok', query), query) : [];
    }
  };
}

/** Douyin: the hot board. Guest search is refused by the platform, so it is not attempted. */
export function createDouyinSource(options: DtkOptions = {}): TrendSource {
  const dtk = clientOf(options);
  return {
    id: 'douyin',
    configured: () => !!options.url?.trim(),
    async fetch(query: TrendQuery): Promise<TrendItem[]> {
      if (!options.url?.trim()) return [];
      const page = await dtk.get(DTK_ROUTES.trending('douyin'), { board: 'hot' });
      return page ? enrichSeeds(seedsFromTrending(page.data, 'douyin', query), query) : [];
    }
  };
}
