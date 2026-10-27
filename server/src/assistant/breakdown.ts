/**
 * Scene → shots with the text model (spec §6.4). The model writes INTENT only (subject, one
 * action, start/end state, emotion, catalog framing + move, Indonesian narration); every intent is
 * compiled by the bible compiler and its narration linted before anything is inserted. Problems
 * are sent back once as one feedback message; a second failing reply is a plain error and nothing
 * is inserted. Pure apart from the model call: the caller saves the returned shots.
 */
import { ShotCompileError, type ShotIntent } from '../bible/compiler.js';
import { rulesOf } from '../bible/story.js';
import type { ChatMessage, TextModel } from '../llm/opencode.js';
import { cameraId, FRAMING_IDS, MOVE_IDS } from './camera.js';
import { bibleSceneFor, compileBoardShot, normalizeScenes, promptFromIntent, type Shot, type Storyboard } from '../stories/storyboard.js';
import { lintCopy } from '../text/lint.js';

export const MIN_BREAKDOWN = 2;
export const MAX_BREAKDOWN = 8;
/** The prose "Tambah shot" puts in a new, empty shot (web/src/features/project/model.ts). */
const PLACEHOLDER_PROMPT = 'Medium shot, the camera stays still.';

export class BreakdownError extends Error {
  constructor(message: string, readonly issues: string[] = []) {
    super(message);
    this.name = 'BreakdownError';
  }
}

export type BreakdownMode = 'replace' | 'append';

/** An empty shot nobody wrote yet: no intent content and no prose beyond the default camera sentence. */
export function isPlaceholder(shot: Shot): boolean {
  if (shot.reuse) return false;
  if (shot.intent) return !shot.intent.subject?.trim() && !shot.intent.action?.trim();
  const prose = (shot.prompt ?? '').trim();
  return !prose || prose === PLACEHOLDER_PROMPT;
}

/** replace when the scene holds only placeholders (or nothing), else append. */
export function defaultMode(board: Storyboard, sceneId: string): BreakdownMode {
  const b = normalizeScenes(board);
  const scene = b.scenes!.find(s => s.id === sceneId);
  const shots = (scene?.shots ?? []).map(id => b.shots.find(s => s.id === id)!).filter(Boolean);
  return shots.every(isPlaceholder) ? 'replace' : 'append';
}

export const REPLACE_REFUSED_MESSAGE = 'Scene ini punya klip/keyframe jadi — pakai mode Tambah di akhir.';

/** A take the user already has (done clip or done keyframe): replace mode would drop it. */
export function hasDoneTake(take: { status?: string; frame?: { status?: string } } | undefined): boolean {
  return take?.status === 'done' || take?.frame?.status === 'done';
}

