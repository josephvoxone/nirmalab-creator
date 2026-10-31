/**
 * Storyboard → Veo shot prompts. Pure: no IO. Rules come from the cinematic-footage
 * research (one camera move per shot, never name camera gear, ≤12 narration words
 * per 6 s shot so Veo's native voice-over fits).
 *
 * A board with a `bible` compiles its prompts from the production bible (`bible/compiler.ts`)
 * and hashes them under `PROMPT_VERSION`. A board without one keeps the legacy `style`
 * string, the legacy prompt text and the legacy hash byte for byte, so migration never
 * re-renders a paid clip.
 */
import { createHash } from 'node:crypto';
import { ShotCompileError, compileShot, type CompiledShot, type ShotIntent } from '../bible/compiler.js';
import { validateBible, type SceneCard, type StoryBible } from '../bible/story.js';
import { LEGACY_STYLE_MAP, compileStyleSentence, lookById, type StyleBible } from '../bible/styles.js';
import { CATALOG } from './looks.js';
import { AXCEL_MODELS, isAxcelModel, type AxcelModel } from '../providers/axcel.js';
import { MUSIC_FILE } from './music.js';

/** Timeline In/Out inside the rendered clip, seconds (absent out = the clip's end). */
export type ShotTrim = { in?: number; out?: number };
/** The music track: the stored file, where it starts on the timeline (`at`) and inside the song (`from`). */
export type EditMusic = { file: string; name: string; seconds: number; volume: number; at: number; from?: number };
/** Timeline edits applied at assembly only: never part of a clip prompt, so they never re-render. */
/** Subtitle looks: absent = plain captions at the bottom; 'tulisan-tangan' = hand-lettering in the sky band. */
export const SUBTITLE_STYLES = ['tulisan-tangan'] as const;
export type SubtitleStyle = typeof SUBTITLE_STYLES[number];
/** subtitleSize: font scale (1 = the style's default); subtitleY: top of the text as a share of the frame height;
 * subtitleKaraoke: false turns off the word-by-word highlight of dubbed shots (absent = on).
 * fadeIn: seconds (0..1.2) of the opening fade from black; absent = 0.8, what every video made before this field had.
 * beatCuts: "potong ritme" — hard cuts to a punch-in inside a clip at the pauses of the voice (absent or false = off; { zoom } tunes it, 1.05..1.3). */
export type TimelineEdit = { fadeIn?: number; beatCuts?: { zoom?: number } | false; clipVolume?: number; subtitles?: boolean; subtitleStyle?: SubtitleStyle; subtitleSize?: number; subtitleY?: number; subtitleKaraoke?: boolean; music?: EditMusic };

