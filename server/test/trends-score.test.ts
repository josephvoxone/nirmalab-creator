/**
 * Scoring math (spec §4.5). Every assertion is a number a human can check by hand: the clock
 * is a parameter, so nothing here depends on the day the suite runs.
 */
import { describe, expect, it } from 'vitest';
import {
  ENGAGEMENT_CEILING,
  FRESHNESS_HALF_LIFE_HOURS,
  NICHE_KEYWORDS,
  SCORE_WEIGHTS,
  engagementRate,
  freshness,
  nicheMatch,
  regionLift,
  scoreParts,
  trendScore,
  velocityPerHour
} from '../src/trends/score.js';

/** 2026-10-25T12:00:00Z — the fixture clock. */
const NOW = 1_792_929_600_000;
const HOUR = 3_600_000;

describe('velocity', () => {
  it('divides views by hours since publish', () => {
    expect(velocityPerHour(2_000, NOW - 4 * HOUR, NOW)).toBe(500);
    expect(velocityPerHour(1_200, NOW - 3 * HOUR, NOW)).toBe(400);
  });

  it('never divides by less than one hour, so a fresh post cannot be inflated', () => {
    // 10 minutes old: divided by 1 h, not 0.17 h.
    expect(velocityPerHour(1_000, NOW - 10 * 60_000, NOW)).toBe(1_000);
    expect(velocityPerHour(0, NOW - 60_000, NOW)).toBe(0);
  });

  it('is 0 when the publish time is unknown or the input is junk', () => {
    expect(velocityPerHour(5_000, 0, NOW)).toBe(0);
    expect(velocityPerHour(Number.NaN, NOW - HOUR, NOW)).toBe(0);
    expect(velocityPerHour(-10, NOW - HOUR, NOW)).toBe(0);
  });
});

describe('engagement', () => {
  it('is (likes + comments) / views', () => {
    expect(engagementRate(90, 10, 1_000)).toBeCloseTo(0.1, 6);
    expect(engagementRate(0, 0, 1_000)).toBe(0);
  });

  it('is 0 without views, and never negative', () => {
    expect(engagementRate(50, 5, 0)).toBe(0);
    expect(engagementRate(-50, -5, 1_000)).toBe(0);
  });
});

describe('freshness', () => {
  it('halves every 36 hours', () => {
    expect(freshness(NOW - FRESHNESS_HALF_LIFE_HOURS * HOUR, NOW)).toBeCloseTo(0.5, 6);
    expect(freshness(NOW - 2 * FRESHNESS_HALF_LIFE_HOURS * HOUR, NOW)).toBeCloseTo(0.25, 6);
    expect(freshness(NOW, NOW)).toBe(1);
  });

  it('keeps an unknown publish time neutral instead of zeroing it', () => {
    expect(freshness(0, NOW)).toBe(0.5);
  });
});

describe('niche match', () => {
  it('needs two keywords for a full score, one for half', () => {
    expect(nicheMatch('AI prompt untuk film pendek', '', 'ai')).toBe(1);
    expect(nicheMatch('Kenapa AI bikin film aneh?', '', 'ai')).toBe(0.5);
    expect(nicheMatch('Resep pisang goreng', '', 'ai')).toBe(0);
  });

  it('matches whole words only (ai is not "said" or "rain")', () => {
    expect(nicheMatch('She said it would rain', '', 'ai')).toBe(0);
    expect(nicheMatch('Kecerdasan buatan untuk dongeng', '', 'ai')).toBe(0.5);
  });

  it('is neutral when no chip is picked, so a chip is a filter and not a penalty', () => {
    expect(nicheMatch('apa saja', '', undefined)).toBe(0.5);
  });

  it('reads every niche from one keyword table', () => {
    expect(nicheMatch('storybook untuk anak', '', 'anak')).toBe(1);
    expect(nicheMatch('plot twist di ending', '', 'cerita')).toBe(1);
    expect(Object.keys(NICHE_KEYWORDS).sort()).toEqual(['ai', 'anak', 'cerita', 'cinematic', 'faceless']);
  });
});

