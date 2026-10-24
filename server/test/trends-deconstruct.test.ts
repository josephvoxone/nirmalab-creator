/**
 * Deconstruction + clone brief (spec §4.5, §9.8). Fixtures are the recorded source shapes, so
 * the numbers here are the numbers a real card would produce.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateBible } from '../src/bible/story.js';
import { ShotCompileError } from '../src/bible/compiler.js';
import { compileBoardShot, validateStoryboard } from '../src/stories/storyboard.js';
import {
  MAX_CLONE_SHOTS,
  MIN_CLONE_SHOTS,
  avgShotFor,
  beatMarks,
  briefToStoryboard,
  callToAction,
  cloneBrief,
  deconstruct,
  durationOf,
  shotCountFor,
  suggestLook
} from '../src/trends/deconstruct.js';
import { enrichSeeds } from '../src/trends/pipeline.js';
import { mapYouTubeVideo } from '../src/trends/youtube.js';
import type { TrendItem } from '../src/trends/types.js';

const NOW = 1_792_929_600_000;

const fixture = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(new URL(`./fixtures/trends/${name}`, import.meta.url), 'utf8')) as Record<string, any>;

/** A real card: the YouTube fixture through the same mapper the source uses. */
function youtubeItems(): TrendItem[] {
  const listing = fixture('youtube-popular.json');
  const durations: Record<string, number> = {};
  for (const item of fixture('youtube-durations.json').items) {
    durations[item.id] = item.contentDetails.duration === 'PT42S' ? 42 : item.contentDetails.duration === 'PT3M18S' ? 198 : 3_723;
  }
  const seeds = (listing.items as Record<string, unknown>[])
    .map(video => mapYouTubeVideo(video as never, 'ID', durations))
    .filter((seed): seed is NonNullable<typeof seed> => !!seed);
  return enrichSeeds(seeds, { region: 'ID', windowHours: 720, niche: 'ai', nowMs: NOW });
}

describe('pacing arithmetic', () => {
  it('estimates shot count as duration / 3.5, clamped to 4–14', () => {
    expect(shotCountFor(21)).toBe(6); // 6 exactly
    expect(shotCountFor(10)).toBe(MIN_CLONE_SHOTS); // 2.86 → 3 → clamped up
    expect(shotCountFor(60)).toBe(MAX_CLONE_SHOTS); // 17.1 → clamped down
    expect(shotCountFor(42)).toBe(12);
  });

  it('falls back to 15 s when the source gave no duration', () => {
    expect(durationOf(0)).toBe(15);
    expect(durationOf(Number.NaN)).toBe(15);
    expect(durationOf(undefined)).toBe(15);
    expect(shotCountFor(0)).toBe(4);
    expect(avgShotFor(0)).toBe(3.8);
  });

  it('puts the beats at 0 / 20% / 55% / 80% of the runtime', () => {
    expect(beatMarks(21).map(mark => mark.atSec)).toEqual([0, 4.2, 11.6, 16.8]);
    expect(beatMarks(21).map(mark => mark.beat)).toEqual(['hook', 'setup', 'turn', 'payoff']);
  });

  it('reports the average cut of the shots it would actually shoot', () => {
    expect(avgShotFor(21)).toBe(3.5);
    expect(avgShotFor(10)).toBe(2.5);
    expect(avgShotFor(60)).toBe(4.3);
  });
});

describe('hook inference', () => {
  it('reads a question from a question mark or an interrogative opener', () => {
    expect(deconstruct({ title: 'Kenapa AI bikin film terasa aneh?', durationSec: 21 }).hook).toBe('pertanyaan');
    expect(deconstruct({ title: 'How to shoot a reel in 20 minutes', durationSec: 21 }).hook).toBe('pertanyaan');
  });

  it('reads POV, before/after, text hook and visual surprise', () => {
    expect(deconstruct({ title: 'POV: kamu bangun dan poster bergerak', durationSec: 21 }).hook).toBe('pov');
    expect(deconstruct({ title: 'Before vs after: meja kerja jadi hutan mini', durationSec: 14 }).hook).toBe('before-after');
    expect(deconstruct({ title: '3 HAL YANG BIKIN VIDEO MAHAL', durationSec: 21 }).hook).toBe('teks-hook');
    expect(deconstruct({ title: 'Kucing pulang kampung', durationSec: 21 }).hook).toBe('kejutan-visual');
  });

  it('a question wins over a text-hook marker, because the first frame asks', () => {
    expect(deconstruct({ title: 'TERNYATA ini yang bikin AI kelihatan palsu?', durationSec: 21 }).hook).toBe('pertanyaan');
  });
});