export type Shot = {
  id: string;
  trim?: ShotTrim;
  /** Assembly-only crop into the clip (1 = none, max 1.4): hides a page edge the model drew. Never in a prompt. */
  zoom?: number;
  /** Where the zoom window sits vertically: 0 top, 0.5 centre (default), 1 bottom. Pinned to the bottom, the crop comes off the top (page edge + stray caption). */
  zoomY?: number;
  /** Subtitle text of this shot when it should differ from the narration (assembly only, never in a prompt). */
  caption?: string;
  prompt: string;
  narration?: string;
  /** No voice-over: uses `audioSilent` (intro/outro beats). */
  silent?: boolean;
  /** Reuse an existing Flow clip instead of generating (optionally trimmed). */
  reuse?: { jobId: string; start?: number };
  transition?: string;
  /** Bible boards: what the shot must do. Prompts are compiled from this, never from prose. */
  intent?: ShotIntent;
  /** An uploaded start frame (`uploads/up_….ext`); used by OpenRouter video engines only. */
  startFrame?: string;
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
/** Who renders: Flow (bridge, default), an OpenRouter model or an Axcel model (paid by the plan). */
export type Engine = { provider: 'flow' } | { provider: 'openrouter'; model: string } | { provider: 'axcel'; model: AxcelModel };

/** Clip length Axcel accepts closest to the 6 s a shot is written for (Seedance: 5, Veo 3.1 Fast: 8). */
export function axcelClipSec(model: AxcelModel): number {
  return model === 'Veo 3.1 Fast' ? 8 : 5;
}
/** Project clips on Axcel render at 720p (the bridge default, 480, is for quick Studio tries). */
export const AXCEL_PROJECT_RESOLUTION = 720;

/** A shot is rendered without a voice: its own `silent`, or the whole story is ambient-only. */
export function isSilent(board: Pick<Storyboard, 'audioMode'>, shot: Pick<Shot, 'silent'> & { intent?: { silent?: boolean } }): boolean {
  return board.audioMode === 'ambient' || !!(shot.intent?.silent ?? shot.silent);
}

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
  edit?: TimelineEdit;
  /** 'ambient': no voice in any clip, only the sound of the place (music is added later in the edit). */
  audioMode?: 'narration' | 'ambient';
  negative?: string;
  crossfade?: number;
  titleCard?: { lines: string[]; kicker?: string };
  /** One Indonesian sentence. */
  logline?: string;
  /** Publish caption: concrete first line, one tension, one payoff (stories/caption.ts). */
  caption?: string;
  /** Key: UPPERCASE token, e.g. PASAR_IKAN. */
  locations?: Record<string, Location>;
  scenes?: Scene[];
  shots: Shot[];
  /** image = character sheets + keyframes, video = clips. Absent = Flow for both. */
  engine?: { image?: Engine; video?: Engine };
  /** Production bible: when present, prompts are compiled (PROMPT_VERSION) instead of prose. */
  bible?: StoryBible;
  /**
   * Let a failing clip audit re-render the clip on its own (10 Flow credits per try, spec §9.5).
   * Default off: a clip repair waits for an explicit click. Never crosses the daily credit cap.
   */
  autoRepairClip?: boolean;
};

export const CREDITS_PER_SHOT = 10;
export const MAX_NARRATION_WORDS = 12;
export const SHOT_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const SCENE_ID = SHOT_ID;
export const LOCATION_KEY = /^[A-Z][A-Z0-9_]{1,30}$/;
export const MAX_SCENES = 20;
export const MAX_LOCATIONS = 20;
/** A stored upload of the story (assistant/uploads.ts writes them): references and start frames. */
export const UPLOAD_REF = /^uploads\/up_[a-f0-9]{16}\.(png|jpg|webp)$/;

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

export const titleCase = (token: string) => token.toLowerCase().split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

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

/** "Keep <names> exactly as in their character reference…" or '' when nobody is in frame. */
function keepClause(board: Storyboard, shot: Shot): string {
  const names = shotCast(board, shot).map(c => c.name);
  return names.length ? ` Keep ${names.join(' and ')} exactly as in their character reference (same face, hair, outfit, colours).` : '';
}

/** Still keyframe for a shot: composition + characters by name; their look comes from the attached character references. */
export function framePrompt(board: Storyboard, shot: Shot): string {
  return `${expand(board, shot.prompt, true)} ${settingLine(board, shot)} ${board.style ?? ''}${keepClause(board, shot)} Vertical ${board.aspect ?? '9:16'} cinematic frame, no text.`.replace(/\s+/g, ' ').trim();
}

export function buildShotPrompt(board: Storyboard, shot: Shot): string {
  const body = expand(board, shot.prompt, board.mode === 'konsisten');
  const audio = isSilent(board, shot)
    ? board.audioSilent ?? ''
    : (board.audio ?? '').replace('{narrator}', board.narrator ?? 'a narrator').replace('{line}', expand(board, (shot.narration ?? '').trim(), true));
  return [body, settingLine(board, shot), board.style, audio].filter(Boolean).join(' ') + (board.negative ? `\n${board.negative}` : '');
}

export function newShots(board: Storyboard): Shot[] {
  return board.shots.filter(s => !s.reuse);
}

// ------------------------------------------------------------------ bible boards (PROMPT_VERSION)

