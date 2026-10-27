/**
 * Pure helpers of the Scene tab: drag-end → board, cast detection, status labels, render cost.
 * No React here, so every rule is unit-tested (SceneHelpers.test.ts).
 */
import type { Story } from '../stories/storiesClient.js';
import { moveScene, moveShot, sceneOf, type Board, type SceneProgress } from './model.js';

export const CREDITS_PER_SHOT = 10;

/** dnd-kit ids: scenes and shots share one DndContext, so ids carry their kind. */
export const dragId = { scene: (id: string) => `scene:${id}`, shot: (id: string) => `shot:${id}` };

export function parseDragId(raw: unknown): { kind: 'scene' | 'shot'; id: string } | undefined {
  const m = /^(scene|shot):(.+)$/.exec(String(raw ?? ''));
  return m ? { kind: m[1] as 'scene' | 'shot', id: m[2]! } : undefined;
}

/**
 * The board after dropping `active` on `over`, or null when nothing changes.
 * shot → shot: takes the target's place (arrayMove semantics within a scene, before it across scenes).
 * shot → scene (left list): appended to that scene. scene → scene: takes the target's place.
 */
export function dragEndBoard(board: Board, activeId: unknown, overId: unknown): Board | null {
  const a = parseDragId(activeId);
  const o = parseDragId(overId);
  if (!a || !o || (a.kind === o.kind && a.id === o.id)) return null;
  if (a.kind === 'scene') {
    if (o.kind !== 'scene') return null;
    const to = board.scenes?.findIndex(s => s.id === o.id) ?? -1;
    return to < 0 ? null : moveScene(board, a.id, to);
  }
  const from = sceneOf(board, a.id);
  if (!from) return null;
  if (o.kind === 'scene') {
    const target = board.scenes?.find(s => s.id === o.id);
    if (!target || target.id === from.id) return null;
    return moveShot(board, a.id, target.id, target.shots.length);
  }
  const target = sceneOf(board, o.id);
  if (!target) return null;
  return moveShot(board, a.id, target.id, target.shots.indexOf(o.id));
}

const titleCase = (token: string) => token.toLowerCase().split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

export type CastChip = { token: string; name: string };

/** Characters whose TOKEN appears (as a whole word) in any of the texts, in `characters` order. */
export function castInText(board: Board, story: Story | undefined, texts: string[]): CastChip[] {
  const all = texts.join('\n');
  return Object.entries(board.characters ?? {})
    .filter(([token]) => new RegExp(`(^|[^A-Za-z0-9_])${token}(?![A-Za-z0-9_])`).test(all))
    .map(([token, spec]) => ({
      token,
      name: story?.cast?.find(c => c.token === token)?.name || (typeof spec === 'object' && spec.name) || titleCase(token)
    }));
}

export function castIn(board: Board, story: Story | undefined, shotIds: string[]): CastChip[] {
  return castInText(board, story, shotIds.map(id => board.shots.find(s => s.id === id)?.prompt ?? ''));
}

export const wordCount = (text: string | undefined) => (text ?? '').trim().split(/\s+/).filter(Boolean).length;

export function snippet(text: string | undefined, words = 6): string {
  const w = (text ?? '').trim().split(/\s+/).filter(Boolean);
  return w.length > words ? `${w.slice(0, words).join(' ')}…` : w.join(' ');
}

/** Shots of the scene that still need a clip, and what rendering them costs. */
export function renderCost(story: Story, board: Board, sceneId: string): { todo: number; credits: number } {
  const ids = board.scenes?.find(s => s.id === sceneId)?.shots ?? [];
  const todo = ids.filter(id => story.shots.find(s => s.id === id)?.status !== 'done').length;
  return { todo, credits: todo * CREDITS_PER_SHOT };
}

export type Tone = 'success' | 'brand' | 'working' | 'danger' | 'muted';
export const TONE_DOT: Record<Tone, string> = {
  success: 'bg-(--success)', brand: 'bg-(--brand)', working: 'bg-(--warning) animate-pulse', danger: 'bg-destructive', muted: 'bg-muted-foreground/40'
};
export const TONE_TEXT: Record<Tone, string> = {
  success: 'text-(--success)', brand: 'text-(--brand)', working: 'text-foreground', danger: 'text-destructive', muted: 'text-muted-foreground'
};

/** "baru mulai" / "3 mnt" / "1 j 12 mnt" — how long a render has been running, never a fake %. */
export function elapsedLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'baru mulai';
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'baru mulai';
  if (mins < 60) return `${mins} mnt`;
  const hours = Math.floor(mins / 60);
  return `${hours} j ${mins % 60} mnt`;
}

/**
 * One status per shot card: the clip wins over the keyframe once it has started.
 * A queued shot says whether the bridge has picked it up yet (`jobPhase`) and for how long,
 * because "Merender" alone cannot tell a healthy 2-minute render from a stuck one.
 */
export function shotStatus(story: Story, shotId: string, now = Date.now()): { label: string; tone: Tone } {
  const s = story.shots.find(x => x.id === shotId);
  if (s?.status === 'done') return { label: 'Klip siap', tone: 'success' };
  if (s?.status === 'queued') {
    const span = s.jobStartedAtMs ? elapsedLabel(now - s.jobStartedAtMs) : '';
    if (s.jobPhase === 'running') return { label: span ? `Merender · ${span}` : 'Merender', tone: 'working' };
    if (s.jobPhase === 'queued') return { label: 'Menunggu bridge', tone: 'working' };
    return { label: 'Merender', tone: 'working' };
  }
  if (s?.status === 'failed') return { label: 'Render gagal', tone: 'danger' };
  const f = s?.frame;
  if (f?.status === 'queued') return { label: 'Menggambar keyframe', tone: 'working' };
  if (f?.status === 'failed') return { label: 'Keyframe gagal', tone: 'danger' };
  if (f?.status === 'done') return { label: 'Keyframe siap', tone: 'brand' };
  if (f) return { label: 'Keyframe belum dibuat', tone: 'muted' };
  return { label: 'Belum dirender', tone: 'muted' };
}

/** The coloured dot of a scene in the list. A failure is shown before work in progress. */
export function sceneTone(p: SceneProgress): { label: string; tone: Tone } {
  if (!p.shots) return { label: 'Belum ada shot', tone: 'muted' };
  if (p.failed) return { label: 'Ada yang gagal', tone: 'danger' };
  if (p.queued) return { label: 'Sedang diproses', tone: 'working' };
  if (p.clips === p.shots) return { label: 'Klip lengkap', tone: 'success' };
  if (p.framesNeeded && p.frames === p.framesNeeded) return { label: 'Keyframe siap', tone: 'brand' };
  if (p.clips || p.frames) return { label: 'Sebagian siap', tone: 'brand' };
  return { label: 'Belum mulai', tone: 'muted' };
}
