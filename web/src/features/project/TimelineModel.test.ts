import { describe, expect, it } from 'vitest';
import { BOARD, ID, storyFor } from './testkit.js';
import { addScene, type Board } from './model.js';
import { boardOrder, nudgeScene, nudgeShot, rulerTicks, sceneKey, sequenceClips, shotKey, timelineDrop, timelineLayout } from './TimelineModel.js';

const order = (b: Board) => b.scenes!.map(s => `${s.id}:${s.shots.join(',')}`).join(' | ');

describe('timelineLayout', () => {
  it('places scenes and clips on one time axis; real clip length wins over the 6 s default', () => {
    const story = storyFor(BOARD, [], ['done', 'pending', 'done', 'failed']);
    story.shots[0]!.durationSec = 8;
    const l = timelineLayout(BOARD, story);
    expect(l.total).toBe(8 + 6 + 6 + 6);
    expect(l.clips.map(c => [c.shotId, c.sceneId, c.start, c.seconds, c.status])).toEqual([
      ['00-pembuka', 'menunggu', 0, 8, 'done'], ['01-pagar', 'menunggu', 8, 6, 'pending'],
      ['02-jalan', 'pulang', 14, 6, 'done'], ['03-peluk', 'pulang', 20, 6, 'failed']
    ]);
    expect(l.scenes.map(s => [s.id, s.start, s.seconds, s.shots])).toEqual([['menunggu', 0, 14, 2], ['pulang', 14, 12, 2]]);
    expect(l.clips[0]!.narration).toBe('—');
    expect(l.clips[1]!.narration).toBe('Jingga menunggu setiap sore.');
  });

  it('an empty board still has a 6 s axis', () => {
    const l = timelineLayout({ ...BOARD, scenes: [], shots: [] });
    expect(l.total).toBe(6);
    expect(l.clips).toEqual([]);
  });
});

describe('rulerTicks', () => {
  it('ticks every 6 s up to and including the end, labelled m:ss', () => {
    expect(rulerTicks(26)).toEqual([{ at: 0, label: '0:00' }, { at: 6, label: '0:06' }, { at: 12, label: '0:12' }, { at: 18, label: '0:18' }, { at: 24, label: '0:24' }]);
    expect(rulerTicks(66).at(-1)).toEqual({ at: 66, label: '1:06' });
  });
});

describe('timelineDrop', () => {
  it('reorders a shot inside its scene (sortable arrayMove semantics)', () => {
    expect(order(timelineDrop(BOARD, shotKey('00-pembuka'), shotKey('01-pagar')))).toBe('menunggu:01-pagar,00-pembuka | pulang:02-jalan,03-peluk');
  });

  it('dropping on a clip of another scene moves the shot into that scene at that place', () => {
    expect(order(timelineDrop(BOARD, shotKey('00-pembuka'), shotKey('02-jalan')))).toBe('menunggu:01-pagar | pulang:02-jalan,00-pembuka,03-peluk');
    expect(order(timelineDrop(BOARD, shotKey('03-peluk'), shotKey('01-pagar')))).toBe('menunggu:00-pembuka,03-peluk,01-pagar | pulang:02-jalan');
    expect(order(timelineDrop(BOARD, shotKey('03-peluk'), shotKey('00-pembuka')))).toBe('menunggu:03-peluk,00-pembuka,01-pagar | pulang:02-jalan');
  });

  it('dropping a shot on a scene band puts it at the nearest edge of that scene (works for empty scenes)', () => {
    expect(order(timelineDrop(BOARD, shotKey('01-pagar'), sceneKey('pulang')))).toBe('menunggu:00-pembuka | pulang:01-pagar,02-jalan,03-peluk');
    expect(order(timelineDrop(BOARD, shotKey('02-jalan'), sceneKey('menunggu')))).toBe('menunggu:00-pembuka,01-pagar,02-jalan | pulang:03-peluk');
    const withEmpty = addScene(BOARD, 'Epilog');
    expect(order(timelineDrop(withEmpty, shotKey('00-pembuka'), sceneKey('scene-3')))).toBe('menunggu:01-pagar | pulang:02-jalan,03-peluk | scene-3:00-pembuka');
  });

  it('drags scene bands to reorder scenes (also when released over one of its clips)', () => {
    expect(order(timelineDrop(BOARD, sceneKey('pulang'), sceneKey('menunggu')))).toBe('pulang:02-jalan,03-peluk | menunggu:00-pembuka,01-pagar');
    expect(order(timelineDrop(BOARD, sceneKey('menunggu'), shotKey('03-peluk')))).toBe('pulang:02-jalan,03-peluk | menunggu:00-pembuka,01-pagar');
  });

  it('no-op for unknown ids, self drops, or no target', () => {
    expect(timelineDrop(BOARD, shotKey('01-pagar'), shotKey('01-pagar'))).toBe(BOARD);
    expect(timelineDrop(BOARD, shotKey('01-pagar'), null)).toBe(BOARD);
    expect(timelineDrop(BOARD, shotKey('nope'), shotKey('01-pagar'))).toBe(BOARD);
    expect(timelineDrop(BOARD, 'junk', shotKey('01-pagar'))).toBe(BOARD);
  });
});

