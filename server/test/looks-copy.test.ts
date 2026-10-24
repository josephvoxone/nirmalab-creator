/**
 * P4: the 33 template cards must read like a shelf of real stories, not like AI copy.
 *
 * Identity (id, category, family/variant, mode, aspect, narrator, name) is frozen: the
 * rewrite only touches `tagline`, `cover` and the slop words inside `example`.
 */
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../src/stories/looks.js';
import { BANNED_WORDS, AI_TELLS, hookScore, lintCopy, lintCover } from '../src/text/lint.js';

/** id, category, family, variant, mode, aspect, narrator, name — exactly as shipped in P1. */
const IDENTITY: Array<[string, string, string, string, 'konsisten' | 'cepat', string, string, string]> = [
  ['drama-hewan', 'drama', 'painterly', 'storybook', 'konsisten', '9:16', 'a warm, gentle Indonesian female storyteller', 'Drama Hewan'],
  ['dongeng-anak', 'anak', 'painterly', 'storybook', 'konsisten', '9:16', "a cheerful, soft Indonesian children's storyteller", 'Dongeng Tidur'],
  ['fabel-3d', 'anak', 'clay', 'pixar-3d', 'konsisten', '9:16', "a cheerful, soft Indonesian children's storyteller", 'Fabel 3D'],
  ['legenda-nusantara', 'budaya', 'painterly', 'wayang', 'konsisten', '9:16', 'a warm, gentle Indonesian female storyteller', 'Legenda Nusantara'],
  ['anime-petualangan', 'drama', 'cel-anime', 'anime-2d', 'konsisten', '9:16', 'a warm, gentle Indonesian female storyteller', 'Petualangan Anime'],
  ['misteri-malam', 'horor', 'film-real', 'cinematic-drama', 'konsisten', '9:16', 'a hushed, low Indonesian male storyteller', 'Misteri Malam'],
  ['claymation-lucu', 'anak', 'clay', 'clay', 'konsisten', '9:16', "a cheerful, soft Indonesian children's storyteller", 'Claymation Lucu'],
  ['fakta-faceless', 'faceless', 'docu', 'docu', 'cepat', '9:16', 'a calm, deep Indonesian male documentary narrator', 'Fakta Unik'],
  ['motivasi', 'faceless', 'film-real', 'cinematic-drama', 'cepat', '9:16', 'an energetic, confident Indonesian male speaker', 'Motivasi Pagi'],
  ['promo-produk', 'promo', 'film-real', 'cinematic-drama', 'cepat', '9:16', 'an energetic, confident Indonesian male speaker', 'Promo Produk'],
  ['romansa-kota', 'drama', 'cel-anime', 'anime-2d', 'konsisten', '9:16', 'a warm, gentle Indonesian female storyteller', 'Romansa Kota'],
  ['perjuangan-ibu', 'drama', 'film-real', 'cinematic-drama', 'konsisten', '9:16', 'a warm, gentle Indonesian female storyteller', 'Perjuangan Ibu'],
  ['romansa-sekolah', 'drama', 'cel-anime', 'anime-2d', 'konsisten', '9:16', 'a warm, gentle Indonesian female storyteller', 'Romansa Sekolah'],
  ['komedi-keluarga', 'drama', 'clay', 'pixar-3d', 'konsisten', '9:16', 'a playful, witty Indonesian male storyteller', 'Komedi Keluarga'],
  ['sci-fi-pendek', 'drama', 'film-real', 'cinematic-drama', 'konsisten', '9:16', 'a hushed, low Indonesian male storyteller', 'Sci-Fi Pendek'],
  ['cinta-dewasa', 'drama', 'film-real', 'cinematic-drama', 'konsisten', '9:16', 'a warm, gentle Indonesian female storyteller', 'Cinta Dewasa'],
  ['fabel-nusantara', 'anak', 'painterly', 'papercut', 'konsisten', '9:16', "a cheerful, soft Indonesian children's storyteller", 'Fabel Nusantara'],
  ['lagu-anak', 'anak', 'clay', 'lowpoly', 'konsisten', '9:16', "a bright, sing-song Indonesian children's singer", 'Lagu Anak'],
  ['fakta-antariksa', 'faceless', 'film-real', 'cinematic-drama', 'cepat', '9:16', 'a calm, deep Indonesian male documentary narrator', 'Fakta Antariksa'],
  ['misteri-sejarah', 'faceless', 'docu', 'docu', 'cepat', '9:16', 'a hushed, low Indonesian male storyteller', 'Misteri Sejarah'],
  ['motivasi-stoik', 'faceless', 'film-real', 'cinematic-drama', 'cepat', '9:16', 'a calm, measured, deep Indonesian male voice', 'Stoik Harian'],
  ['tips-keuangan', 'faceless', 'clay', 'lowpoly', 'cepat', '9:16', 'a friendly, upbeat Indonesian female presenter', 'Tips Keuangan'],
  ['resep-masakan', 'faceless', 'film-real', 'cinematic-drama', 'cepat', '9:16', 'a friendly, upbeat Indonesian female presenter', 'Resep Kilat'],
  ['asmr-alam', 'faceless', 'docu', 'docu', 'cepat', '9:16', 'a soft, slow, near-whispering Indonesian female voice', 'Suara Alam'],
  ['ulasan-produk', 'promo', 'film-real', 'cinematic-drama', 'cepat', '9:16', 'a friendly, upbeat Indonesian female presenter', 'Ulasan Produk'],
  ['kisah-umkm', 'promo', 'film-real', 'cinematic-drama', 'konsisten', '9:16', 'a warm, gentle Indonesian female storyteller', 'Kisah UMKM'],
  ['belajar-angka-huruf', 'edukasi', 'clay', 'clay', 'cepat', '9:16', "a cheerful, soft Indonesian children's storyteller", 'Belajar Angka & Huruf'],
  ['sains-anak', 'edukasi', 'clay', 'pixar-3d', 'konsisten', '9:16', "a cheerful, soft Indonesian children's storyteller", 'Sains Cilik'],
  ['sejarah-singkat', 'edukasi', 'film-real', 'cinematic-drama', 'cepat', '9:16', 'a calm, deep Indonesian male documentary narrator', 'Sejarah Singkat'],
  ['urban-legend', 'horor', 'film-real', 'cinematic-drama', 'konsisten', '9:16', 'a hushed, low Indonesian male storyteller', 'Legenda Urban'],
  ['kasus-misteri', 'horor', 'film-real', 'cinematic-drama', 'cepat', '9:16', 'a hushed, low Indonesian male storyteller', 'Kasus Misteri'],
  ['silat-nusantara', 'budaya', 'film-real', 'cinematic-drama', 'konsisten', '9:16', 'a deep, resonant Indonesian male storyteller', 'Silat Nusantara'],
  ['wisata-nusantara', 'budaya', 'docu', 'docu', 'cepat', '9:16', 'a calm, deep Indonesian male documentary narrator', 'Wisata Nusantara']
];

