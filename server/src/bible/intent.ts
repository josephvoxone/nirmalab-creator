/**
 * Draft-side intent contract (plan Task 5, spec §4.2/§9.6).
 *
 * The draft LLM writes INTENT, not prompt prose: what is in frame, the one action of the
 * beat, and what visibly changes between the first and the last frame. The prompt compiler
 * (spec §4.3) turns intent + bibles into the English prompt, so the writer never has to know
 * Veo's phrasing rules.
 *
 * The story-bible shapes are NOT redeclared here: `bible/story.ts` owns them (and its
 * validator), this file only imports them.
 */
import type { CharacterSpec, Shot, Storyboard } from '../stories/storyboard.js';
import type { StoryBible } from './story.js';

/** Per shot: who/what, the one action, and the visible change. No prompt prose. */
export type ShotIntent = {
  /** Character TOKEN or a concrete noun phrase from the frame. */
  subject: string;
  /** ONE verb chain in English (no "and then"); two beats are rejected by the compiler. */
  action: string;
  /** What is true in the first frame (posture, position, object, light). */
  startState: string;
  /** What is visibly different in the last frame. Must differ from `startState`. */
  endState: string;
  /** Mood of the beat, e.g. "waspada lalu lega". */
  emotion?: string;
};

/**
 * A shot as the drafter returns it: intent first, prose optional (legacy replies carry
 * `prompt` only). `intentDerived` means part of the intent was inferred from prose rather
 * than authored, so the compiler warns instead of failing. `framing`/`move` are the shot's
 * camera picks from the studio catalog, present only for authored intent.
 */
export type IntentShot = Shot & {
  intent?: ShotIntent;
  intentDerived?: boolean;
  framing?: string;
  move?: string;
};

/** A drafted storyboard: the normal board plus the story bible and per-shot intent. */
export type DraftStoryboard = Storyboard & { bible?: StoryBible; shots: IntentShot[] };

/** Cast map shared by the bible bridge (kept as an alias so both sides agree). */
export type DraftCast = Record<string, CharacterSpec>;
