/**
 * Tren page client: contract from docs/superpowers/specs/2026-10-25-production-bible-design.md §4.5–4.6
 * (P3a = official YouTube, deconstruct + CloneBrief; TikTok/Instagram arrive in P3b).
 *
 * Everything here is pure so the page stays a renderer: the URL is the filter state, the API
 * payload is normalised before it reaches a component (an older or half-built server answers
 * `{}` and must not crash the page).
 */
import { post, requestJson, type FetchLike } from '../../lib/api.js';
import { LOOK_FAMILIES } from '../bible/looks.js';

export type TrendSource = 'youtube' | 'tiktok' | 'instagram';
export type Hook = 'question' | 'shock' | 'text' | 'pov' | 'before-after' | 'list' | 'unknown';
export type Beat = { label: string; atSec: number };

export type TrendItem = {
  id: string;
  source: TrendSource;
  title: string;
  channel?: string;
  url: string;
  thumbnail: string;
  views: number;
  likes?: number;
  comments?: number;
  publishedAtMs: number;
  durationSec?: number;
  region: string;
  /** views / hour since publish */
  velocity: number;
  /** (like + comment + share) / views, 0–1 */
  engagement: number;
  hook?: Hook;
  beats?: Beat[];
  shotCount?: number;
  avgShotSec?: number;
  captionStyle?: string;
  audioType?: string;
  score?: number;
  /** Frame shape of the source video, when the deconstruction could tell (Shorts/Reels are 9:16). */
  aspect?: '9:16' | '16:9';
  /** Look hint for the CloneBrief: the family/variant the deconstruction suggests. */
  look?: { family?: string; variant?: string } | null;
};

export type TrendsResponse = {
  configured: boolean;
  sources: Partial<Record<TrendSource, boolean>>;
  generatedAtMs?: number;
  items: TrendItem[];
  /** Exact env names the server is missing (P3a fallback below when it sends none). */
  missing?: string[];
};

export const SOURCE_LABEL: Record<TrendSource, string> = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' };

/** What each source's env var buys, in plain Indonesian. */
export const SOURCE_NEEDS: Record<TrendSource, string> = {
  youtube: 'tarikan resmi YouTube Data API v3',
  tiktok: 'server DTK yang kamu jalankan sendiri',
  instagram: 'file ekspor instaloader'
};

/** Fallback env names for the not-configured copy; the server may send `missing` instead. */
export const SOURCE_ENV: Record<TrendSource, string> = {
  youtube: 'YOUTUBE_API_KEY',
  tiktok: 'TRENDS_DTK_URL',
  instagram: 'TRENDS_IG_FILE'
};

export function activeSources(resp: Pick<TrendsResponse, 'sources'>): TrendSource[] {
  return (Object.keys(SOURCE_LABEL) as TrendSource[]).filter(s => resp.sources?.[s] === true);
}

/** Inactive sources paired with the env key they need. Only shown when `configured` is false. */
export function missingEnv(resp: Pick<TrendsResponse, 'sources' | 'missing'>): Array<{ source: TrendSource; env: string }> {
  const inactive = (Object.keys(SOURCE_ENV) as TrendSource[]).filter(s => resp.sources?.[s] !== true);
  if (resp.missing?.length) return resp.missing.map((env, i) => ({ source: inactive[i] ?? 'youtube', env }));
  return inactive.map(source => ({ source, env: SOURCE_ENV[source] }));
}

// ---------------------------------------------------------------- filters (the URL is the state)

export type Region = 'ID' | 'US' | 'JP' | 'KR' | 'BR' | 'GB';
export type Range = '24h' | '7d' | '30d';
export type Niche = '' | 'ai' | 'cinematic' | 'faceless' | 'kids' | 'story';
export type Filters = { region: Region; range: Range; niche: Niche };
export type Option<T extends string> = { value: T; label: string };

export const DEFAULT_FILTERS: Filters = { region: 'ID', range: '7d', niche: '' };

export const REGIONS: Array<Option<Region>> = [
  { value: 'ID', label: 'Indonesia' },
  { value: 'US', label: 'Amerika Serikat' },
  { value: 'JP', label: 'Jepang' },
  { value: 'KR', label: 'Korea Selatan' },
  { value: 'BR', label: 'Brasil' },
  { value: 'GB', label: 'Inggris' }
];

