/**
 * Deterministic prompt compiler (spec §4.3).
 *
 * `compileShot` turns a shot intent plus the two bibles into one image prompt and one video
 * prompt with a fixed segment order — shot grammar → subject & action → start/end state →
 * setting → light → optics → palette & medium → text policy → negative → audio. Same order
 * for every shot, so the model sees the same structure each time.
 *
 * Mandatory slots are enforced (a missing one rejects the shot, it never compiles silently),
 * TOKENs are expanded from the bible, and the negative list merges the look's forbidden
 * terms with the board's own list without duplicates.
 *
 * Pure: no IO.
 */
import { CATALOG } from '../stories/looks.js';
import { characterByToken, locationByKey, rulesOf, type SceneCard, type StoryBible } from './story.js';
import type { StyleBible } from './styles.js';

/** What the LLM (or a human) fills in: intent only, never prompt prose. */
export type ShotIntent = {
  /** Character TOKEN (`LARAS`) or a plain noun phrase; TOKENs are expanded to names. */
  subject: string;
  /** One verb chain. No "and then", no second action. */
  action: string;
  startState: string;
  endState: string;
  emotion?: string;
  /** Overrides the scene location; a mismatch with the bible warns but compiles. */
  setting?: string;
  /** Framing id from the studio catalog (e.g. `medium-close`); defaults to `medium`. */
  framing?: string;
  /** Exactly one camera move id from the studio catalog (e.g. `push-in`); defaults to `static`. */
  move?: string;
  /** Indonesian line; expanded names, max `rules.narrationMaxWords` words. */
  narration?: string;
  /** TOKEN/name of the character who speaks the line on camera (dialogue, not voice-over). */
  speaker?: string;
  /** No voice-over at all (intro/outro beats). */
  silent?: boolean;
};

export type CompiledShot = {
  imagePrompt: string;
  videoPrompt: string;
  /** Merged forbidden terms, `''` when there are none. */
  negative: string;
  /** The audio direction, `''` when the shot has no audio segment. */
  audio: string;
  warnings: string[];
};

/** Mandatory slot or lint failure: the shot must not be rendered. */
export class ShotCompileError extends Error {
  override readonly name = 'ShotCompileError';
  constructor(readonly issues: string[]) {
    super(issues.join('; '));
  }
}

// The specifics (logos, watermarks, captions) live in the negative list, once.
const TEXT_POLICY = 'No on-screen text.';

