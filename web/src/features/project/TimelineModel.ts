/**
 * Timeline maths, pure (no React): where every scene and shot sits on the time axis, what a
 * drag-and-drop or a "Geser" button does to the board, and the clip list for the monitor.
 * Board edits go through model.ts (moveShot / moveScene) so the contract invariants hold.
 */
import type { Story } from '../stories/storiesClient.js';
import { moveScene, moveShot, normalizeScenes, sceneOf, SECONDS_PER_SHOT, type Board } from './model.js';
import { media } from './useProject.js';
import { playerPosterWidth, poster, sized } from '../../lib/media.js';
import type { Clip } from './Player.js';

export type ClipStatus = 'pending' | 'queued' | 'done' | 'failed';
export type TimelineClip = {
  shotId: string; sceneId: string; index: number; start: number; seconds: number;
  status: ClipStatus; narration: string; frame?: string; frameDone: boolean; clipVersion?: string;
};
export type TimelineScene = { id: string; title: string; index: number; start: number; seconds: number; shots: number };
export type TimelineLayout = { total: number; scenes: TimelineScene[]; clips: TimelineClip[] };

const SHOT = 'shot:';
const SCENE = 'scene:';
export const shotKey = (id: string) => `${SHOT}${id}`;
export const sceneKey = (id: string) => `${SCENE}${id}`;
const parse = (key: string | null | undefined): { kind: 'shot' | 'scene'; id: string } | undefined => {
  if (!key) return undefined;
  if (key.startsWith(SHOT)) return { kind: 'shot', id: key.slice(SHOT.length) };
  if (key.startsWith(SCENE)) return { kind: 'scene', id: key.slice(SCENE.length) };
  return undefined;
};

export function timelineLayout(input: Board, story?: Story): TimelineLayout {
  const b = normalizeScenes(input);
  const state = new Map((story?.shots ?? []).map(s => [s.id, s]));
  const byId = new Map(b.shots.map(s => [s.id, s]));
  const clips: TimelineClip[] = [];
  const scenes: TimelineScene[] = [];
  let t = 0;
  b.scenes!.forEach((scene, si) => {
    const start = t;
    for (const id of scene.shots) {
      const shot = byId.get(id)!;
      const st = state.get(id);
      const seconds = st?.durationSec && st.durationSec > 0 ? st.durationSec : SECONDS_PER_SHOT;
      clips.push({
        shotId: id, sceneId: scene.id, index: clips.length, start: t, seconds,
        status: st?.status ?? 'pending',
        narration: shot.silent || !shot.narration?.trim() ? '—' : shot.narration.trim(),
        frame: st?.frame?.mediaId, frameDone: st?.frame?.status === 'done', clipVersion: st?.jobId ?? (st ? String(st.attempts) : undefined)
      });
      t += seconds;
    }
    scenes.push({ id: scene.id, title: scene.title, index: si, start, seconds: t - start, shots: scene.shots.length });
  });
  return { total: t || SECONDS_PER_SHOT, scenes, clips };
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export { mmss as formatSeconds };

export function rulerTicks(total: number, step = SECONDS_PER_SHOT): Array<{ at: number; label: string }> {
  const ticks = [];
  for (let at = 0; at <= total; at += step) ticks.push({ at, label: mmss(at) });
  return ticks;
}

/** Fingerprint of scene + shot order: did a reorder actually change anything? */
export const boardOrder = (b: Board) => normalizeScenes(b).scenes!.map(s => `${s.id}:${s.shots.join(',')}`).join('|');

/**
 * Drag end on the timeline. `activeId`/`overId` are dnd ids (`shot:<id>` / `scene:<id>`).
 * Shot on shot: the flat order moves like a sortable list (active lands where `over` was) and
 * the shot joins `over`'s scene. Shot on a scene band: nearest edge of that scene. Scene on a
 * scene band or on one of its clips: that scene's place. Returns the same board for no-ops.
 */
export function timelineDrop(input: Board, activeId: string, overId: string | null | undefined): Board {
  const a = parse(activeId);
  const o = parse(overId);
  if (!a || !o || activeId === overId) return input;
  const b = normalizeScenes(input);
  const scenes = b.scenes!;
  const flat = b.shots.map(s => s.id);

  if (a.kind === 'scene') {
    const from = scenes.findIndex(s => s.id === a.id);
    const target = o.kind === 'scene' ? scenes.find(s => s.id === o.id) : sceneOf(b, o.id);
    const to = target ? scenes.indexOf(target) : -1;
    if (from < 0 || to < 0 || from === to) return input;
    return moveScene(b, a.id, to);
  }

  const from = flat.indexOf(a.id);
  if (from < 0) return input;
  if (o.kind === 'scene') {
    const target = scenes.find(s => s.id === o.id);
    if (!target) return input;
    const own = scenes.indexOf(sceneOf(b, a.id)!);
    const before = target.shots.length ? from < flat.indexOf(target.shots.find(id => id !== a.id) ?? a.id) : own < scenes.indexOf(target);
    return moveShot(b, a.id, target.id, before ? 0 : target.shots.length);
  }

  const to = flat.indexOf(o.id);
  const target = sceneOf(b, o.id);
  if (to < 0 || !target) return input;
  const moved = [...flat];
  moved.splice(from, 1);
  moved.splice(to, 0, a.id);
  const members = new Set(target.shots.filter(id => id !== a.id));
  const index = moved.slice(0, moved.indexOf(a.id)).filter(id => members.has(id)).length;
  return moveShot(b, a.id, target.id, index);
}

/** "Geser kiri/kanan" for a shot: swap inside the scene, or step into the neighbour scene's edge. */
export function nudgeShot(input: Board, shotId: string, dir: -1 | 1): Board {
  const b = normalizeScenes(input);
  const scene = sceneOf(b, shotId);
  if (!scene) return input;
  const i = scene.shots.indexOf(shotId);
  const j = i + dir;
  if (j >= 0 && j < scene.shots.length) return moveShot(b, shotId, scene.id, j);
  const next = b.scenes![b.scenes!.indexOf(scene) + dir];
  if (!next) return input;
  return moveShot(b, shotId, next.id, dir < 0 ? next.shots.length : 0);
}

export function nudgeScene(input: Board, sceneId: string, dir: -1 | 1): Board {
  const b = normalizeScenes(input);
  const i = b.scenes!.findIndex(s => s.id === sceneId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= b.scenes!.length) return input;
  return moveScene(b, sceneId, j);
}

/** Clips for SequencePlayer: rendered shots play their clip, the rest show their keyframe still. */
export function sequenceClips(id: string, board: Board, story: Story, shotIds?: string[]): Clip[] {
  const l = timelineLayout(board, story);
  const pw = playerPosterWidth(300, board.aspect);
  const titles = new Map(l.scenes.map(s => [s.id, s.title]));
  const want = shotIds ? new Set(shotIds) : undefined;
  return l.clips.filter(c => !want || want.has(c.shotId)).map(c => ({
    id: c.shotId,
    label: `Shot ${c.index + 1} · ${titles.get(c.sceneId) ?? ''}`,
    seconds: c.seconds,
    src: c.status === 'done' ? media.clip(id, c.shotId, c.clipVersion) : undefined,
    // rendered: the clip's own poster (never a black box); else its keyframe still
    poster: c.status === 'done' ? poster.shot(id, c.shotId, pw, c.clipVersion) : c.frameDone ? sized(media.frame(id, c.shotId, c.frame), pw) : undefined
  }));
}