describe('caption style', () => {
  it('honours an explicit "tanpa caption"', () => {
    expect(deconstruct({ title: '3 hal bikin video mahal', description: 'Tanpa caption, cuma teks besar.', durationSec: 21 }).captionStyle).toBe('tanpa-caption');
  });

  it('reads uppercase emphasis as big on-screen text', () => {
    expect(deconstruct({ title: 'STOP PAKAI PROMPT INI', durationSec: 21 }).captionStyle).toBe('teks-besar');
  });

  it('uses the transcript speaking rate: fast = moving captions, slow = tidy subtitles', () => {
    const fast = Array.from({ length: 40 }, (_, i) => `kata${i}`).join(' ');
    expect(deconstruct({ title: 'Cerita pagi', durationSec: 10, transcript: fast }).captionStyle).toBe('caption-bergerak');
    expect(deconstruct({ title: 'Cerita pagi', durationSec: 21, transcript: 'kancil berjalan ke tepi sungai' }).captionStyle).toBe('subtitle-rapi');
  });

  it('says "tanpa-caption" when there is no transcript and no emphasis', () => {
    expect(deconstruct({ title: 'Kucing pulang kampung', durationSec: 21 }).captionStyle).toBe('tanpa-caption');
  });
});

describe('audio inference', () => {
  it('reads a trending sound, a voice-over, silence and plain music', () => {
    expect(deconstruct({ title: 'Masak cepat', description: 'Sound tren 2026, no caption', durationSec: 21 }).audioType).toBe('sound-tren');
    expect(deconstruct({ title: 'Dongeng kancil', description: 'Ada voice over hangat', durationSec: 21 }).audioType).toBe('vo');
    expect(deconstruct({ title: 'B-roll hutan', description: 'Tanpa audio, cuma visual', durationSec: 21 }).audioType).toBe('tanpa-audio');
    expect(deconstruct({ title: 'B-roll hutan', durationSec: 21 }).audioType).toBe('musik');
  });

  it('reads "tanpa narasi" as music, not as a voice-over', () => {
    expect(deconstruct({ title: 'Meja kerja jadi hutan', description: 'Tanpa narasi, cuma musik.', durationSec: 14 }).audioType).toBe('musik');
  });

  it('treats a spoken transcript as a voice-over even when nobody wrote "VO"', () => {
    const transcript = 'kancil berjalan ke tepi sungai lalu melihat bulan di air yang tenang sekali';
    expect(deconstruct({ title: 'Dongeng', durationSec: 21, transcript }).audioType).toBe('vo');
  });
});

describe('call to action', () => {
  it('returns the sentence that asks for something', () => {
    expect(callToAction('Kamar jadi hutan mini. Simpan buat ide! Follow part 2.')).toBe('Simpan buat ide!');
    expect(callToAction('Kamar jadi hutan mini.')).toBeUndefined();
  });

  it('is carried on the deconstruction when present', () => {
    expect(deconstruct({ title: 'Kamar hutan', description: 'Kamar jadi hutan. Follow buat part 2.', durationSec: 21 }).cta).toBe('Follow buat part 2.');
  });
});

describe('look suggestion', () => {
  it('picks a family and variant the bible compiler knows', () => {
    expect(suggestLook('dongeng anak sebelum tidur')).toMatchObject({ family: 'painterly', variant: 'storybook' });
    expect(suggestLook('anime 2d opening')).toMatchObject({ family: 'cel-anime', variant: 'anime-2d' });
    expect(suggestLook('clay stop motion lucu')).toMatchObject({ family: 'clay', variant: 'pixar-3d' });
    expect(suggestLook('dokumenter vlog pasar')).toMatchObject({ family: 'docu', variant: 'docu' });
    expect(suggestLook('misteri noir malam')).toMatchObject({ family: 'noir', variant: 'noir' });
    expect(suggestLook('tren film pendek sinematik')).toMatchObject({ family: 'film-real', variant: 'cinematic-drama' });
  });
});

