/**
 * The project action layer (spec §6.2): small, typed, validated operations on ONE story. The chat
 * panel, the MCP server and the new UI buttons all call these — there is no second implementation
 * of any edit.
 *
 * Rules every action keeps:
 * - Scope: the story id comes from the caller (URL / token context), never from model input; shot,
 *   scene, character and location references are resolved inside that story's board only.
 * - Undo: the first change of a turn snapshots the story (`ctx.turn.undoId`); later changes of the
 *   same turn reuse it and re-commit with the new revision. Every change passes the revision it
 *   read, so a concurrent edit is refused (STALE) instead of overwritten.
 * - Bible boards edit intent fields, never prompt text (the compiler writes prompts). Legacy boards
 *   edit only the one shot's prose and are never upgraded to a bible.
 * - Spending (Flow credits, OpenRouter money, queued jobs) needs `ctx.confirmed === true`, set by
 *   the caller (the user agreed in the app / MCP client), never by model input: a `confirm` key in
 *   the input is stripped and ignored. Without it the action returns `{ needsConfirm, label,
 *   estimate }` and queues nothing.
 */
import { ShotCompileError, lintPrompt, type ShotIntent } from '../bible/compiler.js';
import type { CharacterCard } from '../bible/story.js';
import { LOOK_IDS, lookById } from '../bible/styles.js';
import { cardFor } from '../bible/sync.js';
import { LlmError, type TextModel, type ToolSpec } from '../llm/opencode.js';
import { usdLabel } from '../providers/catalog.js';
import { CATALOG, composeStyle, resolveLook } from '../stories/looks.js';

import { BUSY_STATUSES, STALE_MESSAGE, StoryError, type StoryRecord, type StoryService } from '../stories/service.js';
import type { SnapshotStore } from '../stories/snapshots.js';
import {
  CREDITS_PER_SHOT, LOCATION_KEY, MAX_SCENES, compileBoardShot, normalizeScenes, promptFromIntent, sceneOf, shotCast,
  validateStoryboard, type Engine, type Scene, type Shot, type Storyboard
} from '../stories/storyboard.js';
import { cameraId, cameraIds, FRAMING_IDS, MOVE_IDS, type CameraKind } from './camera.js';
import { BreakdownError, MAX_BREAKDOWN, MIN_BREAKDOWN, REPLACE_REFUSED_MESSAGE, breakdownScene, defaultMode, hasDoneTake, withSceneShots, type BreakdownMode } from './breakdown.js';
import { planReference, rangeText, resolveCharacter, resolveLocation, resolveScene, resolveShot, sceneNumber, shotNumber, type Ref } from './resolve.js';
import { removeUpload, writePlanned, type PlannedUpload } from './uploads.js';
/** Studio look picks and their catalog lists: the only ids set_look accepts. */
const LOOK_PICKS: ReadonlyArray<readonly [string, ReadonlyArray<{ id: string }>]> = [
  ['style', CATALOG.styles], ['genre', CATALOG.genres], ['era', CATALOG.eras], ['camera', CATALOG.cameras], ['lens', CATALOG.lenses],
  ['aperture', CATALOG.apertures], ['palette', CATALOG.palettes], ['lighting', CATALOG.lighting], ['tempo', CATALOG.tempos]
];


// ------------------------------------------------------------------ types

export type ActionContext = {
  stories: StoryService;
  snapshots: SnapshotStore;
  /** Text model for `breakdown_scene`; absent = that action says so plainly. */
  model?: TextModel;
  userId: string;
  source: 'chat' | 'mcp' | 'ui';
  /**
   * One per turn (chat message / MCP call / UI click). `undoId` = this turn's snapshot (set by the
   * first change), `rev` = the revision right after this turn's last change.
   */
  turn: { undoId?: string; rev?: number };
  /**
   * The user agreed to this spending call. Set by the caller only (chat: the user posted the
   * pending id; MCP: the client's own `confirm` argument; UI: the confirm click) — never derived
   * from model input. Anything but `true` means "ask first".
   */
  confirmed?: boolean;
  /** OpenRouter price lookup for estimates (null/absent = unknown price). */
  price?: { usdPerClip(model: string): Promise<number | null>; usdPerImage?(model: string): Promise<number | null> };
  /** The caller's turn ends (deadline or client gone): slow work (the breakdown model call) stops, nothing is written after. */
  signal?: AbortSignal;
  /**
   * The storyboard revision the user approved a spending call on. When set, a confirmed spending
   * call runs only on that revision: checked before running and again under the story lock by the
   * service call that queues the jobs (anything else → STALE, nothing queued).
   */
  rev?: number;
};

export type ActionErrorCode = 'INVALID' | 'NOT_FOUND' | 'BUSY' | 'BUDGET' | 'STALE' | 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'FAILED';
export type Estimate = { credits?: number; usd?: number };
export type ActionResult =
  | { ok: true; label: string; changed?: boolean; data?: unknown }
  | { ok: false; error: string; code?: ActionErrorCode }
  | { ok: false; needsConfirm: true; label: string; estimate: Estimate };

export const ACTION_NAMES = [
  'get_project', 'edit_shot', 'add_shot', 'remove_shot', 'move_shot', 'breakdown_scene', 'edit_scene', 'add_scene', 'remove_scene',
  'edit_character', 'add_character', 'edit_location', 'add_location', 'set_look', 'make_sheet', 'redraw_frame', 'prepare', 'render',
  'assemble', 'undo_last'
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];
export type ActionInput = Record<string, unknown>;

export type Action = {
  /** English: read by the client's model. */
  description: string;
  /** JSON schema of `input` (OpenAI function parameters). */
  schema: object;
  spends: boolean;
  run(ctx: ActionContext, storyId: string, input: ActionInput): Promise<ActionResult>;
};

/** Shown for any change attempted while jobs run. */
export const BUSY_MESSAGE = 'Sedang dirender — tunggu selesai dulu';
export const UNDO_STALE_MESSAGE = 'Ada perubahan setelah ini — batalkan yang terbaru dulu';
export const NO_MODEL_MESSAGE = 'Model teks belum diatur — isi key di Pengaturan › Provider › Model teks.';
export const LEGACY_BREAKDOWN_MESSAGE = 'Pecah scene butuh bible — buat bible dulu di tab Bible.';
export const FLOW_REFERENCE_NOTE = 'Referensi disimpan; Flow memakai sheet yang dibuat.';

/** A bad input from the caller: becomes `{ ok: false, error }`, never a snapshot or a write. */
export class ActionInputError extends Error {}

