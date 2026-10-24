/**
 * Trend radar contracts (spec §4.5, §9.7).
 *
 * `TrendItem` is the UI contract the `/tren` page renders: one card per item, already
 * deconstructed and scored, so the browser never runs inference. `TrendSource` is what a
 * platform adapter has to provide: an id, whether the operator configured it, and a fetch
 * that returns ready-to-render items.
 *
 * Nothing here does IO. A source that is not configured is *absent*, not an error: `fetch`
 * is never called when `configured()` is false, and a configured source that fails returns
 * `[]` rather than throwing, so one dead platform cannot take the page down (spec §9.7:
 * P3a has to stay useful while P3b is blocked).
 */

export type TrendSourceId = 'youtube' | 'tiktok' | 'douyin' | 'instagram';

/** Order is the UI tab order. */
export const TREND_SOURCE_IDS: readonly TrendSourceId[] = ['youtube', 'tiktok', 'instagram', 'douyin'];

/** Regions the UI offers (spec §4.6). */
export type Region = 'ID' | 'US' | 'JP' | 'KR' | 'BR' | 'GB';
export const REGIONS: readonly Region[] = ['ID', 'US', 'JP', 'KR', 'BR', 'GB'];

/** Niche chips (spec §4.6). Keyword lists live in `score.ts` (one place decides what a niche is). */
export type Niche = 'ai' | 'cinematic' | 'faceless' | 'anak' | 'cerita';
export const NICHES: readonly Niche[] = ['ai', 'cinematic', 'faceless', 'anak', 'cerita'];

/** Time windows the UI offers: 24 jam / 7 hari / 30 hari. */
export type TrendWindow = '24h' | '7d' | '30d';
export const WINDOWS: Readonly<Record<TrendWindow, number>> = { '24h': 24, '7d': 168, '30d': 720 };
export const TREND_WINDOWS: readonly TrendWindow[] = ['24h', '7d', '30d'];

/** What makes people stop scrolling (spec §4.5). The badge text is Indonesian, the id is stable. */
export type HookType = 'pertanyaan' | 'kejutan-visual' | 'teks-hook' | 'pov' | 'before-after';
export const HOOK_LABELS: Readonly<Record<HookType, string>> = {
  pertanyaan: 'Pertanyaan',
  'kejutan-visual': 'Kejutan visual',
  'teks-hook': 'Teks hook',
  pov: 'POV',
  'before-after': 'Before / after'
};

export type CaptionStyle = 'teks-besar' | 'subtitle-rapi' | 'caption-bergerak' | 'tanpa-caption';
export const CAPTION_LABELS: Readonly<Record<CaptionStyle, string>> = {
  'teks-besar': 'Teks besar',
  'subtitle-rapi': 'Subtitle rapi',
  'caption-bergerak': 'Caption bergerak',
  'tanpa-caption': 'Tanpa caption'
};

export type AudioType = 'vo' | 'musik' | 'sound-tren' | 'tanpa-audio';
export const AUDIO_LABELS: Readonly<Record<AudioType, string>> = {
  vo: 'Voice-over',
  musik: 'Musik',
  'sound-tren': 'Sound tren',
  'tanpa-audio': 'Tanpa audio'
};

/** The four acts of the story bible, in play order. */
export type BeatName = 'hook' | 'setup' | 'turn' | 'payoff';
export const BEAT_NAMES: readonly BeatName[] = ['hook', 'setup', 'turn', 'payoff'];
export const BEAT_LABELS: Readonly<Record<BeatName, string>> = {
  hook: 'Pembuka',
  setup: 'Dasar cerita',
  turn: 'Balik arah',
  payoff: 'Penutup'
};

/** Where a beat starts in the cloned timeline. */
export type BeatMark = { beat: BeatName; atSec: number; label: string };

/**
 * One trend card. Exactly the fields the UI contract names — no extras: the page renders
 * this shape, and anything else belongs to the source (see `TrendSeed`).
 */
export type TrendItem = {
  id: string;
  source: TrendSourceId;
  title: string;
  channel: string;
  url: string;
  thumbnail: string;
  views: number;
  likes: number;
  comments: number;
  publishedAtMs: number;
  durationSec: number;
  region: string;
  /** views per hour since publish (min 1 h), rounded to 0.1. */
  velocity: number;
  /** (likes + comments) / views, rounded to 4 decimals. */
  engagement: number;
  hook: HookType;
  beats: BeatMark[];
  shotCount: number;
  avgShotSec: number;
  captionStyle: CaptionStyle;
  audioType: AudioType;
  /** 0–100, rounded. Deterministic for a given (item, niche, now). */
  score: number;
};

/**
 * What a platform adapter actually knows: the card fields minus everything derived, plus the
 * text the deconstruction needs (description, optional ASR transcript). Sources turn seeds
 * into `TrendItem`s through `enrichSeeds` in `pipeline.ts`, so scoring/deconstruction is
 * written once and never duplicated per platform.
 */
export type TrendSeed = {
  id: string;
  source: TrendSourceId;
  title: string;
  channel: string;
  url: string;
  thumbnail: string;
  views: number;
  likes: number;
  comments: number;
  publishedAtMs: number;
  durationSec: number;
  region: string;
  /** Caption / video description; feeds the deconstruction (hook, caption, audio, CTA). */
  description?: string;
  /** Offline ASR transcript, when the source has one (DTK transcriber, instaloader captions). */
  transcript?: string;
};

export type TrendQuery = {
  region: Region;
  /** Window in hours (24 / 168 / 720). */
  windowHours: number;
  niche?: Niche;
  /** Clock used for velocity/freshness; injected so tests are deterministic. */
  nowMs?: number;
};

/** A platform adapter. Unconfigured sources are never fetched and never throw. */
export type TrendSource = {
  id: TrendSourceId;
  configured(): boolean;
  fetch(q: TrendQuery): Promise<TrendItem[]>;
};

/**
 * The plan a cloned trend turns into: the structure of the hit (beats, pacing, hook, audio,
 * caption), a look that fits it, and the same number of shots with empty slots.
 */
export type CloneBrief = {
  /** The trend this came from (`<source>:<id>`). */
  sourceId: string;
  source: TrendSourceId;
  /** Working title for the new story, Indonesian. */
  title: string;
  hook: HookType;
  audioType: AudioType;
  captionStyle: CaptionStyle;
  beats: BeatMark[];
  /** hook → payoff, with the goal of each beat in Indonesian. */
  structure: Array<{ act: BeatName; goal: string; beat: string }>;
  look: { family: string; variant: string; reason: string };
  /** One scene per act; the shots of that act, in order. */
  scenes: Array<{ id: string; title: string; goal: string; shots: string[] }>;
  /** Empty shots: an id, its beat and time mark, and the goal to fill. Visual slots stay empty. */
  shots: Array<{ id: string; beat: BeatName; atSec: number; goal: string }>;
  /** True when the source gave us no duration and the pacing is the 15 s default. */
  durationEstimated: boolean;
};
