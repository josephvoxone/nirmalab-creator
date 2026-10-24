/**
 * Seed → card pipeline for the trend radar.
 *
 * Every platform adapter produces `TrendSeed`s (what its API actually said) and this module
 * turns them into the `TrendItem` the UI renders: deconstruction + scoring + window filter +
 * ordering. One implementation, so YouTube, TikTok, Douyin and Instagram cannot drift into
 * three different ideas of what a "score" or a "shot count" is.
 *
 * Pure; the clock is a parameter. `collectTrends` is the only async part and it only awaits
 * the sources — it never throws for an unconfigured or failing platform (spec §9.7).
 */
import { deconstruct } from './deconstruct.js';
import { engagementRate, trendScore, velocityPerHour } from './score.js';
import type { TrendItem, TrendQuery, TrendSeed, TrendSource, TrendSourceId } from './types.js';

export type SourceFlag = { configured: boolean; items: number };
export type CollectResult = {
  items: TrendItem[];
  /** Sources that were configured and answered (or answered with nothing). */
  configured: TrendSourceId[];
  /** Per-source flags in the response; an unconfigured source is `{configured:false, items:0}`. */
  sources: Record<string, SourceFlag>;
};

const round = (n: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
};

/**
 * Inside the window. An unknown publish time is kept: a trending board lists phrases with no
 * date, and dropping them would hide whole platforms from every window (they score low
 * anyway, via `freshness`).
 */
export function withinWindow(publishedAtMs: number, nowMs: number, windowHours: number): boolean {
  if (!(windowHours > 0)) return true;
  if (!(publishedAtMs > 0)) return true;
  return publishedAtMs >= nowMs - windowHours * 3_600_000;
}

/** Highest score first, then most viewed, then id — a total order, so the page never shuffles. */
export function sortItems(items: TrendItem[]): TrendItem[] {
  return [...items].sort((a, b) => b.score - a.score || b.views - a.views || a.id.localeCompare(b.id));
}

/** One card per seed: deconstruct, score, round, and drop what the window excludes. */
export function enrichSeeds(seeds: TrendSeed[], query: TrendQuery, nowMs = query.nowMs ?? Date.now()): TrendItem[] {
  const items: TrendItem[] = [];
  for (const seed of seeds) {
    const publishedAtMs = Number.isFinite(seed.publishedAtMs) ? Math.max(0, Math.round(seed.publishedAtMs)) : 0;
    if (!withinWindow(publishedAtMs, nowMs, query.windowHours)) continue;
    const parsed = deconstruct({
      title: seed.title,
      description: seed.description,
      durationSec: seed.durationSec,
      transcript: seed.transcript
    });
    items.push({
      id: seed.id,
      source: seed.source,
      title: seed.title,
      channel: seed.channel,
      url: seed.url,
      thumbnail: seed.thumbnail,
      views: Math.max(Math.round(seed.views), 0),
      likes: Math.max(Math.round(seed.likes), 0),
      comments: Math.max(Math.round(seed.comments), 0),
      publishedAtMs,
      durationSec: Math.max(Math.round(seed.durationSec), 0),
      region: seed.region,
      velocity: round(velocityPerHour(seed.views, publishedAtMs, nowMs), 1),
      engagement: round(engagementRate(seed.likes, seed.comments, seed.views), 4),
      hook: parsed.hook,
      beats: parsed.beats,
      shotCount: parsed.shotCount,
      avgShotSec: parsed.avgShotSec,
      captionStyle: parsed.captionStyle,
      audioType: parsed.audioType,
      score: trendScore(seed, query, nowMs)
    });
  }
  return sortItems(items);
}

/**
 * Ask every configured source and merge the answers. A source that is not configured is not
 * called at all; a source that throws is caught and reported as zero items, because one
 * broken platform must not blank the page.
 */
export async function collectTrends(sources: TrendSource[], query: TrendQuery): Promise<CollectResult> {
  const configured: TrendSourceId[] = [];
  const flags: Record<string, SourceFlag> = {};
  const merged = new Map<string, TrendItem>();

  for (const source of sources) {
    const on = source.configured();
    flags[source.id] = { configured: on, items: 0 };
    if (!on) continue;
    configured.push(source.id);
    let items: TrendItem[] = [];
    try {
      items = await source.fetch(query);
    } catch {
      items = [];
    }
    // Key includes the source: two platforms can hand out the same numeric id.
    for (const item of items) {
      const key = `${item.source}:${item.id}`;
      const seen = merged.get(key);
      if (!seen || item.score > seen.score) merged.set(key, item);
    }
    flags[source.id]!.items = items.length;
  }

  return { items: sortItems([...merged.values()]), configured, sources: flags };
}
