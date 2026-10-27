/**
 * Production model on the web side: Proyek → Scene → Shot. Pure functions only (no React, no IO).
 * Mirrors docs/production-model.md; the server normalises the same way, so the web can edit
 * optimistically and send the whole storyboard with PUT /api/stories/:id.
 */
import type { ShotState, Story, StoryboardShot, TakeState } from '../stories/storiesClient.js';

export type Location = { name: string; look: string };
export type Scene = { id: string; title: string; summary?: string; location?: string; shots: string[] };
/** Bible boards: what the shot must do; the server compiles the prompt from it (framing/move = catalog ids). */
export type ShotIntent = { subject: string; action: string; startState: string; endState: string; emotion?: string; framing?: string; move?: string; [key: string]: unknown };
export type Shot = StoryboardShot & { transition?: string; intent?: ShotIntent; startFrame?: string };
export type CharacterSpec = string | { name: string; look: string };
export type Board = {
  title: string;
  logline?: string;
  mode?: 'konsisten' | 'cepat';
  aspect?: '9:16' | '16:9';
  template?: string;
  look?: Record<string, string>;
  style?: string;
  narrator?: string;
  characters?: Record<string, CharacterSpec>;
  locations?: Record<string, Location>;
  scenes?: Scene[];
  shots: Shot[];
  [key: string]: unknown;
};

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const SECONDS_PER_SHOT = 6;

