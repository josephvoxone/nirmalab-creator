import { describe, expect, it } from 'vitest';
import { CATALOG, composeStyle, resolveLook, setShotSetup } from '../src/stories/looks.js';
import { validateStoryboard } from '../src/stories/storyboard.js';

const ids = <T extends { id: string }>(xs: T[]) => xs.map(x => x.id);

describe('looks catalog', () => {
  it('is complete enough to pick from like a studio', () => {
    expect(CATALOG.templates.length).toBeGreaterThanOrEqual(10);
    expect(CATALOG.styles.length).toBeGreaterThanOrEqual(8);
    expect(CATALOG.genres.length).toBeGreaterThanOrEqual(8);
    expect(CATALOG.palettes.length).toBeGreaterThanOrEqual(16);
    expect(CATALOG.lighting.length).toBeGreaterThanOrEqual(10);
    expect(CATALOG.moves.length).toBeGreaterThanOrEqual(20);
    expect(CATALOG.framings.length).toBeGreaterThanOrEqual(7);
    for (const list of Object.values(CATALOG)) expect(new Set(ids(list as { id: string }[])).size).toBe((list as unknown[]).length);
  });

  it('every template points at existing options and has an Indonesian example premise', () => {
    for (const t of CATALOG.templates) {
      expect(ids(CATALOG.styles)).toContain(t.look.style);
      expect(ids(CATALOG.genres)).toContain(t.look.genre);
      expect(ids(CATALOG.palettes)).toContain(t.look.palette);
      expect(ids(CATALOG.lighting)).toContain(t.look.lighting);
      expect(ids(CATALOG.tempos)).toContain(t.look.tempo);
      expect(t.example.length).toBeGreaterThan(40);
      expect(['konsisten', 'cepat']).toContain(t.mode);
    }
  });

  it('palettes carry 6 swatches for the picker', () => {
    for (const p of CATALOG.palettes.filter(p => p.id !== 'auto')) {
      expect(p.swatches).toHaveLength(6);
      for (const c of p.swatches) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('every camera move is Veo-safe: one move at most, never camera gear', () => {
    for (const m of CATALOG.moves) {
      const board = { title: 't', shots: [{ id: 'a', prompt: setShotSetup('A girl walks home.', 'medium', m.id), narration: 'Halo.' }] };
      expect(validateStoryboard(board), m.id).toEqual([]);
    }
  });
});

describe('composeStyle', () => {
  it('turns picked options into one Style line and skips Auto', () => {
    const s = composeStyle({ style: 'storybook', genre: 'drama', era: 'auto', camera: 'auto', lens: 'halation', aperture: 'f14', palette: 'senja-dongeng', lighting: 'golden-hour' });
    expect(s.startsWith('Style: ')).toBe(true);
    expect(s).toMatch(/watercolor/i);
    expect(s).toMatch(/emotional drama/i);
    expect(s).toMatch(/halation/i);
    expect(s).toMatch(/shallow depth of field/i);
    expect(s).toMatch(/Color grade:/);
    expect(s).toMatch(/golden hour/i);
    expect(s).not.toMatch(/auto/i);
  });

  it('resolveLook: template defaults, explicit picks win, unknown ids fall back to auto', () => {
    const look = resolveLook({ template: 'dongeng-anak', look: { palette: 'noir', lens: 'nope' } });
    const t = CATALOG.templates.find(x => x.id === 'dongeng-anak')!;
    expect(look.style).toBe(t.look.style);
    expect(look.palette).toBe('noir');
    expect(look.lens).toBe('auto');
  });
});

describe('setShotSetup', () => {
  it('replaces the framing + move sentence, keeps the action', () => {
    const p = setShotSetup('Medium shot, the camera stays still. LARAS hugs KAPAS on the porch.', 'close-up', 'push-in');
    expect(p).toBe('Close-up, the camera pushes in slowly. LARAS hugs KAPAS on the porch.');
  });

  it('prepends a setup when the prompt has none', () => {
    expect(setShotSetup('KAPAS waits in the rain.', 'wide', 'static')).toBe('Wide shot, the camera stays still. KAPAS waits in the rain.');
  });
});
