import { describe, expect, it } from 'vitest';
import { estimateWords, wordsFromAlignment } from '../src/dub/words.js';

const align = (text: string, step = 0.1) => ({
  characters: [...text],
  character_start_times_seconds: [...text].map((_, i) => +(i * step).toFixed(3)),
  character_end_times_seconds: [...text].map((_, i) => +((i + 1) * step).toFixed(3))
});

describe('wordsFromAlignment', () => {
  it('turns per-character times into words that start at their first letter and end at their last', () => {
    const w = wordsFromAlignment(align('Halo dunia.'));
    expect(w).toEqual([['Halo', 0, 0.4], ['dunia.', 0.5, 1.1]]);
  });

  it('keeps punctuation attached to its word and never emits blank words for runs of spaces', () => {
    const w = wordsFromAlignment(align('a,  b'))!;
    expect(w.map(x => x[0])).toEqual(['a,', 'b']);
  });

  it('treats a newline as a word break too', () => {
    expect(wordsFromAlignment(align('satu\ndua'))!.map(x => x[0])).toEqual(['satu', 'dua']);
  });

  it('refuses malformed or empty alignments instead of guessing', () => {
    expect(wordsFromAlignment(undefined)).toBeUndefined();
    expect(wordsFromAlignment(null)).toBeUndefined();
    expect(wordsFromAlignment({ characters: ['a', 'b'], character_start_times_seconds: [0], character_end_times_seconds: [0.1] })).toBeUndefined();
    expect(wordsFromAlignment({ characters: [], character_start_times_seconds: [], character_end_times_seconds: [] })).toBeUndefined();
    expect(wordsFromAlignment({ characters: ['a'], character_start_times_seconds: ['x'], character_end_times_seconds: [1] } as never)).toBeUndefined();
  });

  it('never goes backwards in time even when the API reports overlapping characters', () => {
    const w = wordsFromAlignment({ characters: [...'ab cd'], character_start_times_seconds: [0, 0.2, 0.3, 0.25, 0.5], character_end_times_seconds: [0.2, 0.3, 0.35, 0.5, 0.7] })!;
    expect(w[1]![1]).toBeGreaterThanOrEqual(w[0]![2]);
  });
});

describe('estimateWords (for audio rendered before timings were kept)', () => {
  const text = 'Dia diam. Aku menoleh, dan baru mengerti.';
  const w = estimateWords(text, 6)!;

  it('returns every word of the text, in order, with times inside the audio', () => {
    expect(w.map(x => x[0])).toEqual(text.split(' '));
    expect(w[0]![1]).toBeGreaterThanOrEqual(0);
    expect(w[w.length - 1]![2]).toBeLessThanOrEqual(6);
    for (let i = 1; i < w.length; i++) expect(w[i]![1]).toBeGreaterThanOrEqual(w[i - 1]![2]);
  });

  it('gives a longer word more time than a short one', () => {
    const [short, long] = [w.find(x => x[0] === 'Dia')!, w.find(x => x[0] === 'mengerti.')!];
    expect(long[2] - long[1]).toBeGreaterThan(short[2] - short[1]);
  });

  it('leaves a longer pause after a sentence end than between two plain words', () => {
    const gap = (a: string, b: string) => { const x = w.find(v => v[0] === a)!; const y = w.find(v => v[0] === b)!; return y[1] - x[2]; };
    expect(gap('diam.', 'Aku')).toBeGreaterThan(gap('Aku', 'menoleh,') + 0.05);
  });

  it('copes with nothing to say', () => {
    expect(estimateWords('   ', 3)).toBeUndefined();
    expect(estimateWords('halo', 0)).toBeUndefined();
  });
});