/** A JSON array of intents from a model reply: bare, inside ```json fences, or as {shots:[…]}. */
export function parseIntents(text: string): unknown[] | undefined {
  const raw = String(text ?? '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)?.[1]?.trim();
  for (const candidate of [fenced, raw].filter((c): c is string => !!c)) {
    for (const slice of [candidate, between(candidate, '[', ']'), between(candidate, '{', '}')]) {
      if (!slice) continue;
      try {
        const value = JSON.parse(slice) as unknown;
        if (Array.isArray(value)) return value;
        const shots = (value as { shots?: unknown })?.shots;
        if (Array.isArray(shots)) return shots;
      } catch { /* try the next shape */ }
    }
  }
  return undefined;
}

function between(text: string, open: string, close: string): string | undefined {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}

const clip = (text: string | undefined, max: number) => {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** One line describing an existing shot for continuity. */
function describe(board: Storyboard, shot: Shot, n: number): string {
  const what = shot.intent?.action ? `${shot.intent.subject} ${shot.intent.action}` : shot.prompt;
  return `(shot ${n}) ${clip(what, 160)}${shot.narration && !shot.silent ? ` — "${clip(shot.narration, 80)}"` : ''}`;
}

/** System + user messages: the bible facts the shots must serve, the neighbours, the rules. */
export function breakdownMessages(board: Storyboard, sceneId: string, count: number, brief: string | undefined, mode: BreakdownMode): ChatMessage[] {
  const b = normalizeScenes(board);
  const bible = b.bible!;
  const rules = rulesOf(bible);
  const scenes = b.scenes!;
  const index = scenes.findIndex(s => s.id === sceneId);
  const scene = scenes[index]!;
  const order = b.shots.map(s => s.id);
  const num = (id: string) => order.indexOf(id) + 1;
  const card = scene.shots.length ? bibleSceneFor(b, b.shots.find(s => s.id === scene.shots[0])!) : (bible.scenes.find(c => c.id === scene.id) ?? bible.scenes.find(c => c.title.trim().toLowerCase() === scene.title.trim().toLowerCase()));
  const locKey = scene.location ?? card?.location;
  const location = locKey ? bible.locations.find(l => l.key === locKey) : undefined;
  const byId = new Map(b.shots.map(s => [s.id, s]));
  const before = scenes.slice(0, index).flatMap(s => s.shots).slice(-2);
  const after = scenes.slice(index + 1).flatMap(s => s.shots).slice(0, 2);
  const inScene = mode === 'append' ? scene.shots : [];

  const system = [
    'You are the shot planner of a short vertical story video. You break ONE scene into shots.',
    `Reply with ONLY a JSON array of exactly ${count} objects, no prose, no markdown.`,
    'Each object: {"subject": string, "action": string, "startState": string, "endState": string, "emotion": string, "framing": string, "move": string, "narration": string, "silent": boolean}.',
    'Rules:',
    '- subject: a character TOKEN from the cast list (e.g. LARAS) or a concrete noun phrase. Write TOKENs, never names, in subject, action and states.',
    '- action: ONE verb chain in English, present tense. Never "and then", never two actions.',
    '- startState / endState: English, what is visible in the first and in the last frame. They must differ.',
    `- framing: one id of [${FRAMING_IDS.join(', ')}].`,
    `- move: exactly one camera move id of [${MOVE_IDS.join(', ')}]. One camera move per shot.`,
    `- narration: Bahasa Indonesia, at most ${rules.narrationMaxWords} words, one concrete sentence, character names (not TOKENs), no emoji, no "!!", no empty adjectives (indah, megah, epik, sinematik, dramatis, memukau). silent=true only for a beat without voice-over, then narration is "".`,
    `- Every shot lasts at most ${rules.maxShotSec} seconds: one beat per shot.`,
    '- Never name camera gear (crane, drone, rig, gimbal, dolly track) and never use empty adjectives (beautiful, cinematic, epic, stunning).',
    '- The shots serve the scene goal in order and continue from the shot before.'
  ].join('\n');

  const lines = [
    `Story: ${b.title}`,
    `Logline: ${bible.logline}`,
    `Tone: ${bible.tone}. Audience: ${bible.audience}.`,
    `Scene ${index + 1} of ${scenes.length}: "${scene.title}" — goal: ${card?.goal ?? '(none)'}${card?.stateIn ? `; starts: ${card.stateIn}` : ''}${card?.stateOut ? `; ends: ${card.stateOut}` : ''}`,
    location ? `Location ${location.key}: ${location.name}${location.lookdev ? ` — ${location.lookdev}` : ''}` : 'Location: (none)',
    'Cast (TOKEN = name: visual anchors):',
    ...(bible.characters.length ? bible.characters.map(c => `- ${c.token} = ${c.name}: ${c.anchors.join('; ')}`) : ['- (no characters: use concrete noun phrases)']),
    `Rules: each shot at most ${rules.maxShotSec} s; narration at most ${rules.narrationMaxWords} words in Bahasa Indonesia; one action and one camera move per shot.`,
    ...(before.length ? ['Shots before this scene:', ...before.map(id => `- ${describe(b, byId.get(id)!, num(id))}`)] : []),
    ...(inScene.length ? ['Shots already in this scene (keep them; your shots come after them):', ...inScene.map(id => `- ${describe(b, byId.get(id)!, num(id))}`)] : []),
    ...(after.length ? ['Shots after this scene:', ...after.map(id => `- ${describe(b, byId.get(id)!, num(id))}`)] : []),
    ...(brief?.trim() ? [`Director's note: ${clip(brief, 500)}`] : []),
    `Write exactly ${count} shots for this scene.`
  ];
  return [{ role: 'system', content: system }, { role: 'user', content: lines.join('\n') }];
}

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** Unique, valid shot ids for the new shots (`<scene>-<k>`). */
function newIds(board: Storyboard, sceneId: string, count: number): string[] {
  const taken = new Set(board.shots.map(s => s.id));
  const stem = sceneId.slice(0, 30).replace(/-+$/, '') || 'shot';
  const ids: string[] = [];
  for (let k = 1; ids.length < count; k++) {
    const id = `${stem}-${k}`;
    if (!taken.has(id)) { taken.add(id); ids.push(id); }
  }
  return ids;
}

/** The board with `shots` placed in the scene (after its shots, or instead of them). */
export function withSceneShots(board: Storyboard, sceneId: string, shots: Shot[], mode: BreakdownMode): Storyboard {
  const b = normalizeScenes(board);
  const scene = b.scenes!.find(s => s.id === sceneId)!;
  const dropped = new Set(mode === 'replace' ? scene.shots : []);
  const scenes = b.scenes!.map(s => (s.id === sceneId ? { ...s, shots: [...s.shots.filter(id => !dropped.has(id)), ...shots.map(x => x.id)] } : s));
  return normalizeScenes({ ...b, scenes, shots: [...b.shots.filter(s => !dropped.has(s.id)), ...shots] });
}

/** Shots built from a reply + every problem found (compile, lint, shape, count). */
function check(board: Storyboard, sceneId: string, count: number, mode: BreakdownMode, items: unknown[] | undefined): { shots: Shot[]; issues: string[] } {
  if (!items) return { shots: [], issues: [`the reply was not a JSON array; return exactly ${count} shots as a JSON array`] };
  const issues: string[] = [];
  if (items.length !== count) issues.push(`return exactly ${count} shots (you returned ${items.length})`);
  const ids = newIds(board, sceneId, items.length);
  const shots: Shot[] = [];
  items.forEach((item, i) => {
    const at = `shot ${i + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) { issues.push(`${at}: must be an object`); return; }
    const o = item as Record<string, unknown>;
    const intent: ShotIntent = { subject: str(o.subject), action: str(o.action), startState: str(o.startState), endState: str(o.endState) };
    if (str(o.emotion)) intent.emotion = str(o.emotion);
    // Catalog ids only (shared validator with edit_shot/add_shot); a wrong one is fed back, never silently replaced.
    const framing = str(o.framing);
    const move = str(o.move);
    if (framing) { const id = cameraId('framing', framing); if (id) intent.framing = id; else issues.push(`${at}: framing "${clip(framing, 40)}" is not one of ${FRAMING_IDS.join(', ')}`); }
    if (move) { const id = cameraId('move', move); if (id) intent.move = id; else issues.push(`${at}: move "${clip(move, 40)}" is not one of ${MOVE_IDS.join(', ')}`); }
    const silent = o.silent === true;
    const narration = silent ? '' : str(o.narration);
    if (!silent) for (const problem of lintCopy(narration, { kind: 'narration' })) issues.push(`${at}: ${problem}`);
    shots.push({ id: ids[i]!, prompt: '', ...(narration ? { narration } : {}), ...(silent ? { silent: true } : {}), intent });
  });
  const preview = withSceneShots(board, sceneId, shots, mode);
  shots.forEach((shot, i) => {
    shot.prompt = promptFromIntent(preview, shot);
    try {
      // A character the frame would draw without its sheet is a problem for the model to fix, not a note.
      for (const warning of compileBoardShot(preview, shot).warnings) if (/subject or action/.test(warning)) issues.push(`shot ${i + 1}: ${warning}`);
    } catch (error) {
      if (!(error instanceof ShotCompileError)) throw error;
      for (const issue of error.issues) issues.push(`shot ${i + 1}: ${issue}`);
    }
  });
  return { shots, issues: [...new Set(issues)] };
}

/**
 * N compiled, lint-clean shots for one scene of a bible board. One feedback round on problems;
 * throws BreakdownError (nothing to insert) when the second reply still fails.
 */
export async function breakdownScene(
  model: TextModel, board: Storyboard, sceneId: string, count: number, brief?: string,
  opts: { mode?: BreakdownMode; signal?: AbortSignal } = {}
): Promise<Shot[]> {
  if (!board.bible) throw new BreakdownError('Pecah scene butuh bible — buat bible dulu di tab Bible.');
  if (!Number.isInteger(count) || count < MIN_BREAKDOWN || count > MAX_BREAKDOWN) throw new BreakdownError(`Jumlah shot harus ${MIN_BREAKDOWN}–${MAX_BREAKDOWN}.`);
  const b = normalizeScenes(board);
  if (!b.scenes!.some(s => s.id === sceneId)) throw new BreakdownError('Scene tidak ditemukan.');
  const mode = opts.mode ?? defaultMode(b, sceneId);
  const messages = breakdownMessages(b, sceneId, count, brief, mode);
  let result: { shots: Shot[]; issues: string[] } = { shots: [], issues: [] };
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await model.chat({ messages, maxTokens: 4000, ...(opts.signal ? { signal: opts.signal } : {}) });
    const content = reply.message.content ?? '';
    result = check(b, sceneId, count, mode, parseIntents(content));
    if (!result.issues.length) return result.shots;
    messages.push({ role: 'assistant', content: content.slice(0, 8000) });
    messages.push({
      role: 'user',
      content: `Your reply has problems:\n${result.issues.map(i => `- ${i}`).join('\n')}\nFix every problem and return the complete JSON array of exactly ${count} shots again, nothing else.`
    });
  }
  const shown = result.issues.slice(0, 6);
  throw new BreakdownError(`Gagal memecah scene: ${shown.join('; ')}${result.issues.length > shown.length ? ` (+${result.issues.length - shown.length} lagi)` : ''}`, result.issues);
}