export const RANGES: Array<Option<Range>> = [
  { value: '24h', label: '24 jam' },
  { value: '7d', label: '7 hari' },
  { value: '30d', label: '30 hari' }
];

export const NICHES: Array<Option<Niche>> = [
  { value: '', label: 'Semua' },
  { value: 'ai', label: 'AI' },
  { value: 'cinematic', label: 'Sinematik' },
  { value: 'faceless', label: 'Faceless' },
  { value: 'kids', label: 'Anak' },
  { value: 'story', label: 'Cerita' }
];

const pick = <T extends string>(options: Array<Option<T>>, value: string | null): T | undefined =>
  options.find(o => o.value === value)?.value;

/** URL → filters. Unknown or stale values fall back to the default, never throw. */
export function readFilters(search: string): Filters {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return {
    region: pick(REGIONS, params.get('region')) ?? DEFAULT_FILTERS.region,
    range: pick(RANGES, params.get('window')) ?? DEFAULT_FILTERS.range,
    niche: pick(NICHES, params.get('niche')) ?? DEFAULT_FILTERS.niche
  };
}

/** Filters → query string for `GET /api/trends` (niche omitted when it means "all"). */
export function filtersQuery(f: Filters): string {
  const params = new URLSearchParams({ region: f.region, window: f.range });
  if (f.niche) params.set('niche', f.niche);
  return params.toString();
}

// ---------------------------------------------------------------- sorting (client-side)

export type Sort = 'velocity' | 'engagement' | 'views' | 'recent';
export const SORTS: Array<Option<Sort>> = [
  { value: 'velocity', label: 'Paling cepat naik' },
  { value: 'engagement', label: 'Interaksi tertinggi' },
  { value: 'views', label: 'Tayangan terbanyak' },
  { value: 'recent', label: 'Paling baru' }
];

const metric = (item: TrendItem, sort: Sort): number =>
  sort === 'engagement' ? item.engagement : sort === 'views' ? item.views : sort === 'recent' ? item.publishedAtMs : item.velocity;

export function sortItems(items: TrendItem[], sort: Sort): TrendItem[] {
  return [...items].sort((a, b) => metric(b, sort) - metric(a, sort));
}

// ---------------------------------------------------------------- display helpers

const compact = (n: number) => n.toLocaleString('id-ID', { notation: 'compact', maximumFractionDigits: 1 }).replace(/\u00a0/g, ' ');
const decimal = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: 1 });

export const fmtCount = (n: number | undefined): string => (Number.isFinite(n) ? compact(n as number) : '');
export const fmtRate = (velocity: number | undefined): string => (Number.isFinite(velocity) ? `${compact(velocity as number)}/jam` : '');
export const fmtPct = (ratio: number | undefined): string => (Number.isFinite(ratio) ? `${decimal((ratio as number) * 100)}%` : '');