// ------------------------------------------------------------------ small helpers

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fail = (error: string, code: ActionErrorCode = 'INVALID'): ActionResult => ({ ok: false, error, code });
const bad = (message: string): never => { throw new ActionInputError(message); };
const clip = (text: string | undefined, max: number) => {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, Math.max(1, max - 1))}…` : t;
};

function str(input: ActionInput, key: string, opts: { max?: number; required?: boolean; allowEmpty?: boolean } = {}): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return opts.required ? bad(`${key} wajib diisi`) : undefined;
  if (typeof value !== 'string') return bad(`${key} harus teks`);
  const s = value.trim();
  if (!s && (opts.required || !opts.allowEmpty)) return opts.required ? bad(`${key} wajib diisi`) : undefined;
  if (opts.max && s.length > opts.max) bad(`${key} terlalu panjang (maks ${opts.max} karakter)`);
  return s;
}

function bool(input: ActionInput, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  return typeof value === 'boolean' ? value : bad(`${key} harus true atau false`);
}

function ref(input: ActionInput, key: string, required = false): Ref | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') return required ? bad(`${key} wajib diisi (nomor, mis. 3)`) : undefined;
  return typeof value === 'number' || typeof value === 'string' ? value : bad(`${key} harus nomor atau id`);
}

function strings(input: ActionInput, key: string, opts: { max: number; each: number }): string[] | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  const list = (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[;\n]/) : bad(`${key} harus daftar teks`)) as unknown[];
  const out = list.map(v => (typeof v === 'string' ? v.trim() : bad(`${key} harus daftar teks`))).filter(Boolean);
  if (!out.length) bad(`${key} tidak boleh kosong`);
  if (out.length > opts.max) bad(`${key} maksimal ${opts.max} butir`);
  for (const v of out) if (v.length > opts.each) bad(`${key}: "${clip(v, 30)}" terlalu panjang (maks ${opts.each} karakter)`);
  return out;
}

const shotOf = (board: Storyboard, r: Ref) => { const x = resolveShot(board, r); return 'error' in x ? bad(x.error) : x; };
const sceneRef = (board: Storyboard, r: Ref) => { const x = resolveScene(board, r); return 'error' in x ? bad(x.error) : x; };

const TOKEN = /^[A-Z][A-Z0-9_]{1,20}$/;

/** A catalog framing/move id from the input (shared validator, see camera.ts); anything else is a plain error listing the ids. */
function camera(input: ActionInput, kind: CameraKind): string | undefined {
  const v = str(input, kind, { max: 40 });
  if (v === undefined) return undefined;
  return cameraId(kind, v) ?? bad(`${kind} "${clip(v, 30)}" tidak dikenal. Pilihan: ${cameraIds(kind).join(', ')}`);
}

const uniqueId = (taken: Iterable<string>, base: string): string => {
  const used = new Set(taken);
  const stem = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'item';
  if (!used.has(stem)) return stem;
  for (let i = 2; ; i++) if (!used.has(`${stem}-${i}`)) return `${stem}-${i}`;
};

/** The bible card of a board scene: same id, else same title (as sync does). */
const compileIssues = (board: Storyboard, shot: Shot): string[] => {
  try {
    compileBoardShot(board, shot);
    return [];
  } catch (error) {
    if (error instanceof ShotCompileError) return error.issues;
    throw error;
  }
};

// OpenRouter engines (priced per use); Axcel engines (paid by the plan); both take image files.
const imageEngine = (board: Storyboard) => board.engine?.image?.provider === 'openrouter' ? board.engine.image : undefined;
const videoEngine = (board: Storyboard) => board.engine?.video?.provider === 'openrouter' ? board.engine.video : undefined;
const axcelImage = (board: Storyboard) => board.engine?.image?.provider === 'axcel' ? board.engine.image : undefined;
const axcelVideo = (board: Storyboard) => board.engine?.video?.provider === 'axcel' ? board.engine.video : undefined;
const imageTakesFiles = (board: Storyboard) => !!(imageEngine(board) ?? axcelImage(board));
const videoTakesFiles = (board: Storyboard) => !!(videoEngine(board) ?? axcelVideo(board));
const axcelCost = (model: string) => `Axcel ${model} · termasuk paket, 0 kredit Flow`;

function toFailure(error: unknown): ActionResult {
  if (error instanceof ActionInputError || error instanceof BreakdownError) return fail(error.message);
  if (error instanceof StoryError) {
    if (error.code === 'BUSY') return fail(BUSY_MESSAGE, 'BUSY');
    if (error.code === 'STALE') return fail(STALE_MESSAGE, 'STALE');
    return fail(error.message, error.code);
  }
  if (error instanceof LlmError) return error.code === 'NOT_CONFIGURED' ? fail(NO_MODEL_MESSAGE, 'NOT_CONFIGURED') : fail(error.message, 'UNAVAILABLE');
  return fail(`Gagal: ${clip(error instanceof Error ? error.message : String(error), 300)}`, 'FAILED');
}

/** Story must exist; every failure becomes a plain `{ ok: false }`. */
async function guarded(ctx: ActionContext, storyId: string, fn: (record: StoryRecord) => Promise<ActionResult>): Promise<ActionResult> {
  try {
    const record = await ctx.stories.get(storyId);
    if (!record) return fail('Proyek tidak ditemukan.', 'NOT_FOUND');
    return await fn(record);
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * Append what an edit sent back to be made again: paid clips (with their cost) and keyframes whose
 * take was done before and is not done after. Says nothing when every take was kept.
 */
function withRedoNote<R extends ActionResult & { ok: true }>(result: R, before: StoryRecord | undefined, after: StoryRecord | undefined, board: Storyboard): R {
  if (!before || !after) return result;
  const was = new Map(before.shots.map(s => [s.id, s]));
  let clips = 0;
  let frames = 0;
  for (const now of after.shots) {
    const old = was.get(now.id);
    if (old?.status === 'done' && now.status !== 'done') clips += 1;
    if (old?.frame?.status === 'done' && now.frame?.status !== 'done') frames += 1;
  }
  if (!clips && !frames) return result;
  const ax = axcelVideo(board);
  const cost = videoEngine(board) ? 'biaya OpenRouter' : ax ? axcelCost(ax.model) : `±${clips * CREDITS_PER_SHOT} kredit Flow`;
  const frameCost = imageEngine(board) ? 'biaya OpenRouter' : axcelImage(board) ? 'termasuk paket Axcel' : 'gratis di Flow';
  const parts = [clips ? `${clips} klip (${cost})` : '', frames ? `${frames} keyframe (${frameCost})` : ''].filter(Boolean);
  return { ...result, label: `${result.label} — ${parts.join(' dan ')} perlu dibuat ulang` };
}

/** True when an undo id belongs to this story (`u_<story hex>_…`). */
const ownsUndo = (undoId: string | undefined, storyId: string) => !!undoId && undoId.startsWith(`u_${storyId.slice('story_'.length)}_`);

type Edit = (board: Storyboard) => { board: Storyboard; label: string };

/**
 * Apply one board edit with the turn's snapshot discipline. `edit` is pure: it runs once on the
 * current board first (bad input fails before any snapshot), then again on the board read after
 * the snapshot. `baseRev` = the revision the edit was planned on (breakdown): a different one is STALE.
 * `prepare` runs once the dry run passed (e.g. write a reference copy the edit points at);
 * `cleanup` undoes it when the edit fails or changes nothing.
 */
async function mutate(
  ctx: ActionContext, storyId: string, edit: Edit,
  opts: { baseRev?: number; prepare?: () => Promise<void>; cleanup?: () => Promise<void> } = {}
): Promise<ActionResult> {
  const dry = edit(clone(await ctx.stories.readStoryboard(storyId)));
  const errors = validateStoryboard(dry.board);
  if (errors.length) bad(errors.join('; '));
  let undoId: string | undefined;
  let fresh = false;
  let record: StoryRecord;
  let label: string;
  let rev: number;
  try {
    await opts.prepare?.();
    if (ownsUndo(ctx.turn.undoId, storyId)) {
      undoId = ctx.turn.undoId!;
      rev = ctx.turn.rev ?? (await ctx.stories.get(storyId))!.rev;
    } else {
      const taken = await ctx.snapshots.take(storyId, dry.label);
      undoId = taken.undoId;
      rev = taken.rev;
      fresh = true;
    }
    if (opts.baseRev !== undefined && opts.baseRev !== rev) throw new StoryError('STALE', STALE_MESSAGE);
    const out = edit(clone(await ctx.stories.readStoryboard(storyId)));
    label = out.label;
    record = await ctx.stories.updateStoryboard(storyId, out.board, { rev });
  } catch (error) {
    if (fresh && undoId) await ctx.snapshots.discard(undoId).catch(() => undefined);
    await opts.cleanup?.().catch(() => undefined);
    throw error;
  }
  if (record.rev === rev) {
    if (fresh) await ctx.snapshots.discard(undoId!).catch(() => undefined);
    await opts.cleanup?.().catch(() => undefined);
    return { ok: true, label: `${label} (tidak ada yang berubah)`, changed: false };
  }
  // The board is written: from here on the change stands, whatever happens to the undo record.
  try {
    await ctx.snapshots.commit(undoId!, record.rev);
  } catch (error) {
    console.warn(`[assistant] ${storyId}: undo snapshot ${undoId} not committed: ${error instanceof Error ? error.message : String(error)}`);
  }
  ctx.turn.undoId = undoId;
  ctx.turn.rev = record.rev;
  return { ok: true, label, changed: true };
}

// ------------------------------------------------------------------ schemas

const REF = { anyOf: [{ type: 'integer' }, { type: 'string' }] };
const SHOT_REF = { ...REF, description: 'Shot number as shown in the app (1..N across all scenes), e.g. 3' };
const SCENE_REF = { ...REF, description: 'Scene number as shown in the app (1..M), e.g. 2' };
const INTENT_PROPS = {
  subject: { type: 'string', description: 'Who/what is in frame: a character TOKEN (e.g. LARAS) or a concrete noun phrase' },
  action: { type: 'string', description: 'ONE verb chain in English, no "and then"' },
  startState: { type: 'string', description: 'What is visible in the first frame (English)' },
  endState: { type: 'string', description: 'What is visibly different in the last frame (English); must differ from startState' },
  emotion: { type: 'string', description: 'Mood of the beat, e.g. "waspada lalu lega"' },
  framing: { type: 'string', enum: FRAMING_IDS },
  move: { type: 'string', enum: MOVE_IDS, description: 'Exactly one camera move' },
  narration: { type: 'string', description: 'Voice-over line in Bahasa Indonesia, at most 12 words' },
  silent: { type: 'boolean', description: 'No voice-over for this shot' }
};
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });

// ------------------------------------------------------------------ project summary

const SUMMARY_LIMIT = 5800;

/**
 * Text caps per shrink level; the summary takes the first level that fits SUMMARY_LIMIT. 0 drops
 * the field (narration lines and scene goals, location looks); `lean` also drops default values
 * (status "pending") and keeps two anchors per character. Numbers, ids, keys and tokens are never cut.
 */
type Caps = { what: number; line: number; title: number; name: number; look: number; anchors: number; lean?: boolean };
const SUMMARY_LEVELS: Caps[] = [
  { what: 140, line: 80, title: 60, name: 60, look: 80, anchors: 4 },
  { what: 100, line: 60, title: 48, name: 48, look: 60, anchors: 4 },
  { what: 70, line: 44, title: 40, name: 40, look: 40, anchors: 3 },
  { what: 48, line: 32, title: 32, name: 32, look: 24, anchors: 3 },
  { what: 36, line: 24, title: 24, name: 24, look: 0, anchors: 2 },
  { what: 28, line: 0, title: 20, name: 20, look: 0, anchors: 2, lean: true },
  { what: 20, line: 0, title: 16, name: 16, look: 0, anchors: 1, lean: true }
];

async function estimateLeft(ctx: ActionContext, board: Storyboard, record: StoryRecord): Promise<Estimate & { clips: number; images: number }> {
  const reuse = new Set(board.shots.filter(s => s.reuse).map(s => s.id));
  const clips = record.shots.filter(s => !reuse.has(s.id) && s.status !== 'done').length;
  const images = record.mode === 'konsisten'
    ? (record.cast ?? []).filter(c => c.status !== 'done').length + record.shots.filter(s => s.frame && s.frame.status !== 'done').length
    : 0;
  const video = videoEngine(board);
  if (axcelVideo(board)) return { clips, images };
  if (!video) return { credits: clips * CREDITS_PER_SHOT, clips, images };
  const usd = await ctx.price?.usdPerClip(video.model).catch(() => null);
  return { ...(typeof usd === 'number' ? { usd: Math.round(clips * usd * 100) / 100 } : {}), clips, images };
}

function summary(board: Storyboard, record: StoryRecord, estimate: Estimate & { clips: number; images: number }, caps: Caps, level: number) {
  const b = normalizeScenes(board);
  const states = new Map(record.shots.map(s => [s.id, s]));
  const sceneN = new Map(b.scenes!.map((s, i) => [s.id, i + 1]));
  const cast = new Map((record.cast ?? []).map(c => [c.token, c]));
  const engineName = (e: Engine | undefined) => (e?.provider === 'openrouter' || e?.provider === 'axcel' ? `${e.provider}:${e.model}` : 'flow');
  const tokens = new Set([...(b.bible?.characters ?? []).map(c => c.token), ...Object.keys(b.characters ?? {})]);
  return {
    title: b.title,
    status: record.status,
    rev: record.rev,
    mode: record.mode ?? 'cepat',
    bible: !!b.bible,
    engine: { image: engineName(b.engine?.image), video: engineName(b.engine?.video) },
    ...(b.audioMode === 'ambient' ? { audio: 'ambient only (no voice, no music): narration is not spoken' } : {}),
    look: b.look?.family ? `${b.look.family}${b.look.variant && b.look.variant !== b.look.family ? `:${b.look.variant}` : ''}` : b.look?.style ?? 'default',
    ...(level ? { shortened: true } : {}),
    ...(b.bible?.logline ? { logline: clip(b.bible.logline, caps.line ? 200 : 100) } : {}),
    scenes: b.scenes!.map((s, i) => {
      const card = cardFor(b, s);
      const goal = card?.goal ?? s.summary;
      return {
        n: i + 1, id: s.id, title: clip(s.title, caps.title),
        ...(goal && caps.line ? { goal: clip(goal, caps.line * 2) } : {}),
        ...(s.location ?? card?.location ? { location: s.location ?? card?.location } : {})
      };
    }),
    shots: b.shots.map((s, i) => {
      const state = states.get(s.id);
      const scene = sceneOf(b, s.id);
      const what = s.intent ? [s.intent.subject, s.intent.action].filter(Boolean).join(' ') || '(intent kosong)' : s.prompt;
      const status = state?.status ?? 'pending';
      return {
        n: i + 1, id: s.id, scene: scene ? sceneN.get(scene.id) : undefined,
        what: clip(what, caps.what),
        ...(s.silent ? { silent: true } : caps.line ? { narration: clip(s.narration, caps.line) } : {}),
        ...(caps.lean && status === 'pending' ? {} : { status }),
        ...(state?.frame ? { frame: state.frame.status } : {}),
        ...(s.reuse ? { reuse: true } : {})
      };
    }),
    characters: [...tokens].map(token => {
      const card = b.bible?.characters.find(c => c.token === token);
      const spec = b.characters?.[token];
      const name = card?.name ?? (spec && typeof spec === 'object' ? spec.name : undefined) ?? token;
      return {
        token, name: clip(name, caps.name),
        ...(card ? { anchors: card.anchors.slice(0, caps.anchors).map(a => clip(a, Math.max(24, Math.min(50, caps.title)))) } : spec ? { look: clip(typeof spec === 'string' ? spec : spec.look, caps.look || 40) } : {}),
        sheet: cast.get(token)?.status ?? (record.mode === 'konsisten' ? 'tidak dipakai' : '—'),
        ...(card?.reference ? { reference: card.reference } : {})
      };
    }),
    locations: [...new Set([...(b.bible?.locations ?? []).map(l => l.key), ...Object.keys(b.locations ?? {})])].map(key => {
      const name = b.locations?.[key]?.name ?? b.bible?.locations.find(l => l.key === key)?.name ?? key;
      const look = b.locations?.[key]?.look ?? b.bible?.locations.find(l => l.key === key)?.lookdev;
      return { key, name: clip(name, caps.name), ...(caps.look ? { look: clip(look, caps.look) } : {}) };
    }),
    estimate
  };
}

// ------------------------------------------------------------------ legacy prose camera edits

/** Legacy prose: swap the leading catalog framing and/or the catalog move text; add them when absent. */
function withCamera(prompt: string, framing?: string, move?: string): string {
  let out = prompt.trim();
  if (framing) {
    const text = CATALOG.framings.find(f => f.id === framing)!.prompt;
    const current = [...CATALOG.framings].sort((a, b) => b.prompt.length - a.prompt.length).find(f => out.toLowerCase().startsWith(f.prompt.toLowerCase()));
    out = current ? `${text}${out.slice(current.prompt.length)}` : `${text}. ${out}`;
  }
  if (move) {
    const text = CATALOG.moves.find(m => m.id === move)!.prompt;
    const current = [...CATALOG.moves].sort((a, b) => b.prompt.length - a.prompt.length).find(m => out.toLowerCase().includes(m.prompt.toLowerCase()));
    if (current) {
      const at = out.toLowerCase().indexOf(current.prompt.toLowerCase());
      out = `${out.slice(0, at)}${text}${out.slice(at + current.prompt.length)}`;
    } else {
      out = `${out.replace(/[.\s]*$/, '')}. ${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
    }
  }
  return out;
}

