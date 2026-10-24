import { describe, expect, it } from 'vitest';
import { validateBible } from '../src/bible/story.js';
import { resolveLook } from '../src/stories/looks.js';

const base = {
  logline: 'Seorang nelayan kehilangan perahunya.',
  theme: 'Ketekunan', tone: 'Hangat dan tenang', audience: 'umum' as const,
  structure: [
    { act: 'hook' as const, goal: 'Perahu hilang' },
    { act: 'setup' as const, goal: 'Mencari bahan' },
    { act: 'turn' as const, goal: 'Badai kedua' },
    { act: 'payoff' as const, goal: 'Perahu baru' }
  ],
  characters: [], locations: [], scenes: [], rules: { maxShotSec: 6, narrationMaxWords: 12 }
};

describe('faceless stories may carry a bible', () => {
  it('accepts a bible with no characters (faceless / cepat)', () => {
    expect(validateBible(base)).toEqual([]);
  });

  it('still rejects a character card without want/need or with only generic anchors', () => {
    const errors = validateBible({ ...base, characters: [{ token: 'TOMI', name: 'Tomi', anchors: ['megah', 'indah'], want: 'pulang', need: '', arc: '' }] });
    expect(errors.join(' ')).toMatch(/need|anchor/i);
  });
});

describe('look keeps the family/variant pair', () => {
  it('passes a valid pair through and drops an unknown one', () => {
    const look = resolveLook({ look: { style: 'storybook', family: 'painterly', variant: 'wayang' } });
    expect(look).toMatchObject({ style: 'storybook', family: 'painterly', variant: 'wayang' });
    const bad = resolveLook({ look: { style: 'storybook', family: 'nope', variant: 'nope' } });
    expect(bad.family).toBeUndefined();
    expect(bad.variant).toBeUndefined();
  });
});