/** Bumped when the compiled prompt text changes: it is part of the clip hash for bible boards. */
export const PROMPT_VERSION = 2;
/** Spec §9.5: drama and faceless default to film-real. */
export const DEFAULT_LOOK_ID = 'film-real';

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * The look of a board: an explicit family+variant pick wins, then the legacy style id
 * (`board.look.style`, the studio picker), then film-real. Deterministic, never random.
 */
export function lookFor(board: Storyboard): StyleBible {
  const family = typeof board.look?.family === 'string' ? board.look.family.trim() : '';
  const variant = typeof board.look?.variant === 'string' ? board.look.variant.trim() : '';
  if (family) {
    const picked = lookById(variant && variant !== family ? `${family}:${variant}` : family) ?? lookById(family);
    if (picked) return picked;
  }
  const legacy = typeof board.look?.style === 'string' ? board.look.style.trim() : '';
  const mapped = legacy ? LEGACY_STYLE_MAP[legacy] : undefined;
  if (mapped) return lookById(`${mapped.family}:${mapped.variant}`) ?? lookById(mapped.family)!;
  return lookById(DEFAULT_LOOK_ID)!;
}

/** The bible scene a shot belongs to: same scene id, else same title, else same location key, else the only one. */
export function bibleSceneFor(board: Storyboard, shot: Shot): SceneCard | undefined {
  const scenes = board.bible?.scenes ?? [];
  if (!scenes.length) return undefined;
  const scene = sceneOf(board, shot.id);
  const byId = scene ? scenes.find(s => s.id === scene.id) : undefined;
  if (byId) return byId;
  const byTitle = scene ? scenes.find(s => s.title.trim().toLowerCase() === scene.title.trim().toLowerCase()) : undefined;
  if (byTitle) return byTitle;
  const byLocation = scene?.location ? scenes.find(s => s.location === scene.location) : undefined;
  if (byLocation) return byLocation;
  return scenes.length === 1 ? scenes[0] : undefined;
}

/** True when this shot's prompts come from the compiler rather than the legacy prose path. */
export function usesCompiler(board: Storyboard, shot: Shot): boolean {
  return !!board.bible && !!shot.intent && !shot.reuse;
}

/** Compiled prompts for one shot of a bible board. Throws ShotCompileError on a missing slot. */
export function compileBoardShot(board: Storyboard, shot: Shot): CompiledShot {
  if (!board.bible) throw new ShotCompileError([`shot ${shot.id}: the board has no bible`]);
  if (!shot.intent) throw new ShotCompileError([`shot ${shot.id}: intent is empty (subject, action, startState, endState, framing, move)`]);
  const scene = bibleSceneFor(board, shot);
  if (!scene) throw new ShotCompileError([`shot ${shot.id}: no bible scene matches its scene — add the scene goal to the bible`]);
  // Camera picks and the spoken line may live on the shot (the drafter's shape) or on the intent.
  const camera = shot as Shot & { framing?: string; move?: string };
  const intent: ShotIntent = {
    ...shot.intent,
    framing: shot.intent.framing ?? (typeof camera.framing === 'string' ? camera.framing : undefined),
    move: shot.intent.move ?? (typeof camera.move === 'string' ? camera.move : undefined),
    narration: shot.intent.narration ?? shot.narration,
    silent: isSilent(board, shot)
  };
  return compileShot({ look: lookFor(board), bible: board.bible, scene, shot: intent, negative: board.negative });
}