describe('template copy: identity is untouched', () => {
  it('keeps 33 templates with the same ids, names, categories, looks, modes, aspects and narrators', () => {
    expect(CATALOG.templates.map(t => t.id)).toEqual(IDENTITY.map(row => row[0]));
    for (const [id, category, family, variant, mode, aspect, narrator, name] of IDENTITY) {
      const t = CATALOG.templates.find(x => x.id === id)!;
      expect(t, id).toBeDefined();
      expect({ category: t.category, family: t.family, variant: t.variant, mode: t.mode, aspect: t.aspect, narrator: t.narrator, name: t.name }, id)
        .toEqual({ category, family, variant, mode, aspect, narrator, name });
    }
  });
});

describe('template copy: taglines', () => {
  it('every tagline is one concrete sentence that passes the lint', () => {
    for (const t of CATALOG.templates) {
      expect(lintCopy(t.tagline, { kind: 'tagline' }), `${t.id}: "${t.tagline}"`).toEqual([]);
      expect(t.tagline.length, t.id).toBeLessThanOrEqual(60);
      expect(t.tagline.length, t.id).toBeGreaterThan(10);
      expect(t.tagline.slice(0, -1), `${t.id}: one sentence`).not.toMatch(/[.!?]\s/);
    }
  });

  it('no two templates share a tagline', () => {
    const seen = new Map<string, string>();
    for (const t of CATALOG.templates) {
      expect(seen.has(t.tagline), `${t.id} repeats ${seen.get(t.tagline)}`).toBe(false);
      seen.set(t.tagline, t.id);
    }
  });

  it('taglines carry hook signal instead of adjectives', () => {
    const scores = CATALOG.templates.map(t => hookScore(t.tagline));
    expect(Math.min(...scores)).toBeGreaterThanOrEqual(40);
    expect(scores.reduce((a, b) => a + b, 0) / scores.length).toBeGreaterThanOrEqual(60);
  });
});

describe('template copy: covers are described frames', () => {
  it('each cover fills the frame slots: subject, action, place, light direction, lens', () => {
    for (const t of CATALOG.templates) expect(lintCover(t.cover), `${t.id}: ${t.cover}`).toEqual([]);
  });

  it('covers stay one English sentence in the 40..220 character window', () => {
    for (const t of CATALOG.templates) {
      expect(t.cover.length, t.id).toBeGreaterThan(40);
      expect(t.cover.length, t.id).toBeLessThanOrEqual(220);
      expect(t.cover, t.id).toMatch(/^[A-Z].*\.$/);
    }
  });

  it('no cover is reused', () => {
    expect(new Set(CATALOG.templates.map(t => t.cover)).size).toBe(CATALOG.templates.length);
  });
});

describe('template copy: no slop anywhere in the catalogue', () => {
  const copy = CATALOG.templates.flatMap(t => [
    ['tagline', t.tagline], ['cover', t.cover], ['example', t.example], ['name', t.name]
  ] as const);

  it('never uses a banned adjective, in Indonesian or English', () => {
    for (const [field, value] of copy) {
      for (const word of BANNED_WORDS) {
        expect(value.toLowerCase(), `${field}: "${value}" uses "${word}"`).not.toMatch(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
      }
    }
  });

  it('never uses an AI tell', () => {
    for (const [field, value] of copy) {
      for (const tell of AI_TELLS) {
        expect(value.toLowerCase(), `${field}: "${value}" uses "${tell}"`).not.toContain(tell);
      }
    }
  });

  it('never shouts, never stacks exclamations, never uses emoji', () => {
    for (const [field, value] of copy) {
      expect(value, field).not.toMatch(/!{2,}/);
      expect(value, field).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
      expect(value.replace(/^[A-Z0-9&]+$/, ''), field).toMatch(/[a-z]/);
    }
  });

  it('keeps every example an Indonesian premise of two sentences or fewer', () => {
    for (const t of CATALOG.templates) {
      expect(t.example, t.id).toMatch(/\b(yang|dan|di|ke|dari|dengan|untuk|seorang|seekor|setiap|sampai|lalu|tentang|bersama|cara|tahun|tidak|ada)\b/i);
      expect(t.example.length, t.id).toBeLessThanOrEqual(320);
      expect(t.example.split(/(?<=[.!?])\s+/).filter(Boolean).length, t.id).toBeLessThanOrEqual(2);
      expect(lintCopy(t.example, { kind: 'caption' }), `${t.id} example`).toEqual([]);
    }
  });
});