/** "12 dtk", "1:05 mnt" — never raw floats from ffprobe. */
export function fmtDuration(seconds: number): string {
  const s = Math.round(seconds);
  return s < 60 ? `${s} dtk` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} mnt`;
}

/** Intent skeleton of a new bible shot: the first character as subject, the rest for the user (spec goal 4). */
export function intentSkeleton(b: Board): ShotIntent {
  const cards = (b.bible as { characters?: Array<{ token?: unknown }> } | undefined)?.characters;
  const first = Array.isArray(cards) ? cards.find(c => typeof c?.token === 'string')?.token as string | undefined : undefined;
  return { subject: first ?? Object.keys(b.characters ?? {})[0] ?? '', action: '', startState: '', endState: '' };
}

const clone = (b: Board): Board => ({ ...b, shots: b.shots.map(s => ({ ...s })), scenes: (b.scenes ?? []).map(s => ({ ...s, shots: [...s.shots] })) });

/** Invariants 1–6 of the contract. */
export function normalizeScenes(input: Board): Board {
  const b = clone(input);
  const ids = new Set(b.shots.map(s => s.id));
  if (!b.scenes?.length) b.scenes = [{ id: 'scene-1', title: 'Scene 1', shots: b.shots.map(s => s.id) }];
  const seen = new Set<string>();
  for (const scene of b.scenes) {
    scene.shots = scene.shots.filter(id => ids.has(id) && !seen.has(id) && (seen.add(id), true));
    if (scene.location && !b.locations?.[scene.location]) delete scene.location;
  }
  const orphans = b.shots.map(s => s.id).filter(id => !seen.has(id));
  if (orphans.length) b.scenes[b.scenes.length - 1]!.shots.push(...orphans);
  const byId = new Map(b.shots.map(s => [s.id, s]));
  b.shots = b.scenes.flatMap(s => s.shots.map(id => byId.get(id)!));
  return b;
}

export const sceneOf = (b: Board, shotId: string): Scene | undefined => b.scenes?.find(s => s.shots.includes(shotId));

function uniqueId(taken: Iterable<string>, base: string): string {
  const used = new Set(taken);
  const stem = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'item';
  if (!used.has(stem) && ID_RE.test(stem)) return stem;
  for (let i = 2; ; i++) { const id = `${stem}-${i}`; if (!used.has(id)) return id; }
}

export function moveShot(input: Board, shotId: string, toSceneId: string, toIndex: number): Board {
  const b = normalizeScenes(input);
  const target = b.scenes!.find(s => s.id === toSceneId);
  if (!target || !b.shots.some(s => s.id === shotId)) return b;
  for (const s of b.scenes!) s.shots = s.shots.filter(id => id !== shotId);
  target.shots.splice(Math.max(0, Math.min(toIndex, target.shots.length)), 0, shotId);
  return normalizeScenes(b);
}

export function moveScene(input: Board, sceneId: string, toIndex: number): Board {
  const b = normalizeScenes(input);
  const i = b.scenes!.findIndex(s => s.id === sceneId);
  if (i < 0) return b;
  const [scene] = b.scenes!.splice(i, 1);
  b.scenes!.splice(Math.max(0, Math.min(toIndex, b.scenes!.length)), 0, scene!);
  return normalizeScenes(b);
}

/** What a new scene of a bible board needs: its story goal (required there) and, optionally, a location key. */
export type SceneGoal = { goal?: string; location?: string };

/**
 * The new scene's location on the board side and, on bible boards, its card `{id, title, goal, location?}`
 * in `bible.scenes` — in the same save, because the server refuses a new bible scene without a goal.
 */
function withSceneCard(b: Board, scene: Scene, extra: SceneGoal): void {
  const location = extra.location && b.locations?.[extra.location] ? extra.location : undefined;
  if (location) scene.location = location;
  const goal = extra.goal?.trim();
  if (!b.bible || !goal) return;
  const bible = b.bible as Record<string, unknown>;
  const cards = Array.isArray(bible.scenes) ? bible.scenes as unknown[] : [];
  b.bible = { ...bible, scenes: [...cards, { id: scene.id, title: scene.title, goal, ...(location ? { location } : {}) }] };
}

export function addScene(input: Board, title: string, afterSceneId?: string, extra: SceneGoal = {}): Board {
  const b = normalizeScenes(input);
  const scene: Scene = { id: uniqueId(b.scenes!.map(s => s.id), `scene-${b.scenes!.length + 1}`), title: title.trim() || `Scene ${b.scenes!.length + 1}`, shots: [] };
  const at = afterSceneId ? b.scenes!.findIndex(s => s.id === afterSceneId) + 1 : b.scenes!.length;
  b.scenes!.splice(at > 0 ? at : b.scenes!.length, 0, scene);
  withSceneCard(b, scene, extra);
  return normalizeScenes(b);
}

export function renameScene(input: Board, sceneId: string, title: string, patch: Partial<Pick<Scene, 'summary' | 'location'>> = {}): Board {
  const b = normalizeScenes(input);
  const s = b.scenes!.find(x => x.id === sceneId);
  if (s) {
    if (title.trim()) s.title = title.trim().slice(0, 80);
    if ('summary' in patch) { if (patch.summary?.trim()) s.summary = patch.summary.trim().slice(0, 300); else delete s.summary; }
    if ('location' in patch) { if (patch.location) s.location = patch.location; else delete s.location; }
  }
  return normalizeScenes(b);
}

/** Removing a scene never deletes shots: they join the previous scene (or the next one for the first). */
export function removeScene(input: Board, sceneId: string): Board {
  const b = normalizeScenes(input);
  if (b.scenes!.length <= 1) return b;
  const i = b.scenes!.findIndex(s => s.id === sceneId);
  if (i < 0) return b;
  const [gone] = b.scenes!.splice(i, 1);
  const heir = i > 0 ? b.scenes![i - 1]! : b.scenes![0]!;
  heir.shots = i > 0 ? [...heir.shots, ...gone!.shots] : [...gone!.shots, ...heir.shots];
  return normalizeScenes(b);
}

export function splitSceneAfter(input: Board, shotId: string, title: string, extra: SceneGoal = {}): Board {
  const b = normalizeScenes(input);
  const scene = sceneOf(b, shotId);
  if (!scene) return b;
  const at = scene.shots.indexOf(shotId) + 1;
  if (at >= scene.shots.length) return b;
  const rest = scene.shots.splice(at);
  const i = b.scenes!.indexOf(scene);
  const next: Scene = { id: uniqueId(b.scenes!.map(s => s.id), `scene-${b.scenes!.length + 1}`), title: title.trim() || `Scene ${i + 2}`, shots: rest };
  b.scenes!.splice(i + 1, 0, next);
  withSceneCard(b, next, extra);
  return normalizeScenes(b);
}

/** Location choices of a bible scene: the bible's locations (key + name), else the board's. */
export function locationChoices(b: Board): Array<{ key: string; name: string }> {
  const raw = (b.bible as { locations?: Array<{ key?: unknown; name?: unknown }> } | undefined)?.locations;
  const bible = Array.isArray(raw) ? raw.filter(l => typeof l?.key === 'string').map(l => ({ key: l.key as string, name: typeof l.name === 'string' && l.name ? l.name : l.key as string })) : [];
  return bible.length ? bible : Object.entries(b.locations ?? {}).map(([key, l]) => ({ key, name: l.name || key }));
}

/** A new shot; `init` overrides the placeholder (bible boards pass an intent skeleton so it is compiled, not prose). */
export function addShot(input: Board, sceneId: string, afterShotId?: string, init: Partial<Shot> = {}): Board {
  const b = normalizeScenes(input);
  const scene = b.scenes!.find(s => s.id === sceneId);
  if (!scene) return b;
  const id = uniqueId(b.shots.map(s => s.id), `shot-${b.shots.length + 1}`);
  b.shots.push({ id, prompt: 'Medium shot, the camera stays still. ', narration: 'Tulis narasi singkat di sini.', ...init });
  const at = afterShotId ? scene.shots.indexOf(afterShotId) + 1 : scene.shots.length;
  scene.shots.splice(at > 0 ? at : scene.shots.length, 0, id);
  return normalizeScenes(b);
}

export function duplicateShot(input: Board, shotId: string): Board {
  const b = normalizeScenes(input);
  const src = b.shots.find(s => s.id === shotId);
  const scene = sceneOf(b, shotId);
  if (!src || !scene) return b;
  const id = uniqueId(b.shots.map(s => s.id), `${shotId.replace(/-\d+$/, '')}-2`);
  const copy = { ...src, id };
  delete (copy as { reuse?: unknown }).reuse;
  b.shots.push(copy);
  scene.shots.splice(scene.shots.indexOf(shotId) + 1, 0, id);
  return normalizeScenes(b);
}

export function updateShot(input: Board, shotId: string, patch: Partial<Shot>): Board {
  const b = normalizeScenes(input);
  b.shots = b.shots.map(s => (s.id === shotId ? { ...s, ...patch, id: s.id } : s));
  return b;
}

export function removeShot(input: Board, shotId: string): Board {
  const b = normalizeScenes(input);
  if (b.shots.length <= 1) return b;
  b.shots = b.shots.filter(s => s.id !== shotId);
  for (const s of b.scenes!) s.shots = s.shots.filter(id => id !== shotId);
  return normalizeScenes(b);
}

// ---------------------------------------------------------------- progress

const isDone = (t?: { status: string }) => t?.status === 'done';

export type SceneProgress = { shots: number; frames: number; framesNeeded: number; clips: number; queued: number; failed: number; seconds: number };

export function sceneProgress(story: Story, b: Board, sceneId: string): SceneProgress {
  const scene = b.scenes?.find(s => s.id === sceneId);
  const states = (scene?.shots ?? []).map(id => story.shots.find(s => s.id === id)).filter((s): s is ShotState => !!s);
  const frames = states.map(s => s.frame).filter((f): f is TakeState => !!f);
  return {
    shots: states.length,
    frames: frames.filter(isDone).length,
    framesNeeded: frames.length,
    clips: states.filter(isDone).length,
    queued: states.filter(s => s.status === 'queued').length + frames.filter(f => f.status === 'queued').length,
    failed: states.filter(s => s.status === 'failed').length + frames.filter(f => f.status === 'failed').length,
    seconds: states.reduce((t, s) => t + (s.durationSec ?? SECONDS_PER_SHOT), 0)
  };
}

export type StageId = 'naskah' | 'breakdown' | 'keyframe' | 'render' | 'rakit';
export type Stage = { id: StageId; label: string; done: boolean; detail: string };

/** Where the project is in the production pipeline (used by the stage bar). */
export function stageOf(story: Story, b: Board): { stages: Stage[]; current: StageId } {
  const konsisten = story.mode === 'konsisten';
  const cast = story.cast ?? [];
  const frames = story.shots.filter(s => s.frame).map(s => s.frame!);
  const clipsDone = story.shots.filter(isDone).length;
  const castDone = cast.every(isDone);
  const framesDone = frames.every(isDone);
  const allClips = clipsDone === story.shots.length && story.shots.length > 0;
  const video = !!story.video && !(story as { videoStale?: boolean }).videoStale;
  const stages: Stage[] = [
    { id: 'naskah', label: 'Naskah', done: b.shots.length > 0, detail: `${b.scenes?.length ?? 1} scene · ${b.shots.length} shot` },
    ...(konsisten ? [{ id: 'breakdown' as const, label: 'Breakdown', done: castDone, detail: `${cast.filter(isDone).length}/${cast.length} karakter` }] : []),
    ...(konsisten ? [{ id: 'keyframe' as const, label: 'Keyframe', done: framesDone, detail: `${frames.filter(isDone).length}/${frames.length}` }] : []),
    { id: 'render', label: 'Render', done: allClips, detail: `${clipsDone}/${story.shots.length} klip` },
    { id: 'rakit', label: 'Rakit', done: video, detail: video ? 'Video jadi' : allClips ? 'Siap dirakit' : 'Menunggu klip' }
  ];
  return { stages, current: stages.find(s => !s.done)?.id ?? 'rakit' };
}