/** Catalog prompt text for a framing/move given as id or as its prompt text; `fallback` id otherwise. */
function optionText(options: Array<{ id: string; prompt: string }>, value: unknown, fallback: string): string {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const hit = v ? options.find(o => o.id === v || o.prompt.toLowerCase() === v) : undefined;
  return (hit ?? options.find(o => o.id === fallback)!).prompt;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Prose `shot.prompt` of a bible shot, rebuilt from its intent (spec §9.9):
 * "<Framing>, the camera <move>. <TOKEN…> <action>." The TOKENs are the characters the subject
 * names (by token or name, any case), so TOKEN-based cast detection (`shotCast`) keeps working.
 * The compiler never reads this text: clip/frame prompts of bible shots do not depend on it.
 */
export function promptFromIntent(board: Storyboard, shot: Shot): string {
  const camera = shot as Shot & { framing?: string; move?: string };
  const framing = optionText(CATALOG.framings, shot.intent?.framing ?? camera.framing, 'medium');
  const move = optionText(CATALOG.moves, shot.intent?.move ?? camera.move, 'static');
  const subject = (shot.intent?.subject ?? '').trim().replace(/[.\s]+$/, '');
  const names = new Map<string, Set<string>>();
  const add = (token: string, name: string | undefined) => {
    if (!/^[A-Z][A-Z0-9_]{1,30}$/.test(token)) return;
    const set = names.get(token) ?? new Set<string>([token]);
    if (name?.trim()) set.add(name.trim());
    names.set(token, set);
  };
  for (const c of board.bible?.characters ?? []) add(c.token, c.name);
  for (const [token, spec] of Object.entries(board.characters ?? {})) add(token, member(token, spec).name);
  const found: Array<{ token: string; at: number; end: number }> = [];
  for (const [token, aliases] of names) {
    for (const a of aliases) {
      for (const m of subject.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(a)}(?![\\p{L}\\p{N}_])`, 'giu'))) {
        found.push({ token, at: m.index!, end: m.index! + m[0].length });
      }
    }
  }
  // A name inside a longer name ("Nadia" in "Nadia Sukses") is part of that name, not a second character.
  const kept = found.filter(f => !found.some(g => g.token !== f.token && g.at <= f.at && g.end >= f.end && g.end - g.at > f.end - f.at));
  const first = new Map<string, number>();
  for (const f of kept) first.set(f.token, Math.min(first.get(f.token) ?? Infinity, f.at));
  const who = first.size ? [...first].sort((a, b) => a[1] - b[1]).map(([token]) => token).join(' and ') : subject;
  const action = (shot.intent?.action ?? '').trim().replace(/[.\s]+$/, '');
  const body = [who, action].filter(Boolean).join(' ');
  return `${framing}, ${move}.${body ? ` ${body}.` : ''}`.replace(/\s+/g, ' ').trim();
}

/** Exact text sent to Flow for a clip: compiled for bible shots, legacy prose otherwise. */
export function shotPromptFor(board: Storyboard, shot: Shot): string {
  return usesCompiler(board, shot) ? compileBoardShot(board, shot).videoPrompt : buildShotPrompt(board, shot);
}

/** Exact text sent for a keyframe. */
export function framePromptFor(board: Storyboard, shot: Shot): string {
  if (!usesCompiler(board, shot)) return framePrompt(board, shot);
  const image = compileBoardShot(board, shot).imagePrompt;
  return `${image}${keepClause(board, shot)} Vertical ${board.aspect ?? '9:16'} keyframe.`.replace(/\s+/g, ' ').trim();
}

/** Exact text sent for a character sheet; bible boards also pin the locked style sentence. */
export function sheetPromptFor(member: CastMember, board: Storyboard): string {
  const sheet = characterSheetPrompt(member, board);
  return board.bible ? `${sheet} ${compileStyleSentence(lookFor(board))}` : sheet;
}

/** Hash input: versioned for bible boards, byte-identical to v1 for legacy boards. */
const hashInput = (board: Storyboard, prompt: string) => (board.bible ? `${PROMPT_VERSION}|${prompt}` : prompt);

/**
 * Compiling can fail on an unfinished draft (spec §9.8: loose save, strict render). Such a take
 * can never be current, so it hashes to a value no real prompt can produce.
 */
const UNCOMPILED = 'uncompiled';

/** Clip hash of a shot (reuse clips hash their reuse spec, as before). */
export function hashFor(board: Storyboard, shot: Shot): string {
  if (shot.reuse) return digest(JSON.stringify(shot.reuse));
  try {
    return digest(hashInput(board, shotPromptFor(board, shot)));
  } catch (error) {
    if (error instanceof ShotCompileError) return UNCOMPILED;
    throw error;
  }
}

export function frameHashFor(board: Storyboard, shot: Shot): string {
  try {
    return digest(hashInput(board, framePromptFor(board, shot)));
  } catch (error) {
    if (error instanceof ShotCompileError) return UNCOMPILED;
    throw error;
  }
}

export function sheetHashFor(member: CastMember, board: Storyboard): string {
  return digest(hashInput(board, sheetPromptFor(member, board)));
}

export function validateStoryboard(board: Storyboard): string[] {
  const errors: string[] = [];
  if (!board?.title?.trim()) errors.push('title is empty');
  // A bible is validated on save (spec §9.8: strict on rules, loose on unfinished slots).
  if (board?.bible !== undefined) errors.push(...validateBible(board.bible));
  // Flow picks a character by its cast name (prefix fallback), and prompts say that name.
  const cast: CastMember[] = [];
  for (const [token, spec] of Object.entries(board?.characters ?? {})) {
    if (!spec) continue;
    const m = member(token, spec);
    const name = m.name.trim().replace(/\s+/g, ' ').toLowerCase();
    const clash = cast.find(o => { const n = o.name.trim().replace(/\s+/g, ' ').toLowerCase(); return n === name || n.startsWith(`${name} `) || name.startsWith(`${n} `); });
    if (clash) errors.push(`karakter ${token}: nama "${m.name.trim()}" bentrok dengan "${clash.name.trim()}" (${clash.token}) — Flow memilih karakter lewat nama, jadi nama tidak boleh sama atau mengawali nama lain`);
    else cast.push(m);
  }
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
    if (shot.startFrame !== undefined && !(typeof shot.startFrame === 'string' && UPLOAD_REF.test(shot.startFrame))) errors.push(`${shot.id}: startFrame must be an upload of this story (uploads/up_….png)`);
    if (shot.reuse) {
      if (!/^job_[a-f0-9]{16}$/.test(shot.reuse.jobId ?? '')) errors.push(`${shot.id}: reuse.jobId must be a Flow job id`);
      continue;
    }
    // Compiled shots (bible + intent) are linted by the compiler; everything else is prose and
    // keeps the prose rules — a derived intent never excuses bad prose.
    if (!usesCompiler(board, shot)) {
      if (!shot.prompt?.trim()) errors.push(`${shot.id}: prompt is empty`);
      if (GEAR.test(shot.prompt ?? '')) errors.push(`${shot.id}: names camera gear (jib/crane/rig) that Veo renders in frame`);
      const moves = new Set((shot.prompt ?? '').toLowerCase().match(CAMERA_MOVES) ?? []);
      if (moves.size > 1) errors.push(`${shot.id}: more than one camera move (${[...moves].join(', ')})`);
      if (buildShotPrompt(board, shot).length > 3800) errors.push(`${shot.id}: prompt too long`);
    }
    if (!isSilent(board, shot)) {
      const words = narrationWords(shot.narration);
      if (words === 0) errors.push(`${shot.id}: narration is empty`);
      if (words > MAX_NARRATION_WORDS) errors.push(`${shot.id}: narration has ${words} words (max ${MAX_NARRATION_WORDS} to fit ~6 s)`);
    }
  }
  errors.push(...validateBreakdown(board));
  errors.push(...validateEngine(board.engine));
  if (board.audioMode !== undefined && board.audioMode !== 'narration' && board.audioMode !== 'ambient') errors.push('audioMode must be narration or ambient');
  errors.push(...validateEdit(board));
  return errors;
}

const MODEL_ID = /^[a-z0-9][\w.-]*\/[\w.:-]+$/i;

/** `engine` of a storyboard (absent = Flow for both). Exported for the draft route. */
export function validateEngine(engine: unknown): string[] {
  if (engine === undefined) return [];
  if (!engine || typeof engine !== 'object' || Array.isArray(engine)) return ['engine must be an object { image?, video? }'];
  const errors: string[] = [];
  for (const kind of ['image', 'video'] as const) {
    const e = (engine as Record<string, unknown>)[kind] as { provider?: unknown; model?: unknown } | undefined;
    if (e === undefined) continue;
    if (!e || typeof e !== 'object') errors.push(`engine.${kind} must be { provider }`);
    else if (e.provider === 'openrouter') {
      if (!(typeof e.model === 'string' && e.model.length <= 120 && MODEL_ID.test(e.model))) errors.push(`engine.${kind}: model is required for openrouter (e.g. google/veo-3.1-fast)`);
    } else if (e.provider === 'axcel') {
      if (!isAxcelModel(e.model)) errors.push(`engine.${kind}: model for axcel must be one of ${AXCEL_MODELS.join(', ')}`);
    } else if (e.provider !== 'flow') errors.push(`engine.${kind}: provider must be flow, openrouter or axcel`);
  }
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

/** The opening fade a video had before `edit.fadeIn` existed (seconds), and the longest one allowed. */
export const DEFAULT_FADE_IN = 0.8;
export const MAX_FADE_IN = 1.2;
/** The shot-to-shot transitions the assembler may be told (ffmpeg xfade names that Debian's ffmpeg 5.1 has too). Anything else never reaches a filter graph. */
export const XFADE_TRANSITIONS: readonly string[] = [
  'fade', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'slideleft', 'slideright', 'slideup', 'slidedown', 'circlecrop', 'rectcrop', 'distance',
  'fadeblack', 'fadewhite', 'radial', 'smoothleft', 'smoothright', 'smoothup', 'smoothdown', 'circleopen', 'circleclose', 'vertopen', 'vertclose',
  'horzopen', 'horzclose', 'dissolve', 'pixelize', 'diagtl', 'diagtr', 'diagbl', 'diagbr', 'hlslice', 'hrslice', 'vuslice', 'vdslice', 'hblur',
  'fadegrays', 'wipetl', 'wipetr', 'wipebl', 'wipebr', 'squeezeh', 'squeezev', 'zoomin'
];
const isNum = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** Trims and the timeline edit (music, clip volume, subtitles). */
export function validateEdit(board: Storyboard): string[] {
  const errors: string[] = [];
  for (const shot of board.shots) {
    if (shot.transition !== undefined && !(typeof shot.transition === 'string' && XFADE_TRANSITIONS.includes(shot.transition))) errors.push(`${shot.id}: transition must be one of: ${XFADE_TRANSITIONS.join(', ')}`);
    if (shot.zoom !== undefined && !isNum(shot.zoom, 1, 1.4)) errors.push(`${shot.id}: zoom must be a number from 1 to 1.4`);
    if (shot.zoomY !== undefined && !isNum(shot.zoomY, 0, 1)) errors.push(`${shot.id}: zoomY must be a number from 0 (top) to 1 (bottom)`);
    if (shot.caption !== undefined && (typeof shot.caption !== 'string' || shot.caption.length > 200)) errors.push(`${shot.id}: caption must be text of at most 200 characters`);
    const t = shot.trim as unknown;
    if (t === undefined) continue;
    const trim = t as ShotTrim;
    if (!t || typeof t !== 'object' || (trim.in !== undefined && !isNum(trim.in, 0, 60)) || (trim.out !== undefined && !isNum(trim.out, 0.5, 60))
      || (trim.out !== undefined && trim.out <= (trim.in ?? 0))) {
      errors.push(`${shot.id}: trim must be { in, out } seconds with 0 ≤ in < out ≤ 60`);
    }
  }
  const e = board.edit as unknown;
  if (e === undefined) return errors;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return [...errors, 'edit must be an object'];
  const edit = e as TimelineEdit;
  if (edit.clipVolume !== undefined && !isNum(edit.clipVolume, 0, 2)) errors.push('edit.clipVolume must be 0..2');
  if (edit.fadeIn !== undefined && !isNum(edit.fadeIn, 0, MAX_FADE_IN)) errors.push(`edit.fadeIn must be a number of seconds from 0 to ${MAX_FADE_IN}`);
  if (edit.beatCuts !== undefined && edit.beatCuts !== false) {
    const bc = edit.beatCuts as unknown;
    if (!bc || typeof bc !== 'object' || Array.isArray(bc) || ((bc as { zoom?: unknown }).zoom !== undefined && !isNum((bc as { zoom?: unknown }).zoom, 1.05, 1.3))) errors.push('edit.beatCuts must be false or an object { zoom?: 1.05 to 1.3 }');
  }
  if (edit.subtitles !== undefined && typeof edit.subtitles !== 'boolean') errors.push('edit.subtitles must be true or false');
  if (edit.subtitleSize !== undefined && !isNum(edit.subtitleSize, 0.6, 2)) errors.push('edit.subtitleSize must be a number from 0.6 to 2');
  if (edit.subtitleY !== undefined && !isNum(edit.subtitleY, 0.02, 0.9)) errors.push('edit.subtitleY must be a number from 0.02 to 0.9');
  if (edit.subtitleKaraoke !== undefined && typeof edit.subtitleKaraoke !== 'boolean') errors.push('edit.subtitleKaraoke must be true or false');
  if (edit.subtitleStyle !== undefined && !(SUBTITLE_STYLES as readonly string[]).includes(edit.subtitleStyle)) errors.push(`edit.subtitleStyle must be one of: ${SUBTITLE_STYLES.join(', ')}`);
  const m = edit.music as unknown as Record<string, unknown> | undefined;
  if (m !== undefined) {
    if (!m || typeof m !== 'object') errors.push('edit.music must be an object');
    else {
      if (typeof m.file !== 'string' || !MUSIC_FILE.test(m.file)) errors.push('edit.music.file must be the uploaded music file');
      if (typeof m.name !== 'string' || m.name.length > 120) errors.push('edit.music.name must be text (≤ 120)');
      if (!isNum(m.seconds, 0, 3600)) errors.push('edit.music.seconds must be the song length');
      if (!isNum(m.volume, 0, 2)) errors.push('edit.music.volume must be 0..2');
      if (!isNum(m.at, 0, 3600)) errors.push('edit.music.at must be ≥ 0 seconds');
      if (m.from !== undefined && !isNum(m.from, 0, 3600)) errors.push('edit.music.from must be ≥ 0 seconds');
    }
  }
  return errors;
}

/** `fadeIn: 0.8` and `beatCuts: false` say out loud what an absent field already means: they must not stale a finished video. */
function canonicalEdit(edit: TimelineEdit | undefined): TimelineEdit | undefined {
  if (!edit || (edit.fadeIn !== DEFAULT_FADE_IN && edit.beatCuts !== false)) return edit;
  const { ...out } = edit;
  if (out.fadeIn === DEFAULT_FADE_IN) delete out.fadeIn;
  if (out.beatCuts === false) delete out.beatCuts;
  return Object.keys(out).length ? out : undefined;
}

/** What the assembled video depends on besides the clips: a change means "assemble again". */
export function editPrint(board: Storyboard): string {
  return JSON.stringify({
    e: canonicalEdit(board.edit) ?? null,
    s: board.shots.map(s => [s.id, s.trim ?? null, board.edit?.subtitles ? subtitleOf(s) : null, ...(s.zoom && s.zoom !== 1 ? [s.zoom] : []), ...(s.zoom && s.zoom !== 1 && s.zoomY !== undefined && s.zoomY !== 0.5 ? [`y${s.zoomY}`] : [])])
  });
}

/** The spoken/subtitled line of a shot (bible shots may keep it on the intent). */
/** The subtitle line of a shot: its own caption when set, else its narration. */
export function subtitleOf(shot: Shot): string {
  return typeof shot.caption === 'string' && shot.caption.trim() ? shot.caption.trim() : narrationOf(shot);
}

export function narrationOf(shot: Shot): string {
  return ((shot.intent as { narration?: string } | undefined)?.narration ?? shot.narration ?? '').trim();
}