/** `42` → `0:42`, `754` → `12:34`, `3725` → `1:02:05`; never a raw float. */
export function fmtDuration(sec: number | undefined): string {
  if (!Number.isFinite(sec) || (sec as number) < 0) return '';
  const total = Math.round(sec as number);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** Shorts and Reels are vertical; a long YouTube video is landscape. An explicit `aspect` wins. */
export function aspectOf(item: TrendItem): '9:16' | '16:9' {
  if (item.aspect === '9:16' || item.aspect === '16:9') return item.aspect;
  if (item.source !== 'youtube') return '9:16';
  return (item.durationSec ?? 0) > 60 ? '16:9' : '9:16';
}

export const HOOK_LABEL: Record<Hook, string> = {
  question: 'Pertanyaan', shock: 'Kejutan visual', text: 'Teks hook', pov: 'POV', 'before-after': 'Before–after', list: 'Daftar', unknown: 'Belum terbaca'
};

export function hookLabel(hook: string | undefined): string {
  return HOOK_LABEL[(hook ?? 'unknown') as Hook] ?? (hook || HOOK_LABEL.unknown);
}

const HOOK_NOTE: Record<Hook, string> = {
  question: 'Pertanyaan di dua detik pertama bikin penonton menunggu jawabannya.',
  shock: 'Kejadian mengejutkan di awal menghentikan jempol sebelum orang memutuskan menonton.',
  text: 'Teks besar di frame pertama bekerja walau videonya ditonton tanpa suara.',
  pov: 'Sudut POV menempatkan penonton sebagai pelaku, jadi terasa personal.',
  'before-after': 'Perubahan sebelum–sesudah menjanjikan hasil yang tinggal ditunggu.',
  list: 'Janji "N hal" membuat penonton menargetkan jumlah, bukan durasi.',
  unknown: 'Hook belum terbaca dari bedah otomatis; tonton dua detik pertama sendiri sebelum meniru.'
};

export const hookNote = (hook: string | undefined): string => HOOK_NOTE[(hook ?? 'unknown') as Hook] ?? HOOK_NOTE.unknown;

const CAPTION_LABEL: Record<string, string> = {
  'bold-top': 'Teks tebal di atas', 'subtitle-clean': 'Subtitle bersih', karaoke: 'Karaoke per kata', none: 'Tanpa caption', mixed: 'Campur teks + subtitle'
};
const AUDIO_LABEL: Record<string, string> = {
  vo: 'Voice-over', music: 'Musik saja', 'trend-sound': 'Sound tren', mix: 'VO + musik', sfx: 'SFX + musik', silent: 'Tanpa audio'
};

export const captionLabel = (style: string | undefined): string | null => (style ? CAPTION_LABEL[style] ?? style : null);
export const audioLabel = (type: string | undefined): string | null => (type ? AUDIO_LABEL[type] ?? type : null);

/** `±14 shot · potongan rata-rata 3 dtk` — null when the deconstruction did not count shots. */
export function rhythmOf(item: TrendItem): string | null {
  if (!item.shotCount || item.shotCount <= 0) return null;
  const avg = item.avgShotSec && item.avgShotSec > 0 ? item.avgShotSec : item.durationSec ? item.durationSec / item.shotCount : undefined;
  return `±${item.shotCount} shot${avg ? ` · potongan rata-rata ${decimal(avg)} dtk` : ''}`;
}

/** `Film realis · Drama sinematik` from the item's look hint; null when there is no hint (no guessing). */
export function suggestLook(item: Pick<TrendItem, 'look'>): string | null {
  const family = item.look?.family;
  if (!family) return null;
  const known = LOOK_FAMILIES.find(f => f.id === family);
  if (!known) return [family, item.look?.variant].filter(Boolean).join(' · ');
  const variant = known.variants.find(v => v.id === item.look?.variant);
  return [known.label, variant?.label ?? item.look?.variant].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- api

function normalize(raw: Partial<TrendsResponse> | undefined | null): TrendsResponse {
  const sources = (raw?.sources ?? {}) as Partial<Record<TrendSource, boolean>>;
  const items = Array.isArray(raw?.items) ? raw!.items.filter((i): i is TrendItem => !!i && typeof i.id === 'string' && typeof i.title === 'string') : [];
  return {
    // An older server that answers items without the flag is still working, not unconfigured.
    configured: raw?.configured === true || items.length > 0,
    sources: { youtube: sources.youtube === true, tiktok: sources.tiktok === true, instagram: sources.instagram === true },
    generatedAtMs: Number.isFinite(raw?.generatedAtMs) ? raw?.generatedAtMs : undefined,
    items,
    missing: Array.isArray(raw?.missing) ? raw!.missing.filter(m => typeof m === 'string' && m.length > 0) : undefined
  };
}

export function trendsApi(fetchImpl: FetchLike) {
  return {
    async list(filters: Filters): Promise<TrendsResponse> {
      return normalize(await requestJson<Partial<TrendsResponse>>(fetchImpl, `/api/trends?${filtersQuery(filters)}`));
    },
    /** Server builds a draft project from the CloneBrief and answers its id. */
    clone: (id: string) => requestJson<{ story: { id: string; title: string } }>(fetchImpl, `/api/trends/${encodeURIComponent(id)}/clone`, post({}))
  };
}