describe('clone brief', () => {
  it('copies the structure, not the story: same beats, new title, empty shots', () => {
    const item = youtubeItems().find(candidate => candidate.durationSec === 42)!;
    const brief = cloneBrief(item);

    expect(brief.sourceId).toBe(`youtube:${item.id}`);
    expect(brief.title).toBe(`${item.title} (versi baru)`);
    expect(brief.durationEstimated).toBe(false);
    expect(brief.beats).toEqual(item.beats);
    expect(brief.shots).toHaveLength(item.shotCount);
    expect(brief.shots.map(shot => shot.id)).toEqual(brief.scenes.flatMap(scene => scene.shots));
    expect(new Set(brief.shots.map(shot => shot.id)).size).toBe(brief.shots.length);
    expect(brief.shots[0]).toMatchObject({ id: '00-hook', beat: 'hook', atSec: 0 });
    expect(brief.scenes.map(scene => scene.id)).toEqual(['hook', 'setup', 'turn', 'payoff']);
    // Every act carries a goal in Indonesian, and the hook is the trend's own hook kind.
    for (const scene of brief.scenes) expect(scene.goal.length).toBeGreaterThan(20);
    expect(brief.structure.map(beat => beat.act)).toEqual(['hook', 'setup', 'turn', 'payoff']);
    expect(brief.structure[0]!.goal).toContain('Pertanyaan');
  });

  it('is deterministic: the same card yields the same brief', () => {
    const item = youtubeItems()[0]!;
    expect(cloneBrief(item)).toEqual(cloneBrief(item));
  });

  it('falls back to the 15 s pacing when the trend has no duration (a board phrase)', () => {
    const phrase: TrendItem = {
      ...youtubeItems()[0]!,
      id: 'hot-film-pendek-ai',
      durationSec: 0,
      shotCount: 4,
      avgShotSec: 3.8,
      beats: beatMarks(0)
    };
    const brief = cloneBrief(phrase);
    expect(brief.durationEstimated).toBe(true);
    expect(brief.shots).toHaveLength(4);
    expect(brief.beats.map(beat => beat.atSec)).toEqual([0, 3, 8.3, 12]);
  });
});

describe('clone brief → storyboard', () => {
  function cloned() {
    const item = youtubeItems().find(candidate => candidate.durationSec === 42)!;
    const brief = cloneBrief(item);
    return { brief, board: briefToStoryboard(brief) };
  }

  it('produces a draft the story service accepts (bible + board both valid)', () => {
    const { board } = cloned();
    expect(validateBible(board.bible)).toEqual([]);
    expect(validateStoryboard(board)).toEqual([]);
    expect(board.mode).toBe('cepat');
    expect(board.aspect).toBe('9:16');
    expect(board.look).toEqual({ family: 'film-real', variant: 'cinematic-drama' });
  });

  it('leaves every shot empty, and the render gate refuses it until a human fills it', () => {
    const { board } = cloned();
    expect(board.shots).toHaveLength(12);
    for (const shot of board.shots) {
      expect(shot.intent).toEqual({ subject: '', action: '', startState: '', endState: '' });
      expect(shot.prompt).toBe('');
    }
    // Spec §9.8: loose at save, strict at render — the compiler is the gate.
    expect(() => compileBoardShot(board, board.shots[0]!)).toThrow(ShotCompileError);
  });

  it('carries the bible: structure with hook and payoff, one scene per act', () => {
    const { brief, board } = cloned();
    const bible = board.bible!;
    expect(bible.structure.map(beat => beat.act)).toEqual(['hook', 'setup', 'turn', 'payoff']);
    expect(bible.scenes.map(scene => scene.id)).toEqual(brief.scenes.map(scene => scene.id));
    expect(bible.characters).toEqual([]); // faceless clone: no cast invented
    expect(bible.audience).toBe('umum');
    expect(board.scenes!.map(scene => scene.shots.length).reduce((a, b) => a + b, 0)).toBe(12);
  });

  it('a kids niche drafts for anak', () => {
    const item = youtubeItems()[0]!;
    const board = briefToStoryboard(cloneBrief(item), { niche: 'anak' });
    expect(board.bible!.audience).toBe('anak');
    expect(validateBible(board.bible)).toEqual([]);
  });
});
