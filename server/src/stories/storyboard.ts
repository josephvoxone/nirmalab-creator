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
/** A place in the breakdown; `look` is the English visual descriptor added as the shot's Setting. */
export type Location = { name: string; look: string };
/** A chapter of the film: ordered shot ids, optionally set in one location. */
export type Scene = {
  id: string;
  title: string;
  summary?: string;
  location?: string;
  shots: string[];
};
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
  /** One Indonesian sentence. */
  logline?: string;
  /** Key: UPPERCASE token, e.g. PASAR_IKAN. */
  locations?: Record<string, Location>;
  scenes?: Scene[];
  shots: Shot[];
};

export const CREDITS_PER_SHOT = 10;
export const MAX_NARRATION_WORDS = 12;
export const SHOT_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const SCENE_ID = SHOT_ID;
export const LOCATION_KEY = /^[A-Z][A-Z0-9_]{1,30}$/;
export const MAX_SCENES = 20;
export const MAX_LOCATIONS = 20;

const hasKey = (obj: object | undefined, key: string | undefined) => !!obj && typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Scene invariants (same rules as the web model): at least one scene; unknown and repeated
 * shot ids dropped; unlisted shots appended to the last scene; empty scenes kept;
 * `shots` in scene order; scene locations must be keys of `locations`. Pure, returns a copy.
 */
export function normalizeScenes(board: Storyboard): Storyboard {
  const shots = Array.isArray(board.shots) ? board.shots : [];
  const byId = new Map(shots.map(s => [s.id, s]));
  const used = new Set<string>();
  const raw = Array.isArray(board.scenes) ? board.scenes : [];
  const scenes: Scene[] = raw.map(scene => {
    const { location, shots: ids, ...rest } = scene;
    const kept = (Array.isArray(ids) ? ids : []).filter(id => {
      if (!byId.has(id) || used.has(id)) return false;
      used.add(id);
      return true;
    });
    return { ...rest, ...(hasKey(board.locations, location) ? { location } : {}), shots: kept };
  });
  if (!scenes.length) scenes.push({ id: 'scene-1', title: 'Scene 1', shots: [] });
  const rest = shots.filter(s => !used.has(s.id)).map(s => s.id);
  const last = scenes[scenes.length - 1]!;
  last.shots = [...last.shots, ...rest];
  const ordered = scenes.flatMap(sc => sc.shots.map(id => byId.get(id)!));
  // Duplicate shot ids (rejected by validation) would collapse in the map: keep the input order then.
  return { ...board, scenes, shots: ordered.length === shots.length ? ordered : shots };
}

export function sceneOf(board: Storyboard, shotId: string): Scene | undefined {
  return normalizeScenes(board).scenes!.find(sc => sc.shots.includes(shotId));
}

/** `Setting: <look>.` when the shot's scene is set in a known location. */
function settingLine(board: Storyboard, shot: Shot): string {
  const key = sceneOf(board, shot.id)?.location;
  const look = key ? board.locations?.[key]?.look?.trim().replace(/[.\s]+$/, '') : '';
  return look ? `Setting: ${look}.` : '';
}

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
  return `${expand(board, shot.prompt, true)} ${settingLine(board, shot)} ${board.style ?? ''}${keep} Vertical ${board.aspect ?? '9:16'} cinematic frame, no text.`.replace(/\s+/g, ' ').trim();
}

export function buildShotPrompt(board: Storyboard, shot: Shot): string {
  const body = expand(board, shot.prompt, board.mode === 'konsisten');
  const audio = shot.silent
    ? board.audioSilent ?? ''
    : (board.audio ?? '').replace('{narrator}', board.narrator ?? 'a narrator').replace('{line}', expand(board, (shot.narration ?? '').trim(), true));
  return [body, settingLine(board, shot), board.style, audio].filter(Boolean).join(' ') + (board.negative ? `\n${board.negative}` : '');
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
  errors.push(...validateBreakdown(board));
  return errors;
}

/** Scenes + locations (unknown shot ids and unknown scene locations are not errors: normalizeScenes drops them). */
function validateBreakdown(board: Storyboard): string[] {
  const errors: string[] = [];
  if (board.scenes !== undefined) {
    if (!Array.isArray(board.scenes)) errors.push('scenes must be a list');
    else {
      if (board.scenes.length > MAX_SCENES) errors.push(`too many scenes (max ${MAX_SCENES})`);
      const seen = new Set<string>();
      for (const scene of board.scenes) {
        const id = typeof scene?.id === 'string' ? scene.id : '';
        if (!SCENE_ID.test(id)) { errors.push(`invalid scene id "${scene?.id}" (lowercase letters, digits, dashes)`); continue; }
        if (seen.has(id)) errors.push(`${id}: duplicate scene id`);
        seen.add(id);
        const title = typeof scene.title === 'string' ? scene.title.trim() : '';
        if (!title) errors.push(`scene ${id}: title is empty`);
        else if (title.length > 80) errors.push(`scene ${id}: title too long (max 80)`);
        if (scene.summary !== undefined && (typeof scene.summary !== 'string' || scene.summary.length > 300)) errors.push(`scene ${id}: summary too long (max 300)`);
        if (!Array.isArray(scene.shots)) errors.push(`scene ${id}: shots must be a list of shot ids`);
      }
    }
  }
  if (board.locations !== undefined) {
    if (!board.locations || typeof board.locations !== 'object' || Array.isArray(board.locations)) errors.push('locations must be an object');
    else {
      const entries = Object.entries(board.locations);
      if (entries.length > MAX_LOCATIONS) errors.push(`too many locations (max ${MAX_LOCATIONS})`);
      for (const [key, loc] of entries) {
        if (!LOCATION_KEY.test(key)) { errors.push(`invalid location key "${key}" (UPPERCASE letters, digits, underscores)`); continue; }
        if (!(typeof loc?.name === 'string' && loc.name.trim())) errors.push(`location ${key}: name is empty`);
        if (!(typeof loc?.look === 'string' && loc.look.trim())) errors.push(`location ${key}: look is empty`);
      }
    }
  }
  return errors;
}