// ------------------------------------------------------------------ shot edits

const INTENT_KEYS = ['subject', 'action', 'startState', 'endState', 'emotion'] as const;

type ShotFields = {
  intent: Partial<Record<(typeof INTENT_KEYS)[number], string>>;
  framing?: string; move?: string; narration?: string; silent?: boolean; prompt?: string;
};

function shotFields(input: ActionInput): ShotFields {
  const intent: ShotFields['intent'] = {};
  for (const key of INTENT_KEYS) {
    const value = str(input, key, { max: 300, allowEmpty: key === 'emotion' });
    if (value !== undefined) intent[key] = value;
  }
  const fields: ShotFields = { intent };
  const framing = camera(input, 'framing'); if (framing) fields.framing = framing;
  const move = camera(input, 'move'); if (move) fields.move = move;
  const narration = str(input, 'narration', { max: 200, allowEmpty: true }); if (narration !== undefined) fields.narration = narration;
  const silent = bool(input, 'silent'); if (silent !== undefined) fields.silent = silent;
  const prompt = str(input, 'prompt', { max: 2000 }); if (prompt !== undefined) fields.prompt = prompt;
  return fields;
}

const PROMPT_ON_BIBLE = 'Di proyek bible, ubah field intent (subject, action, startState, endState, emotion, framing, move), bukan teks prompt.';
const INTENT_ON_LEGACY = 'Proyek ini belum memakai bible — ubah teks prompt, narration, framing, move atau silent saja (bible dibuat di tab Bible).';

const noIntentYet = (n: number) => `Shot ${n} belum punya niat — isi subjek, aksi, keadaan awal dan akhir sekaligus.`;

/** Legacy prose edits of one shot: framing/move swap the catalog camera text, the rest of the prose stays. */
function applyProse(out: Shot, f: ShotFields): Shot {
  if (f.framing || f.move) out.prompt = withCamera(out.prompt, f.framing, f.move);
  if (f.narration !== undefined) out.narration = f.narration;
  if (f.silent !== undefined) { if (f.silent) out.silent = true; else delete out.silent; }
  return out;
}

/**
 * The edited copy of one shot. Bible boards edit the intent; a bible-board shot without an intent
 * (prose from before the bible) keeps its prose unless all four mandatory slots are given at once:
 * a half intent would replace a working prompt with one that cannot compile.
 */
function applyShot(board: Storyboard, shot: Shot, f: ShotFields, n = 0): Shot {
  const out = clone(shot);
  if (board.bible) {
    if (f.prompt !== undefined) bad(PROMPT_ON_BIBLE);
    if (!out.intent) {
      const i = f.intent;
      if (!Object.keys(i).length) return applyProse(out, f);
      if (!i.subject || !i.action || !i.startState || !i.endState) bad(noIntentYet(n));
    }
    const intent: ShotIntent = { ...(out.intent ?? { subject: '', action: '', startState: '', endState: '' }) };
    for (const key of INTENT_KEYS) {
      const value = f.intent[key];
      if (value === undefined) continue;
      if (key === 'emotion' && !value) delete intent.emotion; else intent[key] = value;
    }
    if (f.framing) intent.framing = f.framing;
    if (f.move) intent.move = f.move;
    if (f.narration !== undefined) { out.narration = f.narration; if ('narration' in intent) intent.narration = f.narration; }
    if (f.silent !== undefined) { if (f.silent) out.silent = true; else delete out.silent; if ('silent' in intent) intent.silent = f.silent; }
    out.intent = intent;
    return out;
  }
  if (Object.keys(f.intent).length) bad(INTENT_ON_LEGACY);
  if (f.prompt !== undefined) out.prompt = f.prompt;
  return applyProse(out, f);
}

const hasShotFields = (f: ShotFields) => Object.keys(f.intent).length > 0 || f.framing !== undefined || f.move !== undefined
  || f.narration !== undefined || f.silent !== undefined || f.prompt !== undefined;

// ------------------------------------------------------------------ spending

type Plan = { label: string; estimate: Estimate; payload?: Record<string, unknown> };

