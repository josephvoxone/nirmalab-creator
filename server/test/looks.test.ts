import { describe, expect, it } from 'vitest';
import { CATALOG, TEMPLATE_CATEGORIES, composeStyle, resolveLook, setShotSetup } from '../src/stories/looks.js';
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

const ORIGINAL_TEMPLATE_IDS = [
  'drama-hewan', 'dongeng-anak', 'fabel-3d', 'legenda-nusantara', 'anime-petualangan', 'misteri-malam',
  'claymation-lucu', 'fakta-faceless', 'motivasi', 'promo-produk', 'romansa-kota'
];
const CATEGORY_IDS = ['drama', 'anak', 'faceless', 'promo', 'edukasi', 'horor', 'budaya'];
const INDONESIAN = /\b(yang|dan|di|ke|dari|dengan|untuk|ini|itu|seorang|seekor|setiap|sampai|lalu|tentang|bersama|cara|tahun|tidak|ada)\b/i;
const INDONESIAN_STOPWORDS = /\b(yang|dan|dengan|untuk|seorang|seekor|sampai|tidak)\b/i;
const ENGLISH = /\b(a|an|the|of|in|on|with|at|and|beside|under|through)\b/i;

describe('template catalogue', () => {
  it('keeps the original 11 template ids and grows to about 30', () => {
    const all = ids(CATALOG.templates);
    for (const id of ORIGINAL_TEMPLATE_IDS) expect(all).toContain(id);
    expect(all.length).toBeGreaterThanOrEqual(28);
    expect(all.length).toBeLessThanOrEqual(36);
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('exposes the category list with Indonesian labels, every category in use', () => {
    expect(ids(TEMPLATE_CATEGORIES)).toEqual(CATEGORY_IDS);
    expect(CATALOG.categories).toBe(TEMPLATE_CATEGORIES);
    for (const c of TEMPLATE_CATEGORIES) {
      expect(c.label.length).toBeGreaterThan(2);
      expect(CATALOG.templates.filter(t => t.category === c.id).length, c.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('every template field is valid: look ids exist, aspect, mode, narrator, category', () => {
    const lists = {
      style: CATALOG.styles, genre: CATALOG.genres, era: CATALOG.eras, camera: CATALOG.cameras, lens: CATALOG.lenses,
      aperture: CATALOG.apertures, palette: CATALOG.palettes, lighting: CATALOG.lighting, tempo: CATALOG.tempos
    } as const;
    for (const t of CATALOG.templates) {
      for (const [key, list] of Object.entries(lists)) {
        expect(ids(list as { id: string }[]), `${t.id}.look.${key}`).toContain(t.look[key as keyof typeof lists]);
      }
      expect(Object.keys(t.look).sort(), t.id).toEqual(Object.keys(lists).sort());
      expect(['9:16', '16:9', '1:1'], t.id).toContain(t.aspect);
      expect(['konsisten', 'cepat'], t.id).toContain(t.mode);
      expect(CATEGORY_IDS, t.id).toContain(t.category);
      expect(t.narrator, t.id).toMatch(/Indonesian/);
      if (t.category === 'faceless') expect(t.mode, `${t.id} is faceless`).toBe('cepat');
      // resolveLook must round-trip the template's own look unchanged (no silent fallback to auto).
      expect(resolveLook({ template: t.id }), t.id).toEqual(t.look);
    }
  });

  it('copy is Indonesian, covers are one English cinematic sentence without text, brands or celebrities', () => {
    const covers = new Set<string>();
    for (const t of CATALOG.templates) {
      expect(t.name.trim().length, t.id).toBeGreaterThan(3);
      expect(t.name.length, t.id).toBeLessThanOrEqual(24);
      expect(t.tagline.trim().length, t.id).toBeGreaterThan(10);
      expect(t.tagline.length, t.id).toBeLessThanOrEqual(60);
      expect(t.example, t.id).toMatch(INDONESIAN);
      expect(t.example.length, t.id).toBeGreaterThan(60);
      expect(t.example.length, t.id).toBeLessThanOrEqual(320);
      expect(t.example.split(/(?<=[.!?])\s+/).filter(Boolean).length, t.id).toBeLessThanOrEqual(2);

      const cover = t.cover.trim();
      expect(cover.length, t.id).toBeGreaterThan(40);
      expect(cover.length, t.id).toBeLessThanOrEqual(220);
      expect(cover, t.id).toMatch(ENGLISH);
      expect(cover, t.id).not.toMatch(INDONESIAN_STOPWORDS);
      expect(cover, t.id).toMatch(/^[A-Z].*\.$/);
      expect(cover.slice(0, -1), `${t.id}: one sentence`).not.toMatch(/[.!?]\s/);
      expect(cover, t.id).not.toMatch(/\b(text|caption|subtitle|logo|title|lettering|words?|sign that reads)\b/i);
      expect(cover, t.id).not.toMatch(/\b(nike|adidas|apple|samsung|coca|starbucks|disney|pixar|marvel|instagram|tiktok|youtube)\b/i);
      expect(covers.has(cover), `${t.id}: duplicate cover`).toBe(false);
      covers.add(cover);
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
