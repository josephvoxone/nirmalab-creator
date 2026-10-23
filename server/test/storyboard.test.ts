import { describe, expect, it } from 'vitest';
import { buildShotPrompt, narrationWords, validateStoryboard, type Storyboard } from '../src/stories/storyboard.js';

const board: Storyboard = {
  title: 'Selendang Merah',
  aspect: '9:16',
  characters: { RABBIT: 'a small cream-colored rabbit with a red knitted scarf', GIRL: 'a seven-year-old girl with two black braids' },
  style: 'Style: storybook watercolor.',
  narrator: 'a warm Indonesian female storyteller',
  audio: 'Audio: voice-over by {narrator}, speaking Bahasa Indonesia slowly: "{line}" Quiet ambience.',
  audioSilent: 'Audio: soft wind and strings, no voice.',
  negative: 'Negative prompt: subtitles, camera equipment.',
  shots: [
    { id: '00-intro', silent: true, prompt: 'Extreme wide shot, the camera pushes in slowly. A red scarf drifts over a valley.' },
    { id: '01-hadiah', prompt: 'Medium close-up, the camera pushes in slowly. GIRL holds RABBIT on a porch.', narration: 'Namanya Kapas, kelinci kesayangan Laras.' },
    { id: '02-istana', reuse: { jobId: 'job_0123456789abcdef', start: 1.6 }, prompt: '', narration: '' }
  ]
};

describe('storyboard', () => {
  it('expands character tokens to identical descriptors and appends style, audio, negative', () => {
    const out = buildShotPrompt(board, board.shots[1]!);
    expect(out).toContain(board.characters!.GIRL);
    expect(out).toContain(board.characters!.RABBIT);
    expect(out).not.toMatch(/\b(GIRL|RABBIT)\b/);
    expect(out).toContain('speaking Bahasa Indonesia slowly: "Namanya Kapas, kelinci kesayangan Laras."');
    expect(out.split('\n').at(-1)).toBe(board.negative);
  });

  it('silent shots use audioSilent and need no narration', () => {
    const out = buildShotPrompt(board, board.shots[0]!);
    expect(out).toContain('soft wind and strings, no voice');
    expect(out).not.toContain('voice-over');
  });

  it('accepts a valid storyboard', () => {
    expect(validateStoryboard(board)).toEqual([]);
  });

  it('rejects camera gear, more than one camera move, long or missing narration', () => {
    const bad: Storyboard = {
      ...board,
      shots: [
        { id: 'a', prompt: 'A jib arm lifts above RABBIT.', narration: 'Satu dua.' },
        { id: 'b', prompt: 'The camera pans and the camera zooms on RABBIT.', narration: 'Satu dua.' },
        { id: 'c', prompt: 'RABBIT sits.', narration: 'satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas dua belas tiga' },
        { id: 'd', prompt: 'RABBIT sits.' }
      ]
    };
    const errors = validateStoryboard(bad).join('\n');
    expect(errors).toMatch(/a: .*gear/);
    expect(errors).toMatch(/b: .*camera move/);
    expect(errors).toMatch(/c: .*14 words/);
    expect(errors).toMatch(/d: narration is empty/);
  });

  it('rejects unsafe or duplicate shot ids and empty boards', () => {
    expect(validateStoryboard({ ...board, shots: [] }).join()).toMatch(/no shots/);
    const dup = { ...board, shots: [board.shots[1]!, board.shots[1]!] };
    expect(validateStoryboard(dup).join()).toMatch(/duplicate/);
    const unsafe = { ...board, shots: [{ ...board.shots[1]!, id: '../etc' }] };
    expect(validateStoryboard(unsafe).join()).toMatch(/invalid shot id/);
  });

  it('counts narration words like the 6-second budget expects', () => {
    expect(narrationWords('Ia menunggu dalam hujan. Tapi mobil itu tak pernah kembali.')).toBe(10);
    expect(narrationWords('')).toBe(0);
  });
});
