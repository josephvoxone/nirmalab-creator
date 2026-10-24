import { describe, expect, it } from 'vitest';
import { compileStyleSentence, lookById } from '../src/bible/styles.js';
import { compileShot } from '../src/bible/compiler.js';

const bible = {
  logline: 'Nelayan tua membangun perahu baru dengan cucunya.', theme: 'Ketekunan', tone: 'Hangat', audience: 'umum' as const,
  structure: [{ act: 'hook' as const, goal: 'Badai' }, { act: 'setup' as const, goal: 'Bahan' }, { act: 'turn' as const, goal: 'Badai kedua' }, { act: 'payoff' as const, goal: 'Perahu baru' }],
  characters: [{ token: 'PAK_TUA', name: 'Pak Tua', anchors: ['kulit gelap', 'topi jerami lebar', 'kemeja lusuh biru'], want: 'melaut', need: 'menerima bantuan', arc: 'terbuka' }],
  locations: [{ key: 'PANTAI', name: 'Pantai', plate: 'pasir vulkanik hitam, ombak pelan' }],
  scenes: [{ id: 'scene-1', title: 'Pantai', goal: 'Kehilangan', location: 'PANTAI' }],
  rules: { maxShotSec: 6, narrationMaxWords: 12 }
};

const shot = {
  id: '00-hilang', framing: 'wide', move: 'static', narration: 'Perahunya hilang semalam.',
  subject: 'PAK_TUA', action: 'berdiri memandang laut kosong',
  startState: 'berdiri tegak', endState: 'bahu turun, menggenggam tali'
};

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('compiled prompt is not repetitive', () => {
  it('state the light and optics once, not again inside the style sentence', () => {
    const look = lookById('film-real:cinematic-drama')!;
    const out = compileShot({ look, bible, scene: bible.scenes[0], shot } as never);
    for (const text of [out.imagePrompt, out.videoPrompt]) {
      expect(count(text, look.light.key)).toBe(1);
      expect(count(text, look.aperture)).toBe(1);
      expect(count(text, look.stock)).toBe(1);
    }
  });

  it('keep the negative list in one place only', () => {
    const look = lookById('film-real:cinematic-drama')!;
    const out = compileShot({ look, bible, scene: bible.scenes[0], shot } as never);
    expect(out.imagePrompt).not.toMatch(/Negative:/);
    expect(count(out.videoPrompt, 'Negative:')).toBe(1);
    expect(count(out.videoPrompt, 'watermark')).toBeLessThanOrEqual(2);
  });

  it('stays within a focused length (<= 150 words for a still; the point is no redundancy)', () => {
    for (const id of ['film-real:cinematic-drama', 'painterly:storybook', 'cel-anime:comic', 'clay:pixar-3d', 'docu:docu', 'noir:noir']) {
      const out = compileShot({ look: lookById(id)!, bible, scene: bible.scenes[0], shot } as never);
      expect(out.imagePrompt.split(/\s+/).length, id).toBeLessThanOrEqual(150);
    }
  });

  it('the style sentence is identical for every shot of the same look, and carries no per-shot optics', () => {
    const look = lookById('painterly:wayang')!;
    const sentence = compileStyleSentence(look);
    expect(compileStyleSentence(look)).toBe(sentence);
    expect(sentence).not.toMatch(new RegExp(look.light.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(sentence).not.toContain(look.aperture);
    expect(sentence).toContain(look.stock);
    expect(sentence).toMatch(/Palette|palette/);
  });
});
