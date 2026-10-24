/**
 * Trend radar API (spec §4.5, §4.6).
 *
 *   GET  /api/trends                (member)   cards for one (region, window, niche)
 *   POST /api/trends/:id/clone      (admin)    the trend → a draft story from its CloneBrief
 *
 * The GET is cached on disk for 30 minutes per (region, window, niche) at
 * `<dataDir>/trends/cache/` (spec §8: the boards change slowly and YouTube's free quota is
 * 10 000 units/day). A cache hit makes NO network call, which is what the route test asserts
 * by counting fetches.
 *
 * Sources are built from env here, and every one of them is optional:
 *   YOUTUBE_API_KEY     → YouTube Data API v3
 *   TRENDS_DTK_URL      → self-hosted DTK (TikTok + Douyin); TRENDS_DTK_TOKEN for its API key
 *   TRENDS_IG_FILE      → instaloader JSON export (file or directory)
 * An unconfigured source is reported as `{configured:false, items:0}` and is absent from
 * `configured` — never an error (spec §9.7: P3a ships while P3b is blocked).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { readPrivateJsonFile, writePrivateJsonFile } from '../lib/private-json-file.js';
import { requireAdmin, sessionUser } from '../auth/routes.js';
import type { UserAuthStore } from '../auth/store.js';
import type { StoryService } from '../stories/service.js';
import { briefToStoryboard, cloneBrief } from './deconstruct.js';
import { createInstagramSource } from './instagram.js';
import { collectTrends } from './pipeline.js';
import { createDouyinSource, createTikTokSource } from './tiktok.js';
import { createYouTubeSource } from './youtube.js';
import type { FetchLike } from './http.js';
import {
  NICHES,
  REGIONS,
  TREND_WINDOWS,
  WINDOWS,
  type Niche,
  type Region,
  type TrendItem,
  type TrendSource,
  type TrendWindow
} from './types.js';

export const TREND_CACHE_MS = 30 * 60_000;

export type TrendRouteOptions = {
  userAuthStore: UserAuthStore;
  dataDir: string;
  /** The story service the clone route drafts into (only `create` is used). */
  stories: Pick<StoryService, 'create'>;
  env?: NodeJS.ProcessEnv;
  /** Tests inject fake sources; production builds them from `env`. */
  sources?: TrendSource[];
  /** fetch for the default sources (tests never use the real one). */
  fetch?: FetchLike;
  nowMs?: () => number;
  cacheTtlMs?: number;
};

const bad = (reply: FastifyReply, status: number, code: string, message: string): FastifyReply =>
  reply.code(status).send({ error: { code, message } });

/** The sources the app runs with, each configured only by its own env var. */
export function createTrendSources(env: NodeJS.ProcessEnv, fetchImpl?: FetchLike): TrendSource[] {
  const dtk = { url: env.TRENDS_DTK_URL, token: env.TRENDS_DTK_TOKEN, ...(fetchImpl ? { fetch: fetchImpl } : {}) };
  return [
    createYouTubeSource({ apiKey: env.YOUTUBE_API_KEY, ...(fetchImpl ? { fetch: fetchImpl } : {}) }),
    createTikTokSource(dtk),
    createInstagramSource({ file: env.TRENDS_IG_FILE }),
    createDouyinSource(dtk)
  ];
}

/** A window the UI offers, as its hours. `24h`/`7d`/`30d` and the bare hours are both accepted. */
export function parseWindow(value: string | undefined): { window: TrendWindow; hours: number } | undefined {
  if (value === undefined || value.trim() === '') return { window: '24h', hours: WINDOWS['24h'] };
  const wanted = value.trim().toLowerCase();
  const named = TREND_WINDOWS.find(w => w === wanted);
  if (named) return { window: named, hours: WINDOWS[named] };
  const hours = Number(wanted);
  const byHours = TREND_WINDOWS.find(w => WINDOWS[w] === hours);
  return byHours ? { window: byHours, hours } : undefined;
}

export function parseRegion(value: string | undefined): Region | undefined {
  const wanted = (value ?? 'ID').trim().toUpperCase();
  return REGIONS.find(region => region === wanted);
}

/** `undefined` = no chip, `'invalid'` = a 400, a Niche = the chip. */
export function parseNiche(value: string | undefined): Niche | undefined | 'invalid' {
  const wanted = (value ?? '').trim().toLowerCase();
  if (!wanted) return undefined;
  return NICHES.find(niche => niche === wanted) ?? 'invalid';
}

type CacheEntry = {
  /** Bumped when the wire shape changes: an older file is ignored, never served. */
  v?: number;
  generatedAtMs: number;
  region: Region;
  windowHours: number;
  niche: Niche | null;
  configured: string[];
  sources: Record<string, { configured: boolean; items: number }>;
  items: TrendItem[];
};

const CACHE_VERSION = 2;

const cacheFile = (dir: string, region: Region, windowHours: number, niche?: Niche): string =>
  join(dir, `${region}-${windowHours}h-${niche ?? 'semua'}.json`);

const isItem = (value: unknown): value is TrendItem =>
  !!value && typeof value === 'object' && typeof (value as TrendItem).id === 'string' && typeof (value as TrendItem).score === 'number';

/** A cache entry we can trust: right key, right shape, right item count. */
function usableEntry(raw: unknown, region: Region, windowHours: number, niche: Niche | undefined): CacheEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const entry = raw as Partial<CacheEntry>;
  if (entry.v !== CACHE_VERSION) return undefined;
  if (typeof entry.generatedAtMs !== 'number' || !Number.isFinite(entry.generatedAtMs)) return undefined;
  if (entry.region !== region || entry.windowHours !== windowHours) return undefined;
  if ((entry.niche ?? null) !== (niche ?? null)) return undefined;
  if (!Array.isArray(entry.items)) return undefined;
  return {
    generatedAtMs: entry.generatedAtMs,
    region,
    windowHours,
    niche: niche ?? null,
    configured: Array.isArray(entry.configured) ? entry.configured.filter((value): value is string => typeof value === 'string') : [],
    sources: entry.sources && typeof entry.sources === 'object' ? entry.sources : {},
    items: entry.items.filter(isItem)
  };
}