describe('nudgeShot / nudgeScene (the non-drag path)', () => {
  it('swaps inside a scene, crosses into the neighbour scene at its edge, stops at the ends', () => {
    expect(order(nudgeShot(BOARD, '00-pembuka', 1))).toBe('menunggu:01-pagar,00-pembuka | pulang:02-jalan,03-peluk');
    expect(order(nudgeShot(BOARD, '01-pagar', 1))).toBe('menunggu:00-pembuka | pulang:01-pagar,02-jalan,03-peluk');
    expect(order(nudgeShot(BOARD, '02-jalan', -1))).toBe('menunggu:00-pembuka,01-pagar,02-jalan | pulang:03-peluk');
    expect(nudgeShot(BOARD, '00-pembuka', -1)).toBe(BOARD);
    expect(nudgeShot(BOARD, '03-peluk', 1)).toBe(BOARD);
  });

  it('moves scenes left/right', () => {
    expect(order(nudgeScene(BOARD, 'pulang', -1))).toBe('pulang:02-jalan,03-peluk | menunggu:00-pembuka,01-pagar');
    expect(nudgeScene(BOARD, 'menunggu', -1)).toBe(BOARD);
  });

  it('boardOrder fingerprints scene + shot order', () => {
    expect(boardOrder(BOARD)).toBe(boardOrder(timelineDrop(BOARD, shotKey('01-pagar'), shotKey('01-pagar'))));
    expect(boardOrder(BOARD)).not.toBe(boardOrder(nudgeShot(BOARD, '00-pembuka', 1)));
  });
});

describe('sequenceClips', () => {
  it('done shots play their clip, others show the keyframe still (or nothing in fast mode)', () => {
    const story = storyFor(BOARD, ['done', 'done', 'pending', 'done'], ['done', 'pending', 'pending', 'pending']);
    const clips = sequenceClips(ID, BOARD, story);
    expect(clips.map(c => c.id)).toEqual(['00-pembuka', '01-pagar', '02-jalan', '03-peluk']);
    expect(clips[0]!.src).toMatch(`/api/stories/${ID}/shots/00-pembuka/video`);
    // a rendered clip's poster is its own frame (poster endpoint), sized for the player
    expect(clips[0]!.poster).toMatch(new RegExp(`^/api/stories/${ID}/shots/00-pembuka/poster\\?.*w=\\d+`));
    expect(clips[1]!.src).toBeUndefined();
    expect(clips[1]!.poster).toMatch(new RegExp(`^/api/stories/${ID}/shots/01-pagar/frame\\?.*w=\\d+`));
    expect(clips[2]!.poster).toBeUndefined();
    expect(clips[0]!.label).toBe('Shot 1 · Menunggu');
    expect(sequenceClips(ID, BOARD, story, ['02-jalan', '03-peluk']).map(c => c.label)).toEqual(['Shot 3 · Pulang', 'Shot 4 · Pulang']);
  });
});
