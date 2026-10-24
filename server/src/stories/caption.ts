/**
 * The publish caption, generated from the story's own facts (spec §7 P4).
 *
 * Formula: one concrete first line (what you see), one tension (the obstacle the story
 * already names) and one payoff (how it lands). Everything is taken from the storyboard —
 * title, logline, narration, kicker, bible theme — never invented, so a story without a
 * logline simply gets a shorter caption. Every line is lint-clean before it is used: a line
 * that only a rewrite could fix is dropped, and the caption falls back to what is left.
 *
 * Pure: no IO, deterministic.
 */
import { NARRATION_MAX_WORDS, lintCopy, repairCopy, type CopyKind } from '../text/lint.js';

export type CaptionStory = {
  title: string;
  /** One sentence: who wants what, and what stands in the way. */
  logline?: string;
  /** Title-card tagline. */
  kicker?: string;
  /** Studio template id (`drama-hewan`), used only for one hashtag. */
  template?: string;
  /** Spoken narration lines in play order. */
  lines?: string[];
  bible?: { logline?: string; theme?: string } | null;
};

const CAPTION_MAX_LINES = 3;
const MAX_HASHTAGS = 3;

const firstSentence = (text: string): string => (text.trim().match(/^[^.!?\n]+[.!?]?/)?.[0] ?? text.trim()).trim();

/** A line we are willing to publish: repaired, then linted; `''` when it cannot be saved. */
function usable(line: string | undefined, kind: CopyKind = 'caption'): string {
  const raw = (line ?? '').trim();
  if (!raw) return '';
  const repaired = repairCopy(raw, { kind }).text;
  return lintCopy(repaired, { kind }).length ? '' : repaired;
}

/** Narration lines are content, so they get the 12-word beat budget before the caption lint. */
function usableNarration(line: string | undefined): string {
  const raw = (line ?? '').trim();
  if (!raw) return '';
  const repaired = repairCopy(raw, { kind: 'narration' }).text;
  if (repaired.trim().split(/\s+/).length > NARRATION_MAX_WORDS) return '';
  return lintCopy(repaired, { kind: 'caption' }).length ? '' : repaired;
}

const HASHTAG_STOP = new Set(['yang', 'dan', 'untuk', 'dengan', 'dari', 'kisah', 'cerita', 'the', 'and', 'video', 'baru', 'lagi']);

function hashtags(story: CaptionStory): string[] {
  const fromTitle = (story.title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 4 && !HASHTAG_STOP.has(word))
    .slice(0, 2);
  const tag = (story.template ?? '').split('-')[0] ?? '';
  const tags = [...fromTitle, ...(tag.length >= 4 && !HASHTAG_STOP.has(tag) ? [tag] : [])];
  return [...new Set(tags)].slice(0, MAX_HASHTAGS).map(word => `#${word}`);
}

/**
 * The caption a publisher starts from: up to three lines (hook, tension, payoff) plus up to
 * three hashtags. Shorter when the story does not carry the facts — never padded.
 */
export function captionFor(story: CaptionStory): string {
  const lines: string[] = [];
  const push = (line: string) => {
    const clean = line.trim();
    if (clean && !lines.includes(clean)) lines.push(clean);
  };
  const spoken = (story.lines ?? []).map(usableNarration).filter(Boolean);
  const logline = usable(story.logline ?? story.bible?.logline, 'caption') || usable(firstSentence(story.logline ?? story.bible?.logline ?? ''), 'caption');
  const kicker = usable(story.kicker, 'caption');
  const theme = usable(story.bible?.theme, 'caption');

  // 1. hook: the first concrete thing the film shows, then the logline, then the title.
  push(spoken[0] ?? '');
  if (!lines.length) push(usable(firstSentence(logline || story.title), 'caption'));

  // 2. tension: the obstacle the logline already names, else a middle beat that carries stakes.
  if (logline && !lines.includes(logline)) push(logline);
  if (lines.length < 2) push(spoken[1] ?? '');

  // 3. payoff: the last spoken beat, else the title card, else the theme.
  if (lines.length < CAPTION_MAX_LINES) push(spoken[spoken.length - 1] ?? '');
  if (lines.length < CAPTION_MAX_LINES) push(kicker);
  if (lines.length < CAPTION_MAX_LINES) push(theme);

  const body = lines.slice(0, CAPTION_MAX_LINES).join('\n');
  const tags = hashtags(story).join(' ');
  return tags ? `${body}\n\n${tags}` : body;
}