/**
 * The wire shape the web page consumes (docs/superpowers/specs §4.5): `configured` is a boolean,
 * `sources` maps each platform to a boolean and `missing` names the env var that would turn it on.
 * The richer per-source counters stay available under `detail`.
 */
const ENV_FOR: Record<string, string> = {
  youtube: 'YOUTUBE_API_KEY',
  tiktok: 'TRENDS_DTK_URL',
  instagram: 'TRENDS_IG_FILE',
  douyin: 'TRENDS_DTK_URL'
};

export function trendView(entry: CacheEntry, cached: boolean) {
  const detail = entry.sources ?? {};
  const names = Object.keys(detail);
  const sources = Object.fromEntries(names.map((name) => [name, detail[name]?.configured === true]));
  const missing = [...new Set(names.filter((name) => detail[name]?.configured !== true).map((name) => ENV_FOR[name] ?? name))];
  return {
    ...{ region: entry.region, windowHours: entry.windowHours, niche: entry.niche },
    generatedAtMs: entry.generatedAtMs,
    cached,
    configured: names.some((name) => detail[name]?.configured === true),
    sources,
    missing,
    detail,
    items: entry.items
  };
}

export async function registerTrendRoutes(server: FastifyInstance, options: TrendRouteOptions): Promise<void> {
  const auth = options.userAuthStore;
  const cacheDir = join(options.dataDir, 'trends', 'cache');
  const sources = options.sources ?? createTrendSources(options.env ?? process.env, options.fetch);
  const now = options.nowMs ?? (() => Date.now());
  const ttl = options.cacheTtlMs ?? TREND_CACHE_MS;

  server.get('/api/trends', async (request, reply) => {
    if (!sessionUser(auth, request)) return bad(reply, 401, 'UNAUTHORIZED', 'Unauthorized');
    const query = (request.query ?? {}) as Record<string, string | undefined>;

    const region = parseRegion(query.region);
    if (!region) return bad(reply, 400, 'INVALID_INPUT', `region harus salah satu dari: ${REGIONS.join(', ')}`);
    const window = parseWindow(query.window);
    if (!window) return bad(reply, 400, 'INVALID_INPUT', 'window harus 24h, 7d atau 30d');
    const niche = parseNiche(query.niche);
    if (niche === 'invalid') return bad(reply, 400, 'INVALID_INPUT', `niche harus salah satu dari: ${NICHES.join(', ')}`);

    const at = now();
    const file = cacheFile(cacheDir, region, window.hours, niche);
    const cached = usableEntry(await readPrivateJsonFile(file).catch(() => undefined), region, window.hours, niche);
    const label = { region, window: window.window, windowHours: window.hours, niche: niche ?? null };
    if (cached && at - cached.generatedAtMs >= 0 && at - cached.generatedAtMs < ttl) {
      return { ...trendView(cached, true), ...label };
    }

    const collected = await collectTrends(sources, { region, windowHours: window.hours, niche, nowMs: at });
    const entry: CacheEntry = {
      v: CACHE_VERSION,
      generatedAtMs: at,
      region,
      windowHours: window.hours,
      niche: niche ?? null,
      configured: collected.configured,
      sources: collected.sources,
      items: collected.items
    };
    // The cache is an optimisation: a read-only data dir must not fail the request.
    await writePrivateJsonFile(file, entry).catch(() => undefined);
    return { ...trendView(entry, false), ...label };
  });

  /**
   * The "Jadikan proyek" button. `:id` is the `TrendItem.id` of a card the user just saw, so the
   * data must still be cached: 409 when nothing has been fetched yet, 404 when the id is in no
   * cached window (a stale card, or an id from another instance).
   */
  server.post<{ Params: { id: string } }>('/api/trends/:id/clone', async (request, reply) => {
    const user = requireAdmin(auth, request, reply);
    if (!user) return undefined;
    const id = String(request.params?.id ?? '');
    if (!/^[\w:.@-]{1,100}$/.test(id)) return bad(reply, 400, 'INVALID_INPUT', 'id tren tidak valid');

    const names = await readdir(cacheDir).catch(() => [] as string[]);
    const entries: CacheEntry[] = [];
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const raw = await readPrivateJsonFile(join(cacheDir, name)).catch(() => undefined);
      const entry = raw as Partial<CacheEntry> | undefined;
      if (entry && typeof entry === 'object' && Array.isArray(entry.items)) entries.push(entry as CacheEntry);
    }
    if (!entries.length) {
      return bad(reply, 409, 'NO_TREND_DATA', 'Cache tren masih kosong — buka halaman Tren dulu supaya datanya terisi.');
    }
    entries.sort((a, b) => (b.generatedAtMs ?? 0) - (a.generatedAtMs ?? 0));
    const item = entries.flatMap(entry => entry.items).find(candidate => candidate?.id === id);
    if (!item) return bad(reply, 404, 'TREND_NOT_FOUND', `Tren "${id}" tidak ada lagi di cache.`);

    const brief = cloneBrief(item);
    try {
      const story = await options.stories.create(briefToStoryboard(brief), { createdBy: user.id });
      return reply.code(201).send({ story });
    } catch (error) {
      return bad(reply, 400, 'INVALID_STORY', error instanceof Error ? error.message : 'Storyboard hasil clone tidak valid');
    }
  });
}