describe('final score', () => {
  it('is a weighted sum of the four parts, 0–100', () => {
    const parts = scoreParts({ views: 812_345, likes: 52_310, comments: 1_840, publishedAtMs: NOW - 18 * HOUR, title: 'Kenapa AI bikin film terasa aneh?', description: 'Prompt film AI yang gagal karena satu slot kosong.' }, { niche: 'ai' }, NOW);
    expect(parts.velocity).toBeCloseTo(1, 4);
    expect(parts.engagement).toBeCloseTo(0.066662 / ENGAGEMENT_CEILING, 4);
    expect(parts.freshness).toBeCloseTo(Math.pow(0.5, 0.5), 4);
    expect(parts.niche).toBe(1);
    expect(trendScore({ views: 812_345, likes: 52_310, comments: 1_840, publishedAtMs: NOW - 18 * HOUR, title: 'Kenapa AI bikin film terasa aneh?', description: 'Prompt film AI yang gagal karena satu slot kosong.' }, { niche: 'ai' }, NOW)).toBe(80);
  });

  it('weights sum to 1 (otherwise the scale would not be 0–100)', () => {
    const sum = Object.values(SCORE_WEIGHTS).reduce((total, weight) => total + weight, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('ranks a key-less shelf by views share instead of flat-lining every card', () => {
    const seed = (views: number) => ({ views, likes: 0, comments: 0, publishedAtMs: 0, title: 'x', description: '' });
    const peak = 10_000;
    const hot = trendScore(seed(peak), {}, NOW, peak);
    const cold = trendScore(seed(50), {}, NOW, peak);
    expect(hot).toBeGreaterThan(cold);
    expect(hot).toBeGreaterThan(50);
    expect(cold).toBeLessThan(hot);
    // Without the peak (no batch context) nothing pretends to know the ranking.
    expect(trendScore(seed(peak), {}, NOW, 0)).toBe(trendScore(seed(50), {}, NOW, 0));
  });

  it('stays inside 0–100 and is deterministic', () => {
    const wild = { views: 10 ** 12, likes: 10 ** 12, comments: 10 ** 12, publishedAtMs: NOW - 60_000, title: 'AI AI AI', description: 'prompt veo midjourney' };
    const first = trendScore(wild, { niche: 'ai' }, NOW);
    expect(first).toBeLessThanOrEqual(100);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(trendScore(wild, { niche: 'ai' }, NOW)).toBe(first);

    const dead = { views: 0, likes: 0, comments: 0, publishedAtMs: 0, title: '', description: '' };
    // No date and no likes ⇒ the degraded branch renormalises over freshness + niche only.
    expect(trendScore(dead, {}, NOW)).toBe(20);
  });

  it('ranks a fresh viral item above an older, bigger one', () => {
    const fresh = trendScore({ views: 300_000, likes: 24_000, comments: 900, publishedAtMs: NOW - 5 * HOUR, title: 'AI film 30 detik' }, { niche: 'ai' }, NOW);
    const stale = trendScore({ views: 5_000_000, likes: 210_000, comments: 9_800, publishedAtMs: NOW - 15 * 24 * HOUR, title: 'AI film 30 detik' }, { niche: 'ai' }, NOW);
    expect(fresh).toBeGreaterThan(stale);
  });
});

describe('region lift', () => {
  it('compares today against the 7-day baseline', () => {
    expect(regionLift(2_000, 1_000)).toBe(2);
    expect(regionLift(1_000, 2_000)).toBe(0.5);
  });

  it('is flat (1) when there is no baseline to compare with', () => {
    expect(regionLift(5_000, 0)).toBe(1);
    expect(regionLift(5_000, Number.NaN)).toBe(1);
  });
});
