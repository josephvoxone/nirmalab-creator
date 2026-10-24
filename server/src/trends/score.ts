/**
 * Signal scoring for the trend radar (spec §4.5).
 *
 * Pure and deterministic: every function takes the clock as an argument, so the same input
 * always produces the same score and a test can pin it. Nothing in here reads `Date.now()`,
 * a file or the network.
 *
 * The four signals and their weights (they sum to 1, which is what makes the score 0–100):
 *   velocity 0.45 · engagement 0.25 · freshness 0.20 · niche match 0.10
 *
 * Velocity is scored on a log scale because view counts are; engagement is a ratio against
 * a ceiling rather than a raw count so a small account can outrank a big one; freshness
 * halves every 36 h; niche match is the only signal that needs the query.
 */
import type { Niche, TrendQuery, TrendSeed } from './types.js';

/** views/hour that scores a perfect velocity (≈ the top of "most popular in 24 h"). */
export const VELOCITY_CEILING = 20_000;
/** (likes + comments) / views that scores a perfect engagement. */
export const ENGAGEMENT_CEILING = 0.15;
/** Freshness half-life: a 36 h old video keeps half its freshness weight. */
export const FRESHNESS_HALF_LIFE_HOURS = 36;
/** Neutral niche score when the query names no niche (keeps the weights summing to 1). */
export const NICHE_NEUTRAL = 0.5;

export const SCORE_WEIGHTS = { velocity: 0.45, engagement: 0.25, freshness: 0.2, niche: 0.1 } as const;

export type ScoreParts = { velocity: number; engagement: number; freshness: number; niche: number };
export type ScoreInput = Pick<TrendSeed, 'views' | 'likes' | 'comments' | 'publishedAtMs' | 'title' | 'description'>;

/**
 * What counts as a niche, in one place: the score's `nicheMatch` and the sources' default
 * search keywords both read this table, so a niche can never mean two different things.
 * The first keyword is also the hashtag/search word a source uses when the UI picked a chip.
 */
export const NICHE_KEYWORDS: Readonly<Record<Niche, readonly string[]>> = {
  ai: ['ai', 'kecerdasan buatan', 'chatgpt', 'midjourney', 'prompt', 'veo', 'ai video'],
  cinematic: ['cinematic', 'sinematik', 'short film', 'film pendek', 'trailer', 'teaser', 'b-roll'],
  faceless: ['faceless', 'tanpa wajah', 'voice over', 'voiceover', 'relaxing', 'asmr', 'motivasi'],
  anak: ['anak', 'kids', 'dongeng', 'cerita anak', 'kartun', 'balita', 'storybook'],
  cerita: ['cerita', 'story', 'kisah', 'plot twist', 'ending', 'storytime', 'storytelling']
};

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Keyword hit with word boundaries, so `ai` does not match "said" or "rain". */
function mentions(haystack: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}

const finite = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

/**
 * Views per hour since publish, with a 1 h floor: a video that is 10 minutes old divides by
 * 1, not by 0.17, so nobody can game the ranking by posting and refreshing the page.
 * An unknown publish time (0) scores 0 — velocity cannot be measured, and guessing it would
 * put unmeasurable items above measurable ones.
 */
export function velocityPerHour(views: number, publishedAtMs: number, nowMs: number): number {
  const v = Math.max(finite(views), 0);
  if (!(publishedAtMs > 0) || !Number.isFinite(nowMs)) return 0;
  const hours = Math.max((nowMs - publishedAtMs) / 3_600_000, 1);
  return v / hours;
}

/** (likes + comments) / views. 0 when there are no views; never negative. */
export function engagementRate(likes: number, comments: number, views: number): number {
  const v = Math.max(finite(views), 0);
  if (v <= 0) return 0;
  return (Math.max(finite(likes), 0) + Math.max(finite(comments), 0)) / v;
}

/** Exponential decay, half-life 36 h. Unknown publish time (0) is neutral (0.5), not zero. */
export function freshness(publishedAtMs: number, nowMs: number): number {
  if (!(publishedAtMs > 0) || !Number.isFinite(nowMs)) return 0.5;
  const ageHours = Math.max((nowMs - publishedAtMs) / 3_600_000, 0);
  return Math.pow(0.5, ageHours / FRESHNESS_HALF_LIFE_HOURS);
}

/**
 * How well a title/description serves the niche: 0 when nothing matches, 0.5 for one keyword,
 * 1 for two or more. One hit is a signal, not a verdict — a second keyword confirms it.
 * No niche in the query → neutral, so the chip is a filter, not a hidden penalty.
 */
export function nicheMatch(title: string, description: string | undefined, niche: Niche | undefined): number {
  if (!niche) return NICHE_NEUTRAL;
  const haystack = `${title ?? ''} ${description ?? ''}`.toLowerCase();
  const hits = NICHE_KEYWORDS[niche].filter(keyword => mentions(haystack, keyword)).length;
  return clamp01(hits / 2);
}

/** The four sub-scores, each 0–1. Exported so the UI could show why an item ranks. */
export function scoreParts(input: ScoreInput, query: Pick<TrendQuery, 'niche'> = {}, nowMs = Date.now()): ScoreParts {
  const velocity = clamp01(Math.log10(1 + velocityPerHour(input.views, input.publishedAtMs, nowMs)) / Math.log10(1 + VELOCITY_CEILING));
  const engagement = clamp01(engagementRate(input.likes, input.comments, input.views) / ENGAGEMENT_CEILING);
  return {
    velocity,
    engagement,
    freshness: clamp01(freshness(input.publishedAtMs, nowMs)),
    niche: nicheMatch(input.title, input.description, query.niche)
  };
}

/** Final 0–100 score: the weighted sum of the four sub-scores, rounded. */
export function trendScore(input: ScoreInput, query: Pick<TrendQuery, 'niche'> = {}, nowMs = Date.now()): number {
  const parts = scoreParts(input, query, nowMs);
  const weighted = parts.velocity * SCORE_WEIGHTS.velocity
    + parts.engagement * SCORE_WEIGHTS.engagement
    + parts.freshness * SCORE_WEIGHTS.freshness
    + parts.niche * SCORE_WEIGHTS.niche;
  return Math.round(Math.min(1, Math.max(0, weighted)) * 100);
}

/**
 * 7-day lift: today's views against the baseline the item had a week ago (spec §4.5
 * `regionLift`). 1 = flat, >1 = rising. A missing/zero baseline carries no information, so
 * it returns 1 rather than Infinity.
 */
export function regionLift(views: number, baselineViews: number): number {
  const now = Math.max(finite(views), 0);
  const base = Math.max(finite(baselineViews), 0);
  if (base <= 0) return 1;
  return Math.round((now / base) * 10) / 10;
}