/** The approved revision for the service call that queues jobs (checked there under the story lock). */
const revOf = (ctx: ActionContext): { rev?: number } => (ctx.rev !== undefined ? { rev: ctx.rev } : {});

/**
 * The confirm rule for the in-app chat (the app's pending-call card is the gate). Shared by every
 * spending tool's description; the MCP server swaps it for its own rule (see mcp/server.ts).
 */
export const CHAT_CONFIRM_RULE = 'The first call only returns the cost; the app then asks the user to confirm, and only a confirmed call queues anything (you cannot confirm it yourself).';

/**
 * The snapshot `undo_last` is about to restore (its chip gets marked undone afterwards), or
 * undefined for any other action. Chat and MCP share it.
 */
export async function undoTarget(stories: StoryService, storyId: string, name: string): Promise<string | undefined> {
  if (name !== 'undo_last') return undefined;
  return (await stories.snapshots.list(storyId)).find(s => typeof s.revAfter === 'number')?.undoId;
}

/**
 * A spending action: `plan` validates and prices (no side effects: no file, no job, no write),
 * `execute` queues. Without `ctx.confirmed === true` (set by the caller, never by model input) the
 * plan is returned as `needsConfirm` and nothing is queued.
 */
function spending(def: {
  description: string; schema: object;
  plan(ctx: ActionContext, storyId: string, input: ActionInput, record: StoryRecord, board: Storyboard): Promise<Plan | ActionResult>;
  execute(ctx: ActionContext, storyId: string, input: ActionInput, plan: Plan): Promise<ActionResult>;
}): Action {
  return {
    description: def.description, schema: def.schema, spends: true,
    run: (ctx, storyId, input) => guarded(ctx, storyId, async record => {
      const board = await ctx.stories.readStoryboard(storyId);
      const plan = await def.plan(ctx, storyId, input, record, board);
      if ('ok' in plan) return plan;
      if (ctx.confirmed !== true) return { ok: false, needsConfirm: true, label: plan.label, estimate: plan.estimate };
      if (ctx.rev !== undefined && ctx.rev !== record.rev) return fail(STALE_MESSAGE, 'STALE');
      return def.execute(ctx, storyId, input, plan);
    })
  };
}

async function imageEstimate(ctx: ActionContext, board: Storyboard, images: number): Promise<{ estimate: Estimate; cost: string }> {
  const engine = imageEngine(board);
  const ax = axcelImage(board);
  if (ax) return { estimate: {}, cost: axcelCost(ax.model) };
  if (!engine) return { estimate: { credits: 0 }, cost: 'gratis di Flow' };
  const each = await ctx.price?.usdPerImage?.(engine.model).catch(() => null);
  if (typeof each !== 'number') return { estimate: {}, cost: `${images} gambar OpenRouter, harga tidak diketahui` };
  const usd = Math.round(images * each * 100) / 100;
  return { estimate: { usd }, cost: `±${usdLabel(usd)} OpenRouter` };
}

const storyPaths = (ctx: ActionContext, storyId: string) => ({
  storyDir: ctx.stories.storyDir(storyId),
  framePath: (shotId: string) => ctx.stories.framePath(storyId, shotId),
  castPath: (token: string) => ctx.stories.castPath(storyId, token)
});

/** A reference decided in a plan; `pending` = a media copy not written yet. */
type RefPlan = { rel: string; pending?: PlannedUpload };

/** Resolve a reference input without writing anything (media pointers are copied later by `keepReference`). */
async function referencePlan(ctx: ActionContext, storyId: string, board: Storyboard, input: ActionInput, key: string): Promise<RefPlan | undefined> {
  const value = input[key];
  if (value === undefined || value === null || value === '') return undefined;
  const r = await planReference(board, value, storyPaths(ctx, storyId));
  return 'error' in r ? bad(r.error) : r;
}

/** Write the planned copy (once the change is going ahead). */
const keepReference = async (ctx: ActionContext, storyId: string, plan?: RefPlan) => {
  if (plan?.pending) await writePlanned(ctx.stories.storyDir(storyId), plan.pending);
};
/** Remove a copy whose change failed (an upload the user made is never removed). */
const dropReference = async (ctx: ActionContext, storyId: string, plan?: RefPlan) => {
  if (plan?.pending) await removeUpload(ctx.stories.storyDir(storyId), plan.pending.file);
};
const referenceHooks = (ctx: ActionContext, storyId: string, plan?: RefPlan) => (plan?.pending
  ? { prepare: () => keepReference(ctx, storyId, plan), cleanup: () => dropReference(ctx, storyId, plan) }
  : {});

// ------------------------------------------------------------------ the actions

const SHOT_DESCRIPTION_RULE = 'Address shots by their number as shown in the app (shot 1..N across all scenes).';

