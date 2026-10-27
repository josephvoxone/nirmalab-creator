import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_STYLE_MAP, LOOK_IDS, LOOKS, compileStyleSentence, lookById,
  type LookId, type StyleBible
} from '../src/bible/styles.js';
import { CATALOG } from '../src/stories/looks.js';

const sentences: Record<string, string> = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'look-sentences.json'), 'utf8'));

const byId = (id: string) => {
  const look = lookById(id);
  if (!look) throw new Error(`lookById(${id}) is undefined`);
  return look;
};

describe('six look families', () => {
  it('has exactly the six family ids, in order, each with a complete bible', () => {
    expect(LOOKS.map(l => l.id)).toEqual(['film-real', 'painterly', 'cel-anime', 'clay', 'docu', 'noir']);
    expect(LOOK_IDS).toEqual(LOOKS.map(l => l.id));
    for (const look of LOOKS) {
      expect(look.family, look.id).toBe(look.id);
      expect(look.variant, look.id).toBe(look.id);
      expect(look.version, look.id).toBe(1);
      expect(look.label.trim(), look.id).not.toBe('');
      expect(look.tags.length, look.id).toBeGreaterThan(0);
      expect(['photoreal', 'illustration', 'stop-motion', 'cel']).toContain(look.medium);
      expect(look.stock.length, look.id).toBeGreaterThan(20);
      expect(look.lenses.length, look.id).toBeGreaterThanOrEqual(2);
      expect(look.aperture, look.id).toMatch(/^f\/\d/);
      expect(look.palette.length, look.id).toBeGreaterThanOrEqual(3);
      for (const p of look.palette) {
        expect(p.hex, look.id).toMatch(/^#[0-9a-f]{6}$/);
        expect(['sky', 'skin', 'ground', 'accent', 'shadow'], look.id).toContain(p.use);
        expect(p.name.trim(), look.id).not.toBe('');
      }
      expect(look.light.key, look.id).not.toBe('');
      expect(look.light.fill, look.id).not.toBe('');
      expect(look.light.rim, look.id).not.toBe('');
      expect(look.light.temp, look.id).toMatch(/K\b/);
      expect(look.light.bestHours.length, look.id).toBeGreaterThan(0);
      expect(look.grain, look.id).not.toBe('');
      expect(look.halation, look.id).not.toBe('');
      expect(['thirds', 'centered', 'low-horizon'], look.id).toContain(look.composition.rule);
      expect(look.composition.headroom, look.id).not.toBe('');
      expect(look.composition.negativeSpace, look.id).not.toBe('');
      expect(look.forbidden.length, look.id).toBeGreaterThanOrEqual(3);
      expect(look.styleSentence, look.id).toBe(compileStyleSentence(look));
    }
  });

  it('keeps the named variants of spec §9.1, every one resolvable to its family', () => {
    expect(byId('painterly').variants.map(v => v.id)).toEqual(['storybook', 'papercut', 'wayang', 'alkitab']);
    expect(byId('cel-anime').variants.map(v => v.id)).toEqual(['comic', 'anime-2d']);
    expect(byId('clay').variants.map(v => v.id)).toEqual(['pixar-3d', 'lowpoly']);
    expect(byId('film-real').variants.map(v => v.id)).toEqual(['docu', 'cinematic-drama']);
    expect(byId('noir').variants.map(v => v.id)).toEqual(['noir']);
    expect(byId('docu').variants).toEqual([]);
    for (const family of LOOKS) {
      for (const variant of family.variants) {
        const look = byId(`${family.id}:${variant.id}`);
        expect(look.family).toBe(family.id);
        expect(look.variant).toBe(variant.id);
        expect(look.label).toBe(variant.label);
        expect(look.styleSentence).toContain(variant.extra);
        // A variant inherits the family grammar verbatim.
        expect(look.stock).toBe(family.stock);
        expect(look.lenses).toBe(family.lenses);
        expect(look.medium).toBe(family.medium);
        // A variant that shares the family id *is* the family look (noir), so its sentence matches.
        if (variant.id !== family.id) expect(look.styleSentence).not.toBe(family.styleSentence);
        else expect(look).toBe(family);
      }
    }
  });

  it('a variant may pin its own composition (alkitab: a full-bleed page with fixed headroom); the others keep the family composition byte for byte', () => {
    const alkitab = byId('painterly:alkitab');
    expect(alkitab.label).toBe('Alkitab bergambar');
    expect(alkitab.styleSentence).toContain('a full-bleed painting that fills the frame edge to edge with no blank paper border');
    expect(alkitab.styleSentence).not.toContain('open wash of plain paper');
    expect(alkitab.composition.headroom).toBe('the same clear headroom above every head');
    // Existing storybook boards: their style sentence (part of every frame/clip hash) is unchanged.
    expect(byId('painterly:storybook').styleSentence).toContain('a centred composition framing, a generous painted sky above the heads, an open wash of plain paper at the edges');
    expect(byId('painterly:storybook').composition).toBe(byId('painterly').composition);
  });

  it('resolves an id collision between a family and a variant deterministically: family wins, "family:variant" is explicit', () => {
    expect(byId('docu').id).toBe('docu');
    expect(byId('docu').medium).toBe('photoreal');
    expect(byId('docu').styleSentence).toContain('documentary camera');
    // "docu" is also a film-real variant; only the qualified form reaches it.
    const variant = byId('film-real:docu');
    expect(variant.family).toBe('film-real');
    expect(variant.variant).toBe('docu');
    expect(variant.styleSentence).toContain('observational handheld');
    // noir's only variant shares the family id: the family already is that variant.
    expect(byId('noir').variant).toBe('noir');
    expect(byId('noir').styleSentence).toContain('venetian-blind');
  });

  it('bare variant ids resolve, unknown and empty ids do not', () => {
    expect(byId('wayang').family).toBe('painterly');
    expect(byId('wayang').variant).toBe('wayang');
    expect(lookById('nope')).toBeUndefined();
    expect(lookById('')).toBeUndefined();
    expect(lookById('painterly:nope')).toBeUndefined();
    expect(lookById('nope:storybook')).toBeUndefined();
  });
});

describe('compileStyleSentence', () => {
  it('is deterministic and returns exactly one English sentence', () => {
    const look = byId('film-real');
    const a = compileStyleSentence(look);
    const b = compileStyleSentence(look);
    expect(a).toBe(b);
    expect(a.endsWith('.')).toBe(true);
    // One sentence: exactly one sentence break (apertures contain decimal points).
    expect(a).not.toMatch(/\.\s/);
    expect(a.match(/\.(\s|$)/g)).toHaveLength(1);
    expect(a.length).toBeGreaterThan(200);
    expect(a.length).toBeLessThanOrEqual(800);
  });

  it('does not mutate the look it is given', () => {
    const look: StyleBible = JSON.parse(JSON.stringify(byId('painterly:papercut')));
    const before = JSON.stringify(look);
    compileStyleSentence(look);
    expect(JSON.stringify(look)).toBe(before);
  });

  it('carries the look constants once: stock, palette hexes, grain, medium, composition (optics and light belong to the shot)', () => {
    for (const look of LOOKS) {
      const text = look.styleSentence;
      expect(text, look.id).toContain(look.stock);
      for (const p of look.palette) expect(text, look.id).toContain(`${p.hex} (${p.use})`);
      expect(text, look.id).toContain(look.grain);
      expect(text, look.id).toContain(look.composition.headroom);
      // Deliberately absent: the compiler emits lens/aperture/light/forbidden once, per shot.
      expect(text, look.id).not.toContain(look.aperture);
      // (lens mm may legitimately appear in the stock, e.g. "Portra 400 on 35mm")
      expect(text, look.id).not.toContain(look.light.key);
      expect(text, look.id).not.toMatch(/avoid /i);
      expect(text.split(/\s+/).length, look.id).toBeLessThanOrEqual(90);
    }
  });

  it('matches the frozen sentences for all six families and ten variants (exact strings)', () => {
    const ids = [...LOOK_IDS, ...LOOKS.flatMap(f => f.variants.map(v => `${f.id}:${v.id}`))];
    if (process.env.UPDATE_GOLDENS !== '1') expect(Object.keys(sentences).sort()).toEqual([...new Set(ids)].sort());
    for (const id of ids) {
      const actual = byId(id).styleSentence;
      if (process.env.UPDATE_GOLDENS === '1') {
        sentences[id] = actual;
        writeFileSync(join(__dirname, 'fixtures', 'look-sentences.json'), JSON.stringify(sentences, null, 2) + '\n');
      }
      expect(actual, id).toBe(sentences[id]);
    }
  });
});

describe('LEGACY_STYLE_MAP', () => {
  it('maps every legacy studio style to an existing family + variant', () => {
    for (const style of CATALOG.styles) {
      expect(LEGACY_STYLE_MAP[style.id], `legacy style ${style.id}`).toBeDefined();
    }
    for (const [style, target] of Object.entries(LEGACY_STYLE_MAP)) {
      const look = lookById(`${target.family}:${target.variant}`);
      expect(look, `${style} → ${target.family}/${target.variant}`).toBeDefined();
      expect(look!.family, style).toBe(target.family);
      expect(look!.variant, style).toBe(target.variant);
      expect(LOOK_IDS, style).toContain(target.family as LookId);
    }
  });

  it('keeps the culturally specific legacy styles reachable as variants', () => {
    expect(LEGACY_STYLE_MAP.wayang).toEqual({ family: 'painterly', variant: 'wayang' });
    expect(LEGACY_STYLE_MAP.papercut).toEqual({ family: 'painterly', variant: 'papercut' });
    expect(LEGACY_STYLE_MAP.storybook).toEqual({ family: 'painterly', variant: 'storybook' });
    expect(LEGACY_STYLE_MAP.comic).toEqual({ family: 'cel-anime', variant: 'comic' });
    expect(LEGACY_STYLE_MAP['anime-2d']).toEqual({ family: 'cel-anime', variant: 'anime-2d' });
    expect(LEGACY_STYLE_MAP['pixar-3d']).toEqual({ family: 'clay', variant: 'pixar-3d' });
    expect(LEGACY_STYLE_MAP.lowpoly).toEqual({ family: 'clay', variant: 'lowpoly' });
    expect(LEGACY_STYLE_MAP.claymation).toEqual({ family: 'clay', variant: 'clay' });
    expect(LEGACY_STYLE_MAP['live-action']).toEqual({ family: 'film-real', variant: 'cinematic-drama' });
    expect(LEGACY_STYLE_MAP.documentary).toEqual({ family: 'docu', variant: 'docu' });
    // Every mapped look compiles a sentence that differs from its family only when it is a variant.
    expect(byId('wayang').styleSentence).not.toBe(byId('painterly').styleSentence);
    expect(byId('clay').styleSentence).toContain('plasticine');
    expect(byId('docu:docu').styleSentence).toBe(byId('docu').styleSentence);
  });
});
