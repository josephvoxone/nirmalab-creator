import { describe, expect, it } from 'vitest';
import { composePrompt, filterTechniques, promptWarnings, type Technique } from './compose.js';

const dolly: Technique = { c: 'camera-movement', s: 'dolly-in', n: 'Dolly In', d: 'Camera moves forward.', p: 'The camera dollies slowly toward [Subject], subtle parallax, no zoom.' };
const orbit: Technique = { c: 'camera-movement', s: 'orbit', n: 'Orbit', d: 'Circles subject.', p: 'The camera orbits [Subject].' };
const low: Technique = { c: 'camera-angles', s: 'low-angle', n: 'Low Angle', d: 'From below.', p: 'Low angle shot looking up at [Subject].' };
const rim: Technique = { c: 'lighting', s: 'rim-light', n: 'Rim Light', d: 'Light from behind.', p: 'Rim light outlines [Subject] against a dark background.' };

describe('composePrompt (Veo: lead with camera)', () => {
  it('teknik kamera di depan, lalu subjek, lalu look/lighting; [Subject] diganti', () => {
    const out = composePrompt('a paper boat on a river', [rim, dolly]);
    expect(out).toBe(
      'The camera dollies slowly toward a paper boat on a river, subtle parallax, no zoom. A paper boat on a river. Rim light outlines the paper boat against a dark background.'
    );
  });

  it('urutan kamera: angle/framing sebelum gerak kamera', () => {
    expect(composePrompt('x', [dolly, low])).toBe('Low angle shot looking up at x. The camera dollies slowly toward the x, subtle parallax, no zoom. X.');
  });

  it('tanpa teknik mengembalikan subjek apa adanya', () => {
    expect(composePrompt('  ombak senja  ', [])).toBe('Ombak senja');
  });

  it('subjek kosong memakai kata ganti netral', () => {
    expect(composePrompt('', [dolly])).toBe('The camera dollies slowly toward the subject, subtle parallax, no zoom.');
  });

  it('teknik duplikat hanya dipakai sekali', () => {
    expect(composePrompt('x', [dolly, dolly])).toBe('The camera dollies slowly toward x, subtle parallax, no zoom. X.');
  });

  it('prompt contoh tanpa [Subject] tidak disuntikkan; dipakai nama tekniknya', () => {
    const example: Technique = { c: 'camera-movement', s: 'dolly-in-shot', n: 'Dolly In Shot', d: 'Moves toward.', p: 'An archivist sits at a desk and notices a letter. Dolly forward.' };
    const golden: Technique = { c: 'lighting', s: 'golden-hour-cinematography', n: 'Golden Hour Cinematography', d: 'Warm low sun.', p: 'A couple walks on a beach at sunset.' };
    const out = composePrompt('a paper boat', [example, golden]);
    expect(out).toBe('Dolly in shot. A paper boat. Golden hour.');
    expect(out).not.toMatch(/archivist|couple/);
  });
});

describe('promptWarnings', () => {
  it('memperingatkan lebih dari satu gerakan kamera', () => {
    expect(promptWarnings([dolly, orbit])).toEqual([expect.stringMatching(/satu gerakan kamera/i)]);
    expect(promptWarnings([dolly, rim])).toEqual([]);
  });
});

describe('filterTechniques', () => {
  it('menyaring per kategori dan kata kunci (nama/deskripsi)', () => {
    const all = [dolly, rim];
    expect(filterTechniques(all, 'lighting', '')).toEqual([rim]);
    expect(filterTechniques(all, 'all', 'forward')).toEqual([dolly]);
    expect(filterTechniques(all, 'all', 'RIM')).toEqual([rim]);
    expect(filterTechniques(all, 'all', '')).toEqual(all);
  });
});
