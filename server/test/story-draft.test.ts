import { describe, expect, it } from 'vitest';
import { draftStoryboard, parseJsonBlock } from '../src/stories/draft.js';
import { validateStoryboard } from '../src/stories/storyboard.js';

const goodShots = [
  { id: 'intro', silent: true, prompt: 'Extreme wide shot, the camera pushes in slowly. A misty valley at sunrise, open sky above.' },
  { id: 'Satu Hadiah', prompt: 'Medium shot, the camera stays still. GIRL hugs CAT on a porch.', narration: 'Mimi kucing kesayangan Sari.' },
  { id: 'pulang', prompt: 'Wide shot, the camera pulls back slowly. GIRL carries CAT home.', narration: 'Mereka pulang bersama.' }
];
const good = JSON.stringify({
  title: 'Kucing Hilang',
  titleCard: { lines: ['KUCING', 'HILANG'], kicker: 'Sebuah Dongeng' },
  characters: { GIRL: 'a seven-year-old girl with a yellow dress', CAT: 'a small orange kitten with a blue collar' },
  shots: goodShots
});

describe('parseJsonBlock', () => {
  it('reads JSON from a fenced or chatty reply', () => {
    expect(parseJsonBlock('Here you go:\n```json\n{"a":1}\n```\nEnjoy')).toEqual({ a: 1 });
    expect(parseJsonBlock('{"a":{"b":2}} trailing')).toEqual({ a: { b: 2 } });
    expect(() => parseJsonBlock('no json')).toThrow();
  });
});

describe('draftStoryboard', () => {
  it('turns a premise into a valid storyboard with house defaults filled in', async () => {
    const calls: string[] = [];
    const board = await draftStoryboard({ premise: 'Kucing hilang lalu ditemukan', shots: 3 }, async (_system, prompt) => {
      calls.push(prompt);
      return '```json\n' + good + '\n```';
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('Kucing hilang lalu ditemukan');
    expect(validateStoryboard(board)).toEqual([]);
    expect(board.shots.map(s => s.id)).toEqual(['00-intro', '01-satu-hadiah', '02-pulang']);
    expect(board.aspect).toBe('9:16');
    expect(board.audio).toContain('{line}');
    expect(board.audioSilent).toBeTruthy();
    expect(board.negative).toMatch(/camera equipment/);
    expect(board.crossfade).toBe(0.3);
    expect(board.titleCard?.lines).toEqual(['KUCING', 'HILANG']);
  });

  it('feeds validation errors back to the model and accepts the fix', async () => {
    const broken = JSON.stringify({ title: 'X', characters: {}, shots: [{ id: 'a', prompt: 'A jib arm rises over the town.', narration: 'Halo.' }] });
    const prompts: string[] = [];
    const board = await draftStoryboard({ premise: 'kota' }, async (_s, prompt) => {
      prompts.push(prompt);
      return prompts.length === 1 ? broken : good;
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/gear/);
    expect(board.title).toBe('Kucing Hilang');
  });

  it('gives up after 3 attempts with the remaining problems', async () => {
    await expect(draftStoryboard({ premise: 'x' }, async () => 'tidak ada json')).rejects.toThrow(/3/);
  });

  it('clamps the requested shot count to 3..12', async () => {
    let seen = '';
    await draftStoryboard({ premise: 'x', shots: 99 }, async (_s, p) => { seen = p; return good; });
    expect(seen).toMatch(/exactly 12 shots/);
  });
});
