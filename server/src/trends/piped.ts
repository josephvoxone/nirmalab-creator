/**
 * YouTube trending without an API key.
 *
 * Google's Data API costs nothing but needs a project and a key, so a fresh install would show an
 * empty page until someone reads an env list. Public Piped instances mirror the same "most popular
 * per region" shelf over plain JSON, no key and no login — good enough to answer "what is working
 * in Indonesia today", which is what the page is for.
 *
 * What it cannot give: publish time, duration and likes. Trending lists are ordered by the shelf
 * itself, so the seed carries `publishedAtMs = 0` / `durationSec = 0` and the ranking falls back to
 * views + niche match (see `score.ts`: unknown freshness is neutral, unknown velocity is 0). The
 * route reports `degraded: true` so the page can say so in one line instead of pretending.
 *
 * Instances are tried in order and any failure is skipped: these are volunteer servers, an outage
 * must never fail the page. `TRENDS_PIPED_URL` points at one instance (comma separated for several).
 */
import { getJson, num, str, type FetchLike } from './http.js';
import { enrichSeeds } from './pipeline.js';
import type { Region, TrendItem, TrendQuery, TrendSeed, TrendSource } from './types.js';

/** Tried in order; the first that answers wins. Override with `TRENDS_PIPED_URL`. */
export const PIPED_INSTANCES = [
  'https://api.piped.private.coffee',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.drgns.space'
];

const VIDEO_ID = /(?:[?&]v=|\/watch\/|\/shorts\/)([A-Za-z0-9_-]{11})/;

/** `/watch?v=ID` → `ID`, or '' when the payload carries something else. */
export function videoIdOf(url: string): string {
  return VIDEO_ID.exec(url)?.[1] ?? '';
}

/**
 * One Piped trending entry → a seed. `null` for anything without a usable id or title: a card with
 * no thumbnail and no link is worse than no card.
 */
export function seedFromPiped(raw: unknown, region: Region): TrendSeed | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = videoIdOf(typeof row.url === 'string' ? row.url : '');
  const title = str(row.title).trim();
  if (!id || !title) return null;
  return {
    id,
    source: 'youtube',
    title,
    channel: str(row.uploaderName).trim(),
    url: `https://www.youtube.com/watch?v=${id}`,
    // i.ytimg is stable and needs no key; the Piped proxy URL is signed and expires.
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    views: num(row.views),
    likes: 0,
    comments: 0,
    publishedAtMs: 0,
    durationSec: 0,
    region,
    description: str(row.shortDescription).slice(0, 400)
  };
}

export type PipedOptions = {
  /** One instance or several; defaults to `PIPED_INSTANCES`. */
  instances?: string[];
  fetch?: FetchLike;
};

export function createPipedSource(options: PipedOptions = {}): TrendSource {
  const instances = (options.instances?.length ? options.instances : PIPED_INSTANCES).map(base => base.replace(/\/+$/, ''));
  return {
    id: 'youtube',
    // Always available: this is the zero-setup path, not a fallback that needs a key.
    configured: () => true,
    async fetch(query: TrendQuery): Promise<TrendItem[]> {
      const fetchImpl = options.fetch ?? (fetch as FetchLike);
      for (const base of instances) {
        const reply = await getJson(fetchImpl, `${base}/trending?region=${encodeURIComponent(query.region)}`, { timeoutMs: 12_000 });
        if (!reply.ok || !Array.isArray(reply.body)) continue;
        const seeds = reply.body.map(row => seedFromPiped(row, query.region)).filter((seed): seed is TrendSeed => seed !== null);
        // An instance that answers with an empty shelf is not better than the next one.
        if (seeds.length > 0) return enrichSeeds(seeds, query);
      }
      return [];
    }
  };
}
