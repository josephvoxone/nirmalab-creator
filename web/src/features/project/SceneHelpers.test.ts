import { describe, expect, it } from 'vitest';
import { castIn, castInText, dragEndBoard, dragId, renderCost, sceneTone, shotStatus, snippet, wordCount } from './SceneHelpers.js';
import { sceneProgress } from './model.js';
import { BOARD, storyFor } from './testkit.js';

const order = (b: ReturnType<typeof dragEndBoard>) => b && b.scenes!.map(s => `${s.id}:${s.shots.join(',')}`);

describe('dragEndBoard (drag-end handler for the scene tab)', () => {
  it('reorders shots inside a scene like arrayMove (forward and backward)', () => {
    expect(order(dragEndBoard(BOARD, dragId.shot('00-pembuka'), dragId.shot('01-pagar')))).toEqual(['menunggu:01-pagar,00-pembuka', 'pulang:02-jalan,03-peluk']);
    expect(order(dragEndBoard(BOARD, dragId.shot('03-peluk'), dragId.shot('02-jalan')))).toEqual(['menunggu:00-pembuka,01-pagar', 'pulang:03-peluk,02-jalan']);
  });

  it('moves a shot before the shot it is dropped on in another scene', () => {
    expect(order(dragEndBoard(BOARD, dragId.shot('01-pagar'), dragId.shot('03-peluk')))).toEqual(['menunggu:00-pembuka', 'pulang:02-jalan,01-pagar,03-peluk']);
  });

  it('moves a shot to the end of a scene dropped on in the scene list', () => {
    const b = dragEndBoard(BOARD, dragId.shot('00-pembuka'), dragId.scene('pulang'));
    expect(order(b)).toEqual(['menunggu:01-pagar', 'pulang:02-jalan,03-peluk,00-pembuka']);
    expect(b!.shots.map(s => s.id)).toEqual(['01-pagar', '02-jalan', '03-peluk', '00-pembuka']);
  });

  it('reorders scenes', () => {
    expect(order(dragEndBoard(BOARD, dragId.scene('menunggu'), dragId.scene('pulang')))).toEqual(['pulang:02-jalan,03-peluk', 'menunggu:00-pembuka,01-pagar']);
    expect(order(dragEndBoard(BOARD, dragId.scene('pulang'), dragId.scene('menunggu')))).toEqual(['pulang:02-jalan,03-peluk', 'menunggu:00-pembuka,01-pagar']);
  });

  it('returns null for no-ops: same item, no target, shot on its own scene, scene on a shot', () => {
    expect(dragEndBoard(BOARD, dragId.shot('00-pembuka'), dragId.shot('00-pembuka'))).toBeNull();
    expect(dragEndBoard(BOARD, dragId.shot('00-pembuka'), undefined)).toBeNull();
    expect(dragEndBoard(BOARD, dragId.shot('00-pembuka'), dragId.scene('menunggu'))).toBeNull();
    expect(dragEndBoard(BOARD, dragId.scene('menunggu'), dragId.shot('03-peluk'))).toBeNull();
    expect(dragEndBoard(BOARD, 'junk', dragId.scene('pulang'))).toBeNull();
  });
});

describe('scene helpers', () => {
  it('detects cast tokens used in shot prompts, named like the server', () => {
    const story = storyFor(BOARD);
    expect(castIn(BOARD, story, ['00-pembuka', '01-pagar'])).toEqual([{ token: 'JINGGA', name: 'Jingga' }]);
    expect(castIn(BOARD, story, ['02-jalan', '03-peluk']).map(c => c.name)).toEqual(['Jingga', 'Bima']);
    expect(castIn(BOARD, undefined, ['02-jalan']).map(c => c.name)).toEqual(['Bima']);
    expect(castInText({ ...BOARD, characters: { BIMA: 'x' } }, undefined, ['JINGGA and BIMANTARA wait']).map(c => c.token)).toEqual([]);
    expect(castInText({ ...BOARD, characters: { BIMA: 'x', SRI_AYU: { name: '', look: 'y' } } }, undefined, ['SRI_AYU sees BIMA']).map(c => c.name)).toEqual(['Bima', 'Sri Ayu']);
  });

  it('counts words, snippets narration and prices a scene render (not-done shots × 10)', () => {
    expect(wordCount('  Jingga  menunggu setiap sore. ')).toBe(4);
    expect(wordCount(undefined)).toBe(0);
    expect(snippet('satu dua tiga empat lima enam tujuh', 5)).toBe('satu dua tiga empat lima…');
    expect(snippet('satu dua', 5)).toBe('satu dua');
    expect(renderCost(storyFor(BOARD, [], ['done', 'pending', 'failed', 'done']), BOARD, 'menunggu')).toEqual({ todo: 1, credits: 10 });
    expect(renderCost(storyFor(BOARD), BOARD, 'pulang')).toEqual({ todo: 2, credits: 20 });
  });

  it('labels shot and scene status', () => {
    const story = storyFor(BOARD, ['done', 'queued', 'failed', 'done'], ['done', 'pending', 'pending', 'queued']);
    expect(['00-pembuka', '01-pagar', '02-jalan', '03-peluk'].map(id => shotStatus(story, id).label)).toEqual(['Klip siap', 'Menggambar keyframe', 'Keyframe gagal', 'Merender']);
    expect(shotStatus(storyFor(BOARD), '00-pembuka').label).toBe('Keyframe siap');
    expect(shotStatus(storyFor(BOARD, [], [], { mode: 'cepat', shots: [{ id: '00-pembuka', status: 'pending', attempts: 0 }] }), '00-pembuka').label).toBe('Belum dirender');
    expect(shotStatus(storyFor(BOARD, [], ['failed']), '00-pembuka').label).toBe('Render gagal');
    const tone = (s: ReturnType<typeof storyFor>, id: string) => sceneTone(sceneProgress(s, BOARD, id)).label;
    expect(tone(story, 'menunggu')).toBe('Sedang diproses');
    expect(tone(story, 'pulang')).toBe('Ada yang gagal');
    expect(tone(storyFor(BOARD, [], ['done', 'done']), 'menunggu')).toBe('Klip lengkap');
    expect(tone(storyFor(BOARD), 'menunggu')).toBe('Keyframe siap');
    expect(tone(storyFor(BOARD, ['pending', 'pending']), 'menunggu')).toBe('Belum mulai');
    expect(sceneTone(sceneProgress(storyFor(BOARD), { ...BOARD, scenes: [{ id: 'kosong', title: 'K', shots: [] }] }, 'kosong')).label).toBe('Belum ada shot');
  });
});