const GEAR = /\b(jib|crane|technocrane|dolly track|slider rig|camera rig|rig|drones?|steadicam|gimbal|film crew)\b/i;
const MOVES = /\b(pans?|tilts?|zooms?|dollies|pushes in|pulls back|orbits?|tracks?|rises|cranes?|arcs?)\b/gi;
/** An empty adjective counts only when it props up a generic noun or ends the phrase. */
const EMPTY_ADJECTIVE = /\b(beautiful|stunning|gorgeous|epic|cinematic|majestic|breathtaking|amazing|awesome|dramatic|elegant|iconic|radiant|indah|megah|epik|sinematik|dramatis|memukau|keren)\b(?=\s*(?:[,.]|$|\s+(?:shot|scene|view|frame|image|picture|woman|man|person|girl|boy|portrait|gambar|adegan|pemandangan|orang|wanita|pria|sosok)))/i;
const TOKEN_SHAPE = /(?:^|[\s("])[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/;

const words = (text: string | undefined) => (text ?? '').trim().split(/\s+/).filter(Boolean).length;

/** Sentence case + one full stop, keeping inner punctuation (quotes, decimals). */
function sentence(text: string): string {
  const clean = text.trim().replace(/[.\s]+$/, '');
  return clean ? `${clean.charAt(0).toUpperCase()}${clean.slice(1)}.` : '';
}

/** Strip a leading "Negative prompt:" label so merged lists stay flat. */
const negativeTerms = (text: string | undefined): string[] =>
  (text ?? '').replace(/^\s*(negative prompt|negative|hindari)\s*:/i, '').split(/[,;]+/).map(t => t.trim()).filter(Boolean);

/**
 * Lint an English prompt string. Every finding is a hard failure for the caller.
 * `tokens` are the bible TOKENs that must never survive in a prompt; `maxWords` bounds any
 * quoted narration found in the text.
 */
export function lintPrompt(text: string, options: { tokens?: string[]; maxWords?: number } = {}): string[] {
  const issues: string[] = [];
  const prompt = text ?? '';
  const adjective = prompt.match(EMPTY_ADJECTIVE);
  if (adjective) issues.push(`empty adjective "${adjective[1]}" stands alone — show it with a concrete detail instead`);
  const gear = prompt.match(GEAR);
  if (gear) issues.push(`names camera gear ("${gear[1]}") that the model renders in frame`);
  const moves = [...new Set((prompt.match(MOVES) ?? []).map(m => m.toLowerCase()))];
  if (moves.length > 1) issues.push(`more than one camera move (${moves.join(', ')})`);
  const maxWords = options.maxWords ?? 12;
  for (const quoted of prompt.match(/"[^"]*"/g) ?? []) {
    const inner = quoted.slice(1, -1).trim();
    const count = words(inner);
    if (count > maxWords) issues.push(`narration has ${count} words (max ${maxWords} to fit ~6 s)`);
  }
  for (const token of options.tokens ?? []) {
    if (new RegExp(`\\b${token}\\b`).test(prompt)) issues.push(`TOKEN ${token} is not expanded to a name`);
  }
  const shaped = prompt.match(TOKEN_SHAPE);
  if (shaped && !(options.tokens ?? []).some(token => shaped[0].includes(token))) {
    issues.push(`TOKEN ${shaped[0].trim()} is not expanded to a name`);
  }
  return issues;
}

const expansionOf = (bible: StoryBible) => {
  const pairs = (bible.characters ?? []).filter(c => /^[A-Z][A-Z0-9_]{1,30}$/.test(c.token ?? '') && c.name?.trim());
  return (text: string | undefined): string => {
    let out = text ?? '';
    for (const c of pairs) out = out.replace(new RegExp(`\\b${c.token}\\b`, 'g'), c.name.trim());
    return out;
  };
};

const framingText = (id: string) => CATALOG.framings.find(f => f.id === id)?.prompt ?? '';
const moveText = (id: string) => CATALOG.moves.find(m => m.id === id)?.prompt ?? '';

const CLOSE = new Set(['close-up', 'extreme-close', 'medium-close', 'over-shoulder']);
const WIDE = new Set(['wide', 'extreme-wide', 'full', 'overhead']);

/** Deterministic lens for a framing: longest lens on faces, widest on the world, middle otherwise. */
function lensFor(look: StyleBible, framing: string): string {
  const lenses = look.lenses.filter(Boolean);
  if (!lenses.length) return '';
  if (CLOSE.has(framing)) return lenses[lenses.length - 1]!;
  if (WIDE.has(framing)) return lenses[0]!;
  return lenses[Math.floor((lenses.length - 1) / 2)]!;
}

/** Look.forbidden first, then the board's own terms, deduped case-insensitively. */
function mergeNegative(look: StyleBible, extra: string | undefined): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const forbidden of look.forbidden ?? []) {
    const key = forbidden.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    terms.push(forbidden.trim());
  }
  for (const term of negativeTerms(extra)) {
    const key = term.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    terms.push(key);
  }
  return terms;
}

export function compileShot(input: {
  look: StyleBible;
  bible: StoryBible;
  scene?: SceneCard;
  shot: ShotIntent;
  /** The board's negative prompt, merged with `look.forbidden`. */
  negative?: string;
}): CompiledShot {
  const { look, bible, scene, shot } = input;
  const issues: string[] = [];
  const warnings: string[] = [];
  const expand = expansionOf(bible);

  // ---- shot grammar ----------------------------------------------------------------
  const framingId = shot.framing?.trim() || 'medium';
  const moveId = shot.move?.trim() || 'static';
  const framing = framingText(framingId);
  const move = moveText(moveId);
  if (shot.framing !== undefined && !framing) warnings.push(`framing "${shot.framing}" is unknown; falling back to a medium shot`);
  if (shot.move !== undefined && !move) warnings.push(`camera move "${shot.move}" is unknown; falling back to a static camera`);
  const grammar = sentence([framing || 'Medium shot', move || 'the camera stays still'].join(', '));

  // ---- mandatory slots -------------------------------------------------------------
  const subject = expand(shot.subject).trim();
  const action = expand(shot.action).trim();
  const startState = expand(shot.startState).trim();
  const endState = expand(shot.endState).trim();
  if (!subject) issues.push('mandatory slot subject is empty');
  if (!action) issues.push('mandatory slot action is empty');
  if (!startState) issues.push('mandatory slot startState is empty');
  if (!endState) issues.push('mandatory slot endState is empty');
  if (startState && endState && startState.toLowerCase() === endState.toLowerCase()) issues.push('shot has no state change: startState equals endState');
  if (/\band then\b|\bthen\b|;\s*then\b/i.test(action)) issues.push('action must be one verb chain, not "and then"');

  const lens = lensFor(look, framingId);
  if (!lens) issues.push('mandatory slot lens is empty (the look has no lenses)');
  if (!look.light?.key?.trim() || !look.light?.fill?.trim() || !look.light?.rim?.trim() || !look.light?.temp?.trim()) {
    issues.push('mandatory slot lightDirection is empty (look.light key, fill, rim and temp are required)');
  }
  if ((look.palette ?? []).filter(p => /^#[0-9a-f]{6}$/i.test(p.hex ?? '')).length < 2) {
    issues.push('mandatory slot palette needs at least two hex anchors');
  }
  if (!look.medium) issues.push('mandatory slot medium is empty');
  if (!look.styleSentence?.trim()) issues.push('mandatory slot styleSentence is empty');

  const location = scene?.location ? locationByKey(bible, scene.location) : undefined;
  let setting = shot.setting?.trim() ?? '';
  if (setting) {
    if (location && !setting.toLowerCase().includes(location.name.toLowerCase())) {
      warnings.push(`setting does not match bible location ${location.key} ("${location.name}"); used verbatim`);
    }
  } else if (location) {
    setting = [location.name, location.lookdev].filter(Boolean).join(', ');
  } else {
    issues.push('mandatory slot setting is empty (no scene location and no shot.setting)');
  }

  // ---- audio + narration -----------------------------------------------------------
  const narration = expand(shot.narration).trim();
  if (!shot.emotion?.trim()) warnings.push('emotion is empty; the face will default to neutral');
  const maxWords = rulesOf(bible).narrationMaxWords;
  if (narration) {
    const count = words(narration);
    if (count > maxWords) issues.push(`narration has ${count} words (max ${maxWords} to fit ~6 s)`);
  }
  const speaker = shot.speaker ? characterByToken(bible, shot.speaker)?.name ?? shot.speaker.trim() : '';
  if (shot.speaker && !characterByToken(bible, shot.speaker)) warnings.push(`speaker ${shot.speaker} is not in the bible; kept as written`);
  const audio = shot.silent
    ? 'Audio: ambient room tone only, no voice.'
    : narration
      ? `Audio: ${speaker ? `Dialogue, ${speaker} speaking` : 'Voice-over in'} Bahasa Indonesia: "${narration}"`
      : '';

  const terms = mergeNegative(look, input.negative);
  const negative = terms.length ? `Negative: ${terms.join(', ')}.` : '';

  // ---- segments, fixed order -------------------------------------------------------
  const segments = [
    grammar,
    sentence(`${subject} ${action}`),
    `${sentence(`Starts: ${startState}`)} ${sentence(`Ends: ${endState}`)}`,
    sentence(`Setting: ${setting}`),
    sentence(`Light: ${look.light.key}, ${look.light.fill}, ${look.light.rim}, ${look.light.temp}`),
    sentence(`Optics: ${lens}, ${look.aperture}`),
    `Style: ${look.styleSentence}`,
    TEXT_POLICY,
    negative,
    audio
  ].filter(Boolean);

  const imagePrompt = segments.slice(0, 8).join(' ');
  const videoPrompt = segments.join(' ');

  issues.push(...lintPrompt(imagePrompt, { tokens: (bible.characters ?? []).map(c => c.token), maxWords }));
  if (issues.length) throw new ShotCompileError(issues);

  return { imagePrompt, videoPrompt, negative, audio, warnings };
}
