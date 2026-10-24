import { describe, expect, it } from 'vitest';
import {
  addScene, addShot, duplicateShot, moveScene, moveShot, normalizeScenes, removeScene, removeShot, renameScene,
  sceneOf, sceneProgress, splitSceneAfter, stageOf, updateShot, type Board
} from './model.js';

const board = (over: Partial<Board> = {}): Board => ({
  title: 'T', mode: 'konsisten',
  shots: [
    { id: '00-pembuka', prompt: 'Wide shot, the camera stays still. A valley.', silent: true },
    { id: '01-pasar', prompt: 'Medium shot, the camera stays still. LARAS buys fish.', narration: 'Laras ke pasar.' },
    { id: '02-hujan', prompt: 'Close-up, the camera pushes in slowly. Rain.', narration: 'Hujan turun.' },
    { id: '03-pulang', prompt: 'Wide shot, the camera stays still. LARAS walks home.', narration: 'Laras pulang.' }
  ],
  ...over
});

describe('normalizeScenes', () => {
  it('wraps a board without scenes into one scene', () => {
    const b = normalizeScenes(board());
    expect(b.scenes).toEqual([{ id: 'scene-1', title: 'Scene 1', shots: ['00-pembuka', '01-pasar', '02-hujan', '03-pulang'] }]);
  });

  it('drops unknown/duplicate ids, appends orphans to the last scene, reorders shots, drops unknown locations', () => {
    const b = normalizeScenes(board({
      locations: { PASAR: { name: 'Pasar', look: 'a busy fish market' } },
      scenes: [
        { id: 'a', title: 'A', location: 'PASAR', shots: ['01-pasar', 'ghost', '01-pasar'] },
        { id: 'b', title: 'B', location: 'NOPE', shots: ['00-pembuka'] }
      ]
    }));
    expect(b.scenes!.map(s => s.shots)).toEqual([['01-pasar'], ['00-pembuka', '02-hujan', '03-pulang']]);
    expect(b.scenes![0]!.location).toBe('PASAR');
    expect(b.scenes![1]!.location).toBeUndefined();
    expect(b.shots.map(s => s.id)).toEqual(['01-pasar', '00-pembuka', '02-hujan', '03-pulang']);
  });

  it('keeps empty scenes', () => {
    const b = normalizeScenes(board({ scenes: [{ id: 'a', title: 'A', shots: ['00-pembuka', '01-pasar', '02-hujan', '03-pulang'] }, { id: 'b', title: 'B', shots: [] }] }));
    expect(b.scenes!.map(s => s.shots.length)).toEqual([4, 0]);
  });
});

describe('scene + shot operations (pure, return a new normalised board)', () => {
  const two = () => normalizeScenes(board({ scenes: [{ id: 'a', title: 'Pagi', shots: ['00-pembuka', '01-pasar'] }, { id: 'b', title: 'Sore', shots: ['02-hujan', '03-pulang'] }] }));

  it('moves a shot within and across scenes', () => {
    const within = moveShot(two(), '01-pasar', 'a', 0);
    expect(within.scenes![0]!.shots).toEqual(['01-pasar', '00-pembuka']);
    const across = moveShot(two(), '00-pembuka', 'b', 1);
    expect(across.scenes!.map(s => s.shots)).toEqual([['01-pasar'], ['02-hujan', '00-pembuka', '03-pulang']]);
    expect(across.shots.map(s => s.id)).toEqual(['01-pasar', '02-hujan', '00-pembuka', '03-pulang']);
    expect(sceneOf(across, '00-pembuka')?.id).toBe('b');
  });

  it('moves a scene, adds/renames/removes scenes (removed scene shots go to the previous one)', () => {
    expect(moveScene(two(), 'b', 0).scenes!.map(s => s.id)).toEqual(['b', 'a']);
    const added = addScene(two(), 'Malam');
    expect(added.scenes!.at(-1)).toMatchObject({ title: 'Malam', shots: [] });
    expect(new Set(added.scenes!.map(s => s.id)).size).toBe(3);
    expect(renameScene(two(), 'a', 'Subuh').scenes![0]!.title).toBe('Subuh');
    expect(removeScene(two(), 'b').scenes!.map(s => s.shots)).toEqual([['00-pembuka', '01-pasar', '02-hujan', '03-pulang']]);
    expect(removeScene(two(), 'a').scenes!.map(s => s.shots)).toEqual([['00-pembuka', '01-pasar', '02-hujan', '03-pulang']]);
  });

  it('splits a scene after a shot', () => {
    const b = splitSceneAfter(normalizeScenes(board()), '01-pasar', 'Bagian 2');
    expect(b.scenes!.map(s => [s.title, s.shots])).toEqual([['Scene 1', ['00-pembuka', '01-pasar']], ['Bagian 2', ['02-hujan', '03-pulang']]]);
  });

  it('adds, duplicates, edits and removes shots with valid unique ids', () => {
    const added = addShot(two(), 'a', '00-pembuka');
    const newId = added.scenes![0]!.shots[1]!;
    expect(newId).toMatch(/^[a-z0-9][a-z0-9-]{0,40}$/);
    expect(added.shots.find(s => s.id === newId)).toMatchObject({ prompt: expect.any(String), narration: expect.any(String) });
    const dup = duplicateShot(two(), '02-hujan');
    expect(dup.scenes![1]!.shots).toHaveLength(3);
    expect(dup.scenes![1]!.shots[1]).not.toBe('02-hujan');
    expect(updateShot(two(), '02-hujan', { narration: 'Hujan deras.' }).shots.find(s => s.id === '02-hujan')!.narration).toBe('Hujan deras.');
    const removed = removeShot(two(), '02-hujan');
    expect(removed.shots.map(s => s.id)).not.toContain('02-hujan');
    expect(removed.scenes![1]!.shots).toEqual(['03-pulang']);
  });
});

describe('progress + stage', () => {
  const b = normalizeScenes(board({ scenes: [{ id: 'a', title: 'A', shots: ['00-pembuka', '01-pasar'] }, { id: 'b', title: 'B', shots: ['02-hujan', '03-pulang'] }] }));
  const take = (status: string) => ({ status, attempts: 0 }) as { status: string; attempts: number };
  const story = (frames: string[], clips: string[]) => ({
    id: 's', title: 'T', status: 'review', mode: 'konsisten', createdAtMs: 0, updatedAtMs: 0, events: [],
    cast: [{ token: 'LARAS', name: 'Laras', ...take('done') }],
    shots: b.shots.map((s, i) => ({ id: s.id, status: clips[i], attempts: 0, frame: take(frames[i]!) }))
  }) as never;

  it('counts per scene', () => {
    const p = sceneProgress(story(['done', 'done', 'pending', 'queued'], ['done', 'pending', 'pending', 'pending']), b, 'a');
    expect(p).toMatchObject({ shots: 2, frames: 2, clips: 1, queued: 0, failed: 0 });
    expect(sceneProgress(story(['done', 'done', 'pending', 'queued'], ['done', 'pending', 'pending', 'pending']), b, 'b')).toMatchObject({ frames: 0, queued: 1 });
  });

  it('derives the production stage', () => {
    expect(stageOf(story(['pending', 'pending', 'pending', 'pending'], ['pending', 'pending', 'pending', 'pending']), b).current).toBe('keyframe');
    expect(stageOf(story(['done', 'done', 'done', 'done'], ['done', 'pending', 'pending', 'pending']), b).current).toBe('render');
    expect(stageOf(story(['done', 'done', 'done', 'done'], ['done', 'done', 'done', 'done']), b).current).toBe('rakit');
  });
});