export const ACTIONS: Record<ActionName, Action> = {
  get_project: {
    description: 'Read a compact summary of this project: title, status, revision, engine, look, scenes (numbered), shots (numbered 1..N across scenes, with intent or prompt, narration, render and keyframe status), characters (tokens, anchors, sheet status, reference), locations and the estimated cost of what is left. Call this first.',
    schema: obj({}),
    spends: false,
    run: (ctx, storyId) => guarded(ctx, storyId, async record => {
      const board = await ctx.stories.readStoryboard(storyId);
      const estimate = await estimateLeft(ctx, board, record);
      let level = 0;
      let data = summary(board, record, estimate, SUMMARY_LEVELS[0]!, 0);
      while (JSON.stringify(data).length > SUMMARY_LIMIT && level < SUMMARY_LEVELS.length - 1) {
        level += 1;
        data = summary(board, record, estimate, SUMMARY_LEVELS[level]!, level);
      }
      return { ok: true, label: `Proyek "${clip(board.title, 60)}" dibaca`, data };
    })
  },

  edit_shot: {
    description: `Edit one shot. ${SHOT_DESCRIPTION_RULE} On bible projects edit the intent fields (subject, action, startState, endState, emotion, framing, move) plus narration/silent — never write prompt text, the app compiles the prompt. On projects without a bible, "prompt" (English prose) may be rewritten for that shot only. Only that shot is re-rendered later; unchanged prompts keep their paid clips.`,
    schema: obj({ shot: SHOT_REF, ...INTENT_PROPS, prompt: { type: 'string', description: 'Legacy (no-bible) projects only: the English prose prompt of this shot' } }, ['shot']),
    spends: false,
    run: (ctx, storyId, input) => guarded(ctx, storyId, async () => {
      const target = ref(input, 'shot', true)!;
      const fields = shotFields(input);
      if (!hasShotFields(fields)) bad('Tidak ada yang diubah — sebut field yang mau diubah (mis. action, emotion, narration).');
      let note = '';
      const result = await mutate(ctx, storyId, board => {
        const { id, n } = shotOf(board, target);
        const i = board.shots.findIndex(s => s.id === id);
        const before = board.shots[i]!;
        if (before.reuse) bad(`Shot ${n} memakai ulang klip lama — tidak bisa diubah.`);
        const shot = applyShot(board, before, fields, n);
        board.shots[i] = shot;
        note = '';
        // An intent-less prose shot stays prose (prompt untouched); only intent shots are compiled.
        if (board.bible && shot.intent) {
          // A prose shot that gets its first intent must compile, like a new shot (add_shot).
          const was = !before.intent || compileIssues(board, before).length === 0;
          const issues = compileIssues(board, shot);
          if (issues.length && was) bad(`Shot ${n} tidak bisa dikompilasi setelah perubahan ini: ${issues.join('; ')}`);
          if (issues.length) note = ` — belum bisa dirender: ${clip(issues.join('; '), 200)}`;
          board.shots[i] = { ...shot, prompt: promptFromIntent(board, shot) };
        }
        return { board, label: `Shot ${n} diubah` };
      });
      return result.ok && note ? { ...result, label: `${result.label}${note}` } : result;
    })
  },

  add_shot: {
    description: `Add one shot to a scene, after a given shot (or at the end of the scene). ${SHOT_DESCRIPTION_RULE} On bible projects give the intent (subject, action, startState, endState, emotion, framing, move) and narration; never prompt text. On projects without a bible give "prompt" (English prose) and narration. startFrame: an uploaded image id used as the first frame (OpenRouter and Axcel video engines only).`,
    schema: obj({
      scene: SCENE_REF, after: { ...SHOT_REF, description: 'Insert after this shot number (0 = first in the scene)' }, ...INTENT_PROPS,
      prompt: { type: 'string', description: 'Legacy (no-bible) projects only' }, startFrame: { type: 'string', description: 'Uploaded image id (up_…) or a media pointer like "keyframe shot 2"' }
    }),
    spends: false,
    run: (ctx, storyId, input) => guarded(ctx, storyId, async () => {
      const sceneTarget = ref(input, 'scene');
      const afterTarget = ref(input, 'after');
      if (sceneTarget === undefined && afterTarget === undefined) bad('Sebut scene (nomor) atau after (nomor shot).');
      const fields = shotFields(input);
      const pre = await ctx.stories.readStoryboard(storyId);
      const start = await referencePlan(ctx, storyId, pre, input, 'startFrame');
      // Flow cannot use a start frame: nothing is stored, and no copy is made for it.
      const keep = start && videoTakesFiles(pre) ? start : undefined;
      const startNote = start && !keep ? ' Start frame tidak disimpan: hanya mesin video OpenRouter/Axcel yang memakainya.' : '';
      let label = '';
      const result = await mutate(ctx, storyId, board => {
        const b = normalizeScenes(board);
        let scene: Scene;
        let at: number;
        if (afterTarget !== undefined && afterTarget !== 0 && afterTarget !== '0') {
          const after = shotOf(b, afterTarget);
          const home = sceneOf(b, after.id)!;
          if (sceneTarget !== undefined && sceneRef(b, sceneTarget).id !== home.id) bad(`Shot ${after.n} tidak ada di scene ${sceneRef(b, sceneTarget).n}.`);
          scene = b.scenes!.find(s => s.id === home.id)!;
          at = scene.shots.indexOf(after.id) + 1;
        } else {
          if (sceneTarget === undefined) bad('Sebut scene (nomor) untuk shot pertama.');
          scene = b.scenes!.find(s => s.id === sceneRef(b, sceneTarget!).id)!;
          at = afterTarget === undefined ? scene.shots.length : 0;
        }
        const id = uniqueId(b.shots.map(s => s.id), `shot-${b.shots.length + 1}`);
        let shot: Shot;
        if (b.bible) {
          if (fields.prompt !== undefined) bad(PROMPT_ON_BIBLE);
          const i = fields.intent;
          if (!i.subject || !i.action || !i.startState || !i.endState) bad('Shot baru di proyek bible butuh subject, action, startState dan endState.');
          shot = applyShot(b, { id, prompt: '', intent: { subject: '', action: '', startState: '', endState: '' } }, fields);
        } else {
          if (!fields.prompt) bad('Shot baru butuh prompt (teks Inggris) di proyek tanpa bible.');
          shot = applyShot(b, { id, prompt: fields.prompt! }, { ...fields, prompt: undefined });
        }
        if (keep) shot.startFrame = keep.rel;
        b.shots.push(shot);
        scene.shots.splice(at, 0, id);
        const placed = normalizeScenes(b);
        if (placed.bible) {
          const issues = compileIssues(placed, shot);
          if (issues.length) bad(`Shot baru tidak bisa dikompilasi: ${issues.join('; ')}`);
          placed.shots = placed.shots.map(s => (s.id === id ? { ...s, prompt: promptFromIntent(placed, s) } : s));
        }
        label = `Shot ${shotNumber(placed, id)} ditambahkan di scene ${sceneNumber(placed, scene.id)}`;
        return { board: placed, label };
      }, referenceHooks(ctx, storyId, keep));
      return result.ok && startNote ? { ...result, label: `${result.label}.${startNote}` } : result;
    })
  },

  remove_shot: {
    description: `Remove one shot. ${SHOT_DESCRIPTION_RULE} The project keeps at least one shot. Undo restores it (with its paid clip).`,
    schema: obj({ shot: SHOT_REF }, ['shot']),
    spends: false,
    run: (ctx, storyId, input) => guarded(ctx, storyId, async () => {
      const target = ref(input, 'shot', true)!;
      return mutate(ctx, storyId, board => {
        const { id, n } = shotOf(board, target);
        if (board.shots.length <= 1) bad('Proyek harus punya minimal satu shot.');
        const b = normalizeScenes(board);
        b.shots = b.shots.filter(s => s.id !== id);
        for (const s of b.scenes!) s.shots = s.shots.filter(x => x !== id);
        return { board: normalizeScenes(b), label: `Shot ${n} dihapus` };
      });
    })
  },

  move_shot: {
    description: `Move one shot to another place: into a scene (at its end) and/or right after another shot (after = 0 puts it first in the scene). ${SHOT_DESCRIPTION_RULE}`,
    schema: obj({ shot: SHOT_REF, scene: SCENE_REF, after: { ...SHOT_REF, description: 'Place right after this shot number (0 = first in the scene)' } }, ['shot']),
    spends: false,
    run: (ctx, storyId, input) => guarded(ctx, storyId, async () => {
      const target = ref(input, 'shot', true)!;
      const sceneTarget = ref(input, 'scene');
      const afterTarget = ref(input, 'after');
      if (sceneTarget === undefined && afterTarget === undefined) bad('Sebut scene tujuan atau after (nomor shot).');
      return mutate(ctx, storyId, board => {
        const b = normalizeScenes(board);
        const moving = shotOf(b, target);
        let scene: Scene;
        let afterId: string | undefined;
        if (afterTarget !== undefined && afterTarget !== 0 && afterTarget !== '0') {
          const after = shotOf(b, afterTarget);
          if (after.id === moving.id) bad('Shot tidak bisa dipindah ke setelah dirinya sendiri.');
          const home = sceneOf(b, after.id)!;
          if (sceneTarget !== undefined && sceneRef(b, sceneTarget).id !== home.id) bad(`Shot ${after.n} tidak ada di scene ${sceneRef(b, sceneTarget).n}.`);
          scene = b.scenes!.find(s => s.id === home.id)!;
          afterId = after.id;
        } else {
          if (sceneTarget === undefined) bad('Sebut scene tujuan.');
          scene = b.scenes!.find(s => s.id === sceneRef(b, sceneTarget!).id)!;
        }
        for (const s of b.scenes!) s.shots = s.shots.filter(x => x !== moving.id);
        const at = afterId ? scene.shots.indexOf(afterId) + 1 : afterTarget !== undefined ? 0 : scene.shots.length;
        scene.shots.splice(at, 0, moving.id);
        const placed = normalizeScenes(b);
        return { board: placed, label: `Shot ${moving.n} dipindah ke scene ${sceneNumber(placed, scene.id)} (sekarang shot ${shotNumber(placed, moving.id)})` };
      });
    })
  },

  breakdown_scene: {
    description: 'Break one scene of a bible project into 2-8 new shots with the AI shot planner, grounded in the bible (scene goal, location, character tokens, rules). Shots are compiled and linted before they are inserted. mode "replace" swaps out the scene\'s shots (default when the scene only holds empty placeholders), "append" adds after them. Address the scene by its number.',
    schema: obj({
      scene: SCENE_REF, count: { type: 'integer', minimum: MIN_BREAKDOWN, maximum: MAX_BREAKDOWN, description: 'How many shots (2-8)' },
      brief: { type: 'string', description: 'Optional direction for this scene' }, mode: { type: 'string', enum: ['replace', 'append'] }
    }, ['scene']),
    spends: false,
    run: (ctx, storyId, input) => guarded(ctx, storyId, async record => {
      const board = await ctx.stories.readStoryboard(storyId);
      if (!board.bible) return fail(LEGACY_BREAKDOWN_MESSAGE);
      const scene = sceneRef(board, ref(input, 'scene', true)!);
      const count = input.count === undefined ? 3 : input.count;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < MIN_BREAKDOWN || count > MAX_BREAKDOWN) bad(`count harus ${MIN_BREAKDOWN}–${MAX_BREAKDOWN}.`);
      const mode = input.mode === undefined ? defaultMode(board, scene.id) : input.mode === 'replace' || input.mode === 'append' ? input.mode as BreakdownMode : bad('mode harus replace atau append');
      const brief = str(input, 'brief', { max: 500 });
      const b = normalizeScenes(board);
      const flat = b.scenes!.find(s => s.id === scene.id)!;
      // Replace drops every shot of the scene: never over a take the user already has (paid clip or keyframe).
      if (mode === 'replace' && flat.shots.some(id => hasDoneTake(record.shots.find(s => s.id === id)))) return fail(REPLACE_REFUSED_MESSAGE);
      if (!cardFor(b, flat)?.goal?.trim()) bad(`Scene ${scene.n} belum punya tujuan di bible — isi dulu (edit_scene goal).`);
      const keep = mode === 'replace' ? b.shots.length - flat.shots.length : b.shots.length;
      if (keep + (count as number) > 30) bad(`Proyek maksimal 30 shot — sekarang ${b.shots.length}.`);
      if (!ctx.model || !(await ctx.model.configured())) return fail(NO_MODEL_MESSAGE, 'NOT_CONFIGURED');
      if (BUSY_STATUSES.includes(record.status)) return fail(BUSY_MESSAGE, 'BUSY');
      const shots = await breakdownScene(ctx.model, b, scene.id, count as number, brief, { mode, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      // The turn ended while the model wrote: nothing is inserted after the caller gave up.
      if (ctx.signal?.aborted) return fail('Dibatalkan — batas waktu asisten habis.', 'UNAVAILABLE');
      const ids = new Set(shots.map(s => s.id));
      return mutate(ctx, storyId, current => {
        if (current.shots.some(s => ids.has(s.id))) throw new StoryError('STALE', STALE_MESSAGE);
        return {
          board: withSceneShots(current, scene.id, shots, mode),
          label: `Scene ${scene.n} dipecah jadi ${shots.length} shot${mode === 'replace' && flat.shots.length ? ` (menggantikan ${flat.shots.length} shot kosong/lama)` : ''}`
        };
      }, { baseRev: record.rev });
    })
  },

  edit_scene: {
    description: 'Edit one scene: title, goal (what changes in this scene; lives on the bible card) and location (a location KEY or name, "" clears it). Address the scene by its number.',
    schema: obj({ scene: SCENE_REF, title: { type: 'string' }, goal: { type: 'string' }, location: { type: 'string' } }, ['scene']),
    spends: false,
    run: (ctx, storyId, input) => guarded(ctx, storyId, async () => {
      const target = ref(input, 'scene', true)!;
      const title = str(input, 'title', { max: 80 });
      const goal = str(input, 'goal', { max: 300 });
      const location = str(input, 'location', { max: 60, allowEmpty: true });
      if (title === undefined && goal === undefined && location === undefined) bad('Tidak ada yang diubah — sebut title, goal atau location.');
      return mutate(ctx, storyId, board => {
        const b = normalizeScenes(board);
        const { id, n } = sceneRef(b, target);
        const scene = b.scenes!.find(s => s.id === id)!;
        const key = location ? (() => { const l = resolveLocation(b, location); return 'error' in l ? bad(l.error) : l.key; })() : location;
        const card = cardFor(b, scene);
        if (title !== undefined) scene.title = title;
        if (key !== undefined) { if (key) scene.location = key; else delete scene.location; }
        if (b.bible) {
          if (card) {
            if (title !== undefined) card.title = title;
            if (goal !== undefined) card.goal = goal;
            if (key !== undefined) { if (key) card.location = key; else delete card.location; }
          } else if (goal !== undefined) {
            b.bible.scenes.push({ id: scene.id, title: scene.title, goal, ...(scene.location ? { location: scene.location } : {}) });
          }
        } else if (goal !== undefined) {
          scene.summary = goal;
        }
        return { board: b, label: `Scene ${n} diubah` };
      });
    })
  },

  add_scene: {
    description: 'Add an empty scene (after a given scene, or at the end). On bible projects a goal (what changes in this scene) is required; location is a location KEY or name. Then fill it with breakdown_scene or add_shot.',
    schema: obj({ title: { type: 'string' }, goal: { type: 'string' }, location: { type: 'string' }, after: { ...SCENE_REF, description: 'Insert after this scene number' } }, ['title']),
    spends: false,
    run: (ctx, storyId, input) => guarded(ctx, storyId, async () => {
      const title = str(input, 'title', { max: 80, required: true })!;
      const goal = str(input, 'goal', { max: 300 });
      const location = str(input, 'location', { max: 60 });
      const afterTarget = ref(input, 'after');
      return mutate(ctx, storyId, board => {
        const b = normalizeScenes(board);
        if (b.scenes!.length >= MAX_SCENES) bad(`Proyek maksimal ${MAX_SCENES} scene.`);
        if (b.bible && !goal) bad('Scene baru di proyek bible butuh goal (tujuan: apa yang berubah di scene ini).');
        const key = location ? (() => { const l = resolveLocation(b, location); return 'error' in l ? bad(l.error) : l.key; })() : undefined;
        const id = uniqueId(b.scenes!.map(s => s.id), `scene-${b.scenes!.length + 1}`);
        const scene: Scene = { id, title, shots: [], ...(key ? { location: key } : {}), ...(!b.bible && goal ? { summary: goal } : {}) };
        const at = afterTarget !== undefined ? b.scenes!.findIndex(s => s.id === sceneRef(b, afterTarget).id) + 1 : b.scenes!.length;
        b.scenes!.splice(at, 0, scene);
        if (b.bible) b.bible.scenes.push({ id, title, goal: goal!, ...(key ? { location: key } : {}) });
        return { board: b, label: `Scene ${at + 1} "${clip(title, 40)}" ditambahkan (masih kosong)` };
      });
    })
  },

  remove_scene: {
    description: 'Remove one scene. Its shots are kept and join the previous scene (the next one for the first scene). The project keeps at least one scene. Address the scene by its number.',
    schema: obj({ scene: SCENE_REF }, ['scene']),
    spends: false,
    run: (ctx, storyId, input) => guarded(ctx, storyId, async () => {
      const target = ref(input, 'scene', true)!;
      return mutate(ctx, storyId, board => {
        const b = normalizeScenes(board);
        const { id, n } = sceneRef(b, target);
        if (b.scenes!.length <= 1) bad('Proyek harus punya minimal satu scene.');
        const i = b.scenes!.findIndex(s => s.id === id);
        const [gone] = b.scenes!.splice(i, 1);
        const heir = i > 0 ? b.scenes![i - 1]! : b.scenes![0]!;
        heir.shots = i > 0 ? [...heir.shots, ...gone!.shots] : [...gone!.shots, ...heir.shots];
        if (b.bible) {
          const card = cardFor({ ...b, scenes: [gone!] }, gone!);
          if (card) b.bible.scenes = b.bible.scenes.filter(c => c !== card);
        }
        return { board: normalizeScenes(b), label: `Scene ${n} dihapus${gone!.shots.length ? ` (${gone!.shots.length} shot pindah ke scene sebelahnya)` : ''}` };
      });
    })
  },

  edit_character: {
    description: 'Edit one character by TOKEN or name. Bible projects: name, anchors (visible facts: shape, one signature detail, one material — never adjectives), want, need, arc, and reference (an uploaded image id like up_… or "sheet NAME" / "keyframe shot N"). Changing anchors remakes that character\'s sheet and keyframes later. Projects without a bible: name and look only.',
    schema: obj({
      token: { type: 'string', description: 'Character TOKEN (e.g. LARAS) or name' }, name: { type: 'string' },
      anchors: { type: 'array', items: { type: 'string' } }, want: { type: 'string' }, need: { type: 'string' }, arc: { type: 'string' },
      look: { type: 'string', description: 'Legacy (no-bible) projects only: English visual description' },
      reference: { type: ['string', 'null'], description: 'Uploaded image id (up_…) or media pointer ("sheet LARAS", "keyframe shot 2"); null removes the reference' }
    }, ['token']),
    spends: false,
    run: (ctx, storyId, input) => guarded(ctx, storyId, async () => {
      const who = str(input, 'token', { required: true, max: 60 })!;
      const name = str(input, 'name', { max: 60 });
      const anchors = strings(input, 'anchors', { max: 8, each: 120 });
      const want = str(input, 'want', { max: 300 });
      const need = str(input, 'need', { max: 300 });
      const arc = str(input, 'arc', { max: 300, allowEmpty: true });
      const look = str(input, 'look', { max: 600 });
      const pre = await ctx.stories.readStoryboard(storyId);
      const before = await ctx.stories.get(storyId);
      if (!pre.bible && (anchors || want || need || arc !== undefined || input.reference !== undefined)) bad('Proyek tanpa bible: ubah name atau look saja (anchors dan referensi butuh bible).');
      if (pre.bible && look !== undefined) bad('Di proyek bible tampilan karakter diatur lewat anchors, bukan look.');
      // reference: null clears the card's reference; a value is planned here and copied only once the edit is valid.
      const clearReference = input.reference === null;
      const reference = clearReference ? undefined : await referencePlan(ctx, storyId, pre, input, 'reference');
      if ([name, anchors, want, need, arc, look, reference].every(v => v === undefined) && !clearReference) bad('Tidak ada yang diubah — sebut name, anchors, want, need, arc atau reference.');
      const result = await mutate(ctx, storyId, board => {
        const hit = resolveCharacter(board, who);
        if ('error' in hit) bad(hit.error);
        const { token } = hit as { token: string };
        if (board.bible) {
          const card = board.bible.characters.find(c => c.token === token) ?? bad(`Karakter ${token} belum punya kartu di bible — tambah dengan add_character.`);
          if (name !== undefined) card.name = name;
          if (anchors) card.anchors = anchors;
          if (want !== undefined) card.want = want;
          if (need !== undefined) card.need = need;
          if (arc !== undefined) card.arc = arc;
          if (reference) card.reference = reference.rel;
          if (clearReference) delete card.reference;
          return { board, label: `Karakter ${card.name} diubah` };
        }
        const spec = board.characters?.[token];
        const current = typeof spec === 'string' ? { name: (hit as { name: string }).name, look: spec } : spec ?? { name: (hit as { name: string }).name, look: '' };
        board.characters = { ...(board.characters ?? {}), [token]: { name: name ?? current.name, look: look ?? current.look } };
        return { board, label: `Karakter ${name ?? current.name} diubah` };
      }, referenceHooks(ctx, storyId, reference));
      if (!result.ok) return result;
      const told = withRedoNote(result, before, await ctx.stories.get(storyId), pre);
      if (!reference) return told;
      const note = imageTakesFiles(pre) ? 'Referensi disimpan; dipakai saat sheet dibuat (make_sheet).' : FLOW_REFERENCE_NOTE;
      return { ...told, label: `${told.label}. ${note}` };
    })
  },

  add_character: {
    description: 'Add a character. Bible projects: token (UPPERCASE, e.g. IBU_SARI), name, anchors (visible facts, never adjectives), want, need, arc. Projects without a bible: token, name, look (English description).',
    schema: obj({
      token: { type: 'string' }, name: { type: 'string' }, anchors: { type: 'array', items: { type: 'string' } },
      want: { type: 'string' }, need: { type: 'string' }, arc: { type: 'string' }, look: { type: 'string' }
    }, ['token', 'name']),
    spends: false,
    run: (ctx, storyId, input) => guarded(ctx, storyId, async () => {
      const token = str(input, 'token', { required: true, max: 21 })!.toUpperCase();
      if (!TOKEN.test(token)) bad('token harus HURUF BESAR, angka atau garis bawah, 2–21 karakter (mis. IBU_SARI).');
      const name = str(input, 'name', { required: true, max: 60 })!;
      const anchors = strings(input, 'anchors', { max: 8, each: 120 });
      const want = str(input, 'want', { max: 300 });
      const need = str(input, 'need', { max: 300 });
      const arc = str(input, 'arc', { max: 300 }) ?? '';
      const look = str(input, 'look', { max: 600 });
      return mutate(ctx, storyId, board => {
        if (board.characters?.[token] !== undefined || board.bible?.characters.some(c => c.token === token)) bad(`Karakter ${token} sudah ada — pakai edit_character.`);
        if (board.bible) {
          if (!anchors || !want || !need) bad('Karakter baru di proyek bible butuh anchors, want dan need.');
          const card: CharacterCard = { token, name, anchors: anchors!, want: want!, need: need!, arc };
          board.bible.characters.push(card);
        } else {
          if (!look) bad('Karakter baru butuh look (deskripsi visual dalam bahasa Inggris).');
          board.characters = { ...(board.characters ?? {}), [token]: { name, look: look! } };
        }
        return { board, label: `Karakter ${name} (${token}) ditambahkan` };
      });
    })
  },

  edit_location: {
    description: 'Edit one location by KEY or name: name and lookdev (English visual description of the place). On bible projects both copies are updated.',
    schema: obj({ location: { type: 'string', description: 'Location KEY (e.g. PASAR_IKAN) or name' }, name: { type: 'string' }, lookdev: { type: 'string' } }, ['location']),
    spends: false,
    run: (ctx, storyId, input) => guarded(ctx, storyId, async () => {
      const which = str(input, 'location', { required: true, max: 60 })!;
      const name = str(input, 'name', { max: 60 });
      const lookdev = str(input, 'lookdev', { max: 400 }) ?? str(input, 'look', { max: 400 });
      if (name === undefined && lookdev === undefined) bad('Tidak ada yang diubah — sebut name atau lookdev.');
      return mutate(ctx, storyId, board => {
        const found = resolveLocation(board, which);
        const key = 'error' in found ? bad(found.error) : found.key;
        const loc = board.locations?.[key];
        const nextName = name ?? loc?.name ?? board.bible?.locations.find(l => l.key === key)?.name ?? key;
        const nextLook = lookdev ?? loc?.look ?? board.bible?.locations.find(l => l.key === key)?.lookdev ?? nextName;
        board.locations = { ...(board.locations ?? {}), [key]: { name: nextName, look: nextLook } };
        if (board.bible) {
          const card = board.bible.locations.find(l => l.key === key);
          if (card) { card.name = nextName; card.lookdev = nextLook; } else board.bible.locations.push({ key, name: nextName, lookdev: nextLook });
        }
        return { board, label: `Lokasi ${nextName} diubah` };
      });
    })
  },

  add_location: {
    description: 'Add a location: key (UPPERCASE, e.g. GANG_SEMPIT), name and lookdev (English visual description: surfaces, light, one detail).',
    schema: obj({ key: { type: 'string' }, name: { type: 'string' }, lookdev: { type: 'string' } }, ['key', 'name', 'lookdev']),
    spends: false,
    run: (ctx, storyId, input) => guarded(ctx, storyId, async () => {
      const key = str(input, 'key', { required: true, max: 31 })!.toUpperCase();
      if (!LOCATION_KEY.test(key)) bad('key harus HURUF BESAR, angka atau garis bawah (mis. GANG_SEMPIT).');
      const name = str(input, 'name', { required: true, max: 60 })!;
      const lookdev = str(input, 'lookdev', { required: true, max: 400 })!;
      return mutate(ctx, storyId, board => {
        if (board.locations?.[key] || board.bible?.locations.some(l => l.key === key)) bad(`Lokasi ${key} sudah ada — pakai edit_location.`);
        board.locations = { ...(board.locations ?? {}), [key]: { name, look: lookdev } };
        if (board.bible) board.bible.locations.push({ key, name, lookdev });
        return { board, label: `Lokasi ${name} (${key}) ditambahkan` };
      });
    })
  },

  set_look: {
    description: `Change the visual look of the whole project: family (one of ${LOOK_IDS.join(', ')}) and optional variant, or studio picks (style, genre, era, camera, lens, aperture, palette, lighting, tempo ids). Every sheet, keyframe and clip whose prompt changes must be made again, so only do this when the user asked for it.`,
    schema: obj({
      family: { type: 'string', enum: LOOK_IDS }, variant: { type: 'string' },
      ...Object.fromEntries(LOOK_PICKS.map(([key, list]) => [key, { type: 'string', enum: list.map(o => o.id) }]))
    }),
    spends: false,
    run: (ctx, storyId, input) => guarded(ctx, storyId, async () => {
      const picks: Record<string, string> = {};
      for (const key of ['family', 'variant', 'style', 'genre', 'era', 'camera', 'lens', 'aperture', 'palette', 'lighting', 'tempo']) {
        const value = str(input, key, { max: 60 });
        if (value !== undefined) picks[key] = value;
      }
      if (!Object.keys(picks).length) bad('Sebut family (mis. film-real) atau pilihan look lain.');
      // Catalog ids only: an unknown pick would silently fall back to a default and re-render every take.
      for (const [key, list] of LOOK_PICKS) {
        const value = picks[key];
        if (value !== undefined && !list.some(o => o.id === value)) bad(`${key} "${value}" tidak ada di katalog. Pilihan: ${list.map(o => o.id).join(', ')}.`);
      }
      if (picks.family && !lookById(picks.variant && picks.variant !== picks.family ? `${picks.family}:${picks.variant}` : picks.family)) {
        bad(`Look "${picks.family}${picks.variant ? `:${picks.variant}` : ''}" tidak ada. Family yang ada: ${LOOK_IDS.join(', ')}.`);
      }
      const result = await mutate(ctx, storyId, board => {
        const look = resolveLook({ template: board.template, look: { ...(board.look ?? {}), ...picks } });
        return { board: { ...board, look, style: composeStyle(look) }, label: 'Look proyek diubah' };
      });
      return result.ok && result.changed ? { ...result, label: `${result.label} — sheet, keyframe dan klip yang promptnya berubah perlu dibuat ulang.` } : result;
    })
  },

  make_sheet: spending({
    description: `Make (or remake) the character sheet of ONE character (konsisten projects): one image job for that character only. Uses the reference stored on the character with OpenRouter and Axcel image engines. Free on Flow, but it queues a job. ${CHAT_CONFIRM_RULE}`,
    schema: obj({ token: { type: 'string', description: 'Character TOKEN or name' }, reference: { type: 'string', description: 'Optional one-off reference: upload id (up_…) or media pointer' } }, ['token']),
    plan: async (ctx, storyId, input, record, board) => {
      if (record.mode !== 'konsisten') return fail('Lembar karakter hanya untuk mode konsisten.');
      const hit = resolveCharacter(board, str(input, 'token', { required: true, max: 60 }));
      if ('error' in hit) return fail(hit.error);
      const cast = (record.cast ?? []).find(c => c.token === hit.token);
      if (!cast) return fail(`Karakter ${hit.name} belum muncul di shot mana pun — belum ada sheet untuk dibuat.`);
      // Planned only: a media pointer is copied in execute, after the user confirmed.
      const reference = await referencePlan(ctx, storyId, board, input, 'reference');
      const { estimate, cost } = await imageEstimate(ctx, board, 1);
      const verb = cast.status === 'done' ? 'Buat ulang' : 'Buat';
      const refNote = reference && !imageTakesFiles(board) ? ` ${FLOW_REFERENCE_NOTE}` : '';
      return { label: `${verb} sheet ${hit.name} (1 gambar, ${cost})${refNote}`, estimate, payload: { token: hit.token, name: hit.name, reference: reference && imageTakesFiles(board) ? reference : undefined } };
    },
    execute: async (ctx, storyId, _input, plan) => {
      const { token, name, reference } = plan.payload as { token: string; name: string; reference?: RefPlan };
      await keepReference(ctx, storyId, reference);
      try {
        const record = await ctx.stories.makeSheet(storyId, token, { ...(reference ? { reference: reference.rel } : {}), ...revOf(ctx) });
        return { ok: true, label: `Sheet ${name} sedang dibuat`, data: { status: record.status } };
      } catch (error) {
        await dropReference(ctx, storyId, reference).catch(() => undefined);
        throw error;
      }
    }
  }),

  redraw_frame: spending({
    description: `Draw the keyframe of ONE shot again (konsisten projects). ${SHOT_DESCRIPTION_RULE} note: a short one-off English instruction for this take (no camera gear, no TOKENs); reference: an uploaded image id or media pointer, sent with OpenRouter and Axcel image engines. Free on Flow, but it queues a job. ${CHAT_CONFIRM_RULE}`,
    schema: obj({ shot: SHOT_REF, note: { type: 'string' }, reference: { type: 'string' } }, ['shot']),
    plan: async (ctx, storyId, input, record, board) => {
      if (record.mode !== 'konsisten') return fail('Keyframe hanya untuk mode konsisten.');
      const { id, n } = shotOf(board, ref(input, 'shot', true)!);
      if (!record.shots.find(s => s.id === id)?.frame) return fail(`Shot ${n} tidak punya keyframe.`);
      const note = str(input, 'note', { max: 300 });
      if (note) {
        const tokens = [...new Set([...(board.bible?.characters ?? []).map(c => c.token), ...Object.keys(board.characters ?? {})])];
        const issues = lintPrompt(note, { tokens, maxWords: 12 });
        if (issues.length) return fail(`Catatan ditolak: ${issues.join('; ')}`);
      }
      const notReady = shotCast(board, board.shots.find(s => s.id === id)!).filter(c => (record.cast ?? []).find(x => x.token === c.token)?.status !== 'done');
      if (notReady.length) return fail(`Sheet ${notReady.map(c => c.name).join(', ')} belum siap — buat sheet dulu.`);
      // Planned only: a media pointer is copied in execute, after the user confirmed.
      const reference = await referencePlan(ctx, storyId, board, input, 'reference');
      const { estimate, cost } = await imageEstimate(ctx, board, 1);
      const refNote = reference && !imageTakesFiles(board) ? ` ${FLOW_REFERENCE_NOTE}` : '';
      return { label: `Gambar ulang keyframe shot ${n} (1 gambar, ${cost})${refNote}`, estimate, payload: { id, n, note, reference: reference && imageTakesFiles(board) ? reference : undefined } };
    },
    execute: async (ctx, storyId, _input, plan) => {
      const { id, n, note, reference } = plan.payload as { id: string; n: number; note?: string; reference?: RefPlan };
      await keepReference(ctx, storyId, reference);
      try {
        await ctx.stories.redrawFrame(storyId, id, undefined, { ...(note ? { note } : {}), ...(reference ? { reference: reference.rel } : {}), ...revOf(ctx) });
      } catch (error) {
        await dropReference(ctx, storyId, reference).catch(() => undefined);
        throw error;
      }
      return { ok: true, label: `Keyframe shot ${n} sedang digambar ulang` };
    }
  }),

  prepare: spending({
    description: `Make the character sheets and keyframes that are still missing (konsisten projects), for one scene or the whole project. Free on Flow, paid on OpenRouter image engines, part of the plan on Axcel; it queues jobs. ${CHAT_CONFIRM_RULE}`,
    schema: obj({ scene: SCENE_REF }),
    plan: async (ctx, _storyId, input, record, board) => {
      if (record.mode !== 'konsisten') return fail('Keyframe hanya untuk mode konsisten.');
      const target = ref(input, 'scene');
      const scene = target === undefined ? undefined : sceneRef(board, target);
      const b = normalizeScenes(board);
      const run = new Set(scene ? b.scenes!.find(s => s.id === scene.id)!.shots : b.shots.map(s => s.id));
      const tokens = new Set(b.shots.filter(s => run.has(s.id) && !s.reuse).flatMap(s => shotCast(b, s).map(c => c.token)));
      const sheets = (record.cast ?? []).filter(c => tokens.has(c.token) && (c.status === 'pending' || c.status === 'failed')).length;
      const frames = record.shots.filter(s => run.has(s.id) && s.frame && (s.frame.status === 'pending' || s.frame.status === 'failed')).length;
      if (!sheets && !frames) return { ok: true, label: 'Semua sheet dan keyframe sudah siap — tidak ada yang dibuat.', changed: false };
      const { estimate, cost } = await imageEstimate(ctx, board, sheets + frames);
      return { label: `Buat ${sheets} sheet + ${frames} keyframe${scene ? ` untuk scene ${scene.n}` : ''} (${cost})`, estimate, payload: { scene: scene?.id, n: scene?.n } };
    },
    execute: async (ctx, storyId, _input, plan) => {
      const { scene, n } = plan.payload as { scene?: string; n?: number };
      await ctx.stories.prepare(storyId, { ...(scene ? { scene } : {}), ...revOf(ctx) });
      return { ok: true, label: `Sheet dan keyframe${n ? ` scene ${n}` : ''} sedang dibuat` };
    }
  }),

  render: spending({
    description: `Render video clips of one shot, one scene or every shot not done yet. ${SHOT_DESCRIPTION_RULE} Spends Flow credits (10 per clip) or OpenRouter money. ${CHAT_CONFIRM_RULE}`,
    schema: obj({ shot: SHOT_REF, scene: SCENE_REF }),
    plan: async (ctx, _storyId, input, record, board) => {
      const shotTarget = ref(input, 'shot');
      const sceneTarget = ref(input, 'scene');
      const b = normalizeScenes(board);
      const shot = shotTarget === undefined ? undefined : shotOf(b, shotTarget);
      const scene = shot || sceneTarget === undefined ? undefined : sceneRef(b, sceneTarget);
      const ids = new Set(shot ? [shot.id] : scene ? b.scenes!.find(s => s.id === scene.id)!.shots : b.shots.map(s => s.id));
      const reuse = new Set(b.shots.filter(s => s.reuse).map(s => s.id));
      // Only the clips that will actually be rendered: done and reused shots are not touched.
      const run = record.shots.filter(s => ids.has(s.id) && !reuse.has(s.id) && (s.status === 'pending' || s.status === 'failed'));
      if (record.mode === 'konsisten') {
        const missing = run.filter(s => s.frame && s.frame.status !== 'done').map(s => shotNumber(b, s.id));
        if (missing.length) return fail(`Keyframe shot ${missing.join(', ')} belum siap — jalankan prepare dulu.`);
      }
      const todo = run.length;
      const what = shot ? `shot ${shot.n}` : scene ? `scene ${scene.n}` : 'semua shot';
      if (!todo) return { ok: true, label: `Tidak ada klip yang perlu dirender untuk ${what}.`, changed: false };
      const video = videoEngine(b);
      const ax = axcelVideo(b);
      let estimate: Estimate;
      let cost: string;
      if (ax) {
        estimate = {};
        cost = axcelCost(ax.model);
      } else if (!video) {
        estimate = { credits: todo * CREDITS_PER_SHOT };
        cost = `±${todo * CREDITS_PER_SHOT} kredit Flow`;
      } else {
        const each = await ctx.price?.usdPerClip(video.model).catch(() => null);
        estimate = typeof each === 'number' ? { usd: Math.round(todo * each * 100) / 100 } : {};
        cost = typeof each === 'number' ? `±${usdLabel(todo * each)} OpenRouter` : 'OpenRouter, harga tidak diketahui';
      }
      return { label: `Render ${todo} klip (${what}, ${cost})`, estimate, payload: { shot: shot?.id, scene: scene?.id, todo } };
    },
    execute: async (ctx, storyId, _input, plan) => {
      const { shot, scene, todo } = plan.payload as { shot?: string; scene?: string; todo: number };
      await ctx.stories.render(storyId, { ...(shot ? { shot } : scene ? { scene } : {}), ...revOf(ctx) });
      return { ok: true, label: `${todo} klip masuk antrean render` };
    }
  }),

  assemble: spending({
    description: `Assemble the final video from the finished clips (every shot must be done). Costs nothing but rebuilds the video. ${CHAT_CONFIRM_RULE}`,
    schema: obj({}),
    plan: async () => ({ label: 'Rakit video final (gratis)', estimate: { credits: 0 } }),
    execute: async (ctx, storyId) => {
      const record = await ctx.stories.assemble(storyId, revOf(ctx));
      return record.status === 'done' ? { ok: true, label: 'Video final sudah dirakit' } : fail(record.error ?? 'Perakitan gagal', 'FAILED');
    }
  }),

  undo_last: {
    description: 'Undo the most recent change made to this project by the assistant, MCP or a project button (restores the board and the takes; paid clips come back). Refused when the project changed after it.',
    schema: obj({}),
    spends: false,
    run: (ctx, storyId) => guarded(ctx, storyId, async record => {
      const last = (await ctx.snapshots.list(storyId)).find(s => typeof s.revAfter === 'number');
      if (!last) return fail('Belum ada perubahan yang bisa dibatalkan.', 'NOT_FOUND');
      let outcome;
      try {
        outcome = await ctx.stories.restoreSnapshot(storyId, last.undoId, record.rev);
      } catch (error) {
        if (error instanceof StoryError && error.code === 'BUSY') return fail(BUSY_MESSAGE, 'BUSY');
        throw error;
      }
      if (outcome.result === 'stale') return fail(UNDO_STALE_MESSAGE, 'STALE');
      if (outcome.result === 'missing') return fail('Perubahan itu sudah tidak bisa dibatalkan.', 'NOT_FOUND');
      if (ctx.turn.undoId === last.undoId) { ctx.turn.undoId = undefined; ctx.turn.rev = undefined; }
      let label = `Dibatalkan: ${last.label}`;
      if (outcome.attention.length) {
        const board = await ctx.stories.readStoryboard(storyId);
        const parts = outcome.attention.map(a => (a.take === 'cast' ? `sheet ${a.id}` : `shot ${shotNumber(board, a.id) || a.id} (${a.take === 'clip' ? 'klip' : 'keyframe'})`));
        label += `. Perlu dibuat ulang: ${parts.join(', ')}.`;
      }
      return { ok: true, label, changed: true };
    })
  }
};

/**
 * Run an action by name with an untrusted input (chat tool call / MCP): unknown names and
 * non-object inputs are plain errors, and a `confirm` key is stripped — spending is confirmed only
 * through `ctx.confirmed`.
 */
export async function runAction(ctx: ActionContext, storyId: string, name: string, input: unknown): Promise<ActionResult> {
  if (!(ACTION_NAMES as readonly string[]).includes(name)) return fail(`Aksi "${clip(name, 40)}" tidak ada.`);
  const args = input === undefined || input === null ? {} : input;
  if (typeof args !== 'object' || Array.isArray(args)) return fail('Input aksi harus objek JSON.');
  // Confirmation belongs to the caller (ctx.confirmed): a `confirm` the model wrote is dropped.
  const { confirm: _confirm, ...rest } = args as ActionInput;
  return ACTIONS[name as ActionName].run(ctx, storyId, rest);
}

/** OpenAI function specs of every action (chat tool loop, MCP tool list). */
export function toolSpecs(): ToolSpec[] {
  return ACTION_NAMES.map(name => ({ type: 'function' as const, function: { name, description: ACTIONS[name].description, parameters: ACTIONS[name].schema } }));
}

/** Range text for prompts ("Shot yang ada: 1–12"). */
