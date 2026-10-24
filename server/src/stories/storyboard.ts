/**
 * Storyboard → Veo shot prompts. Pure: no IO. Rules come from the cinematic-footage
 * research (one camera move per shot, never name camera gear, ≤12 narration words
 * per 6 s shot so Veo's native voice-over fits).
 */

export type Shot = {
  id: string;
  prompt: string;
  narration?: string;
  /** No voice-over: uses `audioSilent` (intro/outro beats). */
  silent?: boolean;
  /** Reuse an existing Flow clip instead of generating (optionally trimmed). */
  reuse?: { jobId: string; start?: number };
  transition?: string;
};

export type CharacterSpec = string | { name: string; look: string };
export type CastMember = { token: string; name: string; look: string };

export type Storyboard = {
  title: string;
  slug?: string;
  /** konsisten = character sheets + approved keyframes animated (default for new stories); cepat = text-to-video per shot. */
  mode?: 'konsisten' | 'cepat';
  /** Studio picks (ids from looks.ts); `style` holds their composed prompt text. */
  template?: string;
  look?: Record<string, string>;
  aspect?: '9:16' | '16:9';
  characters?: Record<string, CharacterSpec>;
  style?: string;
  narrator?: string;
  audio?: string;
  audioSilent?: string;
  negative?: string;
  crossfade?: number;
  titleCard?: { lines: string[]; kicker?: string };
  shots: Shot[];
};

export const CREDITS_PER_SHOT = 10;
export const MAX_NARRATION_WORDS = 12;
export const SHOT_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

const GEAR = /jib arm|camera crane|technocrane|slider rig|dolly track|camera rig|drone flies|film crew|steadicam rig|gimbal/i;
const CAMERA_MOVES = /\b(pans?|tilts?|zooms?|dollies|pushes in|pulls back|orbits?|tracks?|rises|cranes?|arcs?)\b/gi;

export function narrationWords(text: string | undefined): number {
  return (text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

const titleCase = (token: string) => token.toLowerCase().split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

function member(token: string, spec: CharacterSpec): CastMember {
  return typeof spec === 'string' ? { token, name: titleCase(token), look: spec } : { token, name: spec.name || titleCase(token), look: spec.look };
}

const tokenRe = (token: string) => new RegExp(`\\b${token}\\b`, 'g');

/** Characters that appear in at least one shot. */
export function castOf(board: Storyboard): CastMember[] {
  return Object.entries(board.characters ?? {})
    .map(([token, spec]) => member(token, spec))
    .filter(c => board.shots.some(s => !s.reuse && tokenRe(c.token).test(s.prompt)));
}

export function shotCast(board: Storyboard, shot: Shot): CastMember[] {
  return castOf(board).filter(c => tokenRe(c.token).test(shot.prompt));
}

/** Replace tokens with display names (konsisten: the look comes from the attached reference) or full descriptors (cepat). */
function expand(board: Storyboard, text: string, useNames: boolean): string {
  let out = text;
  for (const [token, spec] of Object.entries(board.characters ?? {})) {
    const m = member(token, spec);
    out = out.replace(tokenRe(token), useNames ? m.name : m.look);
  }
  return out;
}

export function characterSheetPrompt(c: CastMember, board: Storyboard): string {
  return [
    `Full body character reference sheet of ${c.name} on a plain warm white background, front, side and back views, same outfit in every view, no text: ${c.look}.`,
    board.style
  ].filter(Boolean).join(' ');
}

/** Still keyframe for a shot: composition + characters by name; their look comes from the attached character references. */
export function framePrompt(board: Storyboard, shot: Shot): string {
  const names = shotCast(board, shot).map(c => c.name);
  const keep = names.length ? ` Keep ${names.join(' and ')} exactly as in their character reference (same face, hair, outfit, colours).` : '';
  return `${expand(board, shot.prompt, true)} ${board.style ?? ''}${keep} Vertical ${board.aspect ?? '9:16'} cinematic frame, no text.`.replace(/\s+/g, ' ').trim();
}

export function buildShotPrompt(board: Storyboard, shot: Shot): string {
  const body = expand(board, shot.prompt, board.mode === 'konsisten');
  const audio = shot.silent
    ? board.audioSilent ?? ''
    : (board.audio ?? '').replace('{narrator}', board.narrator ?? 'a narrator').replace('{line}', expand(board, (shot.narration ?? '').trim(), true));
  return [body, board.style, audio].filter(Boolean).join(' ') + (board.negative ? `\n${board.negative}` : '');
}

export function newShots(board: Storyboard): Shot[] {
  return board.shots.filter(s => !s.reuse);
}

export function validateStoryboard(board: Storyboard): string[] {
  const errors: string[] = [];
  if (!board?.title?.trim()) errors.push('title is empty');
  if (!Array.isArray(board?.shots) || board.shots.length === 0) {
    errors.push('storyboard has no shots');
    return errors;
  }
  if (board.shots.length > 30) errors.push('too many shots (max 30)');
  const seen = new Set<string>();
  for (const shot of board.shots) {
    if (!SHOT_ID.test(shot.id ?? '')) { errors.push(`invalid shot id "${shot.id}" (lowercase letters, digits, dashes)`); continue; }
    if (seen.has(shot.id)) errors.push(`${shot.id}: duplicate shot id`);
    seen.add(shot.id);
    if (shot.reuse) {
      if (!/^job_[a-f0-9]{16}$/.test(shot.reuse.jobId ?? '')) errors.push(`${shot.id}: reuse.jobId must be a Flow job id`);
      continue;
    }
    if (!shot.prompt?.trim()) errors.push(`${shot.id}: prompt is empty`);
    if (GEAR.test(shot.prompt ?? '')) errors.push(`${shot.id}: names camera gear (jib/crane/rig) that Veo renders in frame`);
    const moves = new Set((shot.prompt ?? '').toLowerCase().match(CAMERA_MOVES) ?? []);
    if (moves.size > 1) errors.push(`${shot.id}: more than one camera move (${[...moves].join(', ')})`);
    if (!shot.silent) {
      const words = narrationWords(shot.narration);
      if (words === 0) errors.push(`${shot.id}: narration is empty`);
      if (words > MAX_NARRATION_WORDS) errors.push(`${shot.id}: narration has ${words} words (max ${MAX_NARRATION_WORDS} to fit ~6 s)`);
    }
    if (buildShotPrompt(board, shot).length > 3800) errors.push(`${shot.id}: prompt too long`);
  }
  return errors;
}
