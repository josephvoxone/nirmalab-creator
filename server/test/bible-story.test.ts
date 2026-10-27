import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES, GENERIC_ANCHOR, MAX_CHARACTERS, anchorIsGeneric, characterByToken, locationByKey,
  rulesOf, sceneById, validateBible, type StoryBible
} from '../src/bible/story.js';

const valid = (): StoryBible => ({
  logline: 'Seorang gadis penjual ikan menyembunyikan kelinci putih dari pasar yang lapar.',
  theme: 'Keberanian kecil menolong yang lemah',
  tone: 'hangat dan tenang',
  audience: 'anak',
  structure: [
    { act: 'hook', goal: 'menarik perhatian', beat: 'pasar ramai saat subuh' },
    { act: 'setup', goal: 'memperkenalkan Laras', beat: 'Laras membeli ikan' },
    { act: 'turn', goal: 'menaikkan taruhan', beat: 'kelinci kabur ke hutan' },
    { act: 'payoff', goal: 'menutup cerita', beat: 'Laras menemukan kelinci' }
  ],
  characters: [
    { token: 'LARAS', name: 'Laras', anchors: ['two black braids', 'a faded blue school uniform'], want: 'menjual semua ikan sebelum siang', need: 'keberanian menolong makhluk kecil', arc: 'dari ragu menjadi berani' },
    { token: 'KAPAS', name: 'Kapas', anchors: ['a cream rabbit with one floppy ear', 'a red knitted scarf'], want: 'kembali ke hutan', need: 'percaya pada Laras', arc: 'dari takut menjadi percaya' }
  ],
  locations: [
    { key: 'PASAR_IKAN', name: 'Pasar Ikan', lookdev: 'a busy fish market at dawn with wet stone floors' },
    { key: 'HUTAN', name: 'Hutan', lookdev: 'a misty pine forest with soft ground fog' }
  ],
  scenes: [
    { id: 'pasar', title: 'Di Pasar', goal: 'Laras menyembunyikan Kapas dari pembeli', location: 'PASAR_IKAN', stateIn: 'pasar penuh', stateOut: 'Kapas aman di keranjang' },
    { id: 'hutan', title: 'Ke Hutan', goal: 'Kapas memilih ikut Laras', location: 'HUTAN' }
  ],
  rules: { maxShotSec: 6, narrationMaxWords: 12 }
});

const errs = (patch: (b: StoryBible) => void) => {
  const b = valid();
  patch(b);
  return validateBible(b);
};

describe('validateBible', () => {
  it('accepts a complete bible from the spec and reports nothing', () => {
    expect(validateBible(valid())).toEqual([]);
  });

  it('rejects an empty logline, theme or tone', () => {
    expect(errs(b => { b.logline = '   '; }).join()).toMatch(/logline wajib/);
    expect(errs(b => { b.theme = ''; }).join()).toMatch(/tema wajib/);
    expect(errs(b => { b.tone = ''; }).join()).toMatch(/tone wajib/);
  });

  it('rejects a character without want or need', () => {
    expect(errs(b => { b.characters[0]!.want = ''; }).join()).toMatch(/LARAS: want wajib/);
    expect(errs(b => { b.characters[0]!.need = ' '; }).join()).toMatch(/LARAS: need wajib/);
    expect(errs(b => { b.characters[0]!.want = ''; }).join()).not.toMatch(/KAPAS: want/);
  });

  it('rejects anchors that are only generic adjectives without a concrete noun', () => {
    expect(errs(b => { b.characters[1]!.anchors = ['indah dan megah']; }).join()).toMatch(/KAPAS: anchor "indah dan megah" terlalu umum/);
    expect(errs(b => { b.characters[0]!.anchors = ['beautiful']; }).join()).toMatch(/LARAS: anchor "beautiful"/);
    expect(errs(b => { b.characters[0]!.anchors = ['an epic cinematic look']; }).join()).toMatch(/terlalu umum/);
    expect(errs(b => { b.characters[0]!.anchors = ['a beautiful woman']; }).join()).toMatch(/terlalu umum/);
    // One concrete fact inside the anchor is enough: the anchor is accepted.
    expect(errs(b => { b.characters[0]!.anchors = ['a woman with a small scar above her left eyebrow']; })).toEqual([]);
    // Anchors are judged one by one: a fluffy entry is rejected even next to a good one.
    expect(errs(b => { b.characters[0]!.anchors = ['beautiful', 'two black braids']; }).join()).toMatch(/anchor "beautiful"/);
    expect(errs(b => { b.characters[0]!.anchors = ['two black braids', 'a woman with a limp']; })).toEqual([]);
    expect(errs(b => { b.characters[0]!.anchors = []; }).join()).toMatch(/anchors wajib diisi/);
  });

  it('rejects a scene without goal, an unknown location and duplicate or malformed ids', () => {
    expect(errs(b => { b.scenes[0]!.goal = ''; }).join()).toMatch(/scene pasar: goal wajib/);
    expect(errs(b => { b.scenes[0]!.location = 'PANTAI'; }).join()).toMatch(/PANTAI tidak ada di locations/);
    expect(errs(b => { b.scenes[1]!.id = 'pasar'; }).join()).toMatch(/scene pasar: id ganda/);
    expect(errs(b => { b.scenes[1]!.id = 'Ke Hutan'; }).join()).toMatch(/scene Ke Hutan: id harus huruf kecil/);
    expect(errs(b => { b.scenes = []; }).join()).toBe('');   // fresh bible: scenes come later
  });

  it('rejects a structure that misses hook or payoff', () => {
    expect(errs(b => { b.structure = b.structure.filter(s => s.act !== 'hook'); }).join()).toMatch(/wajib punya act "hook"/);
    expect(errs(b => { b.structure = b.structure.filter(s => s.act !== 'payoff'); }).join()).toMatch(/wajib punya act "payoff"/);
    expect(errs(b => { b.structure = []; }).join()).toMatch(/structure wajib berisi hook dan payoff/);
    expect(errs(b => { (b.structure[0] as { act: string }).act = 'intro'; }).join()).toMatch(/act harus hook, setup, turn atau payoff/);
    expect(errs(b => { b.structure[0]!.beat = ''; }).join()).toBe('');   // beat is optional for hand-written bibles
  });

  it('rejects more than 20 characters and duplicate tokens', () => {
    const many = Array.from({ length: MAX_CHARACTERS + 1 }, (_, i) => ({ ...valid().characters[0]!, token: `CHAR_${i}` }));
    expect(errs(b => { b.characters = many; }).join()).toMatch(/terlalu banyak karakter \(maks 20\)/);
    expect(errs(b => { b.characters = [valid().characters[0]!, { ...valid().characters[1]!, token: 'LARAS' }]; }).join()).toMatch(/token ganda/);
    expect(errs(b => { b.characters[0]!.token = 'laras'; }).join()).toMatch(/token harus HURUF BESAR/);
  });

  it('rejects a display name equal to, or a word-prefix of, another (Flow picks a character by name, falling back to a prefix match)', () => {
    const twin = (name: string) => errs(b => { b.characters[1]!.name = name; }).join();
    expect(twin(` ${valid().characters[0]!.name.toUpperCase()} `)).toMatch(/karakter KAPAS: nama "LARAS" bentrok dengan "Laras" \(LARAS\)/);
    expect(twin('Laras Dewasa')).toMatch(/karakter KAPAS: nama "Laras Dewasa" bentrok dengan "Laras" \(LARAS\)/);
    expect(errs(b => { b.characters[0]!.name = 'Kapas Kecil'; }).join()).toMatch(/karakter KAPAS: nama "Kapas" bentrok dengan "Kapas Kecil" \(LARAS\)/);
    expect(twin('Larasati')).toBe('');            // a longer word is a different name
    expect(twin('Dewi Laras')).toBe('');
  });

  it('rejects malformed locations and bad rules, accepts absent rules', () => {
    expect(errs(b => { b.locations![0]!.key = 'pasar'; }).join()).toMatch(/lokasi pasar: key harus HURUF BESAR/);
    expect(errs(b => { b.locations![1]!.key = 'PASAR_IKAN'; }).join()).toMatch(/lokasi PASAR_IKAN: key ganda/);
    expect(errs(b => { b.locations![0]!.name = ''; }).join()).toMatch(/PASAR_IKAN: name wajib/);
    expect(errs(b => { b.rules = { maxShotSec: 0, narrationMaxWords: 99 }; }).join()).toMatch(/rules\.maxShotSec/);
    expect(errs(b => { b.rules = { maxShotSec: 6, narrationMaxWords: 0 }; }).join()).toMatch(/rules\.narrationMaxWords/);
    expect(errs(b => { delete b.rules; })).toEqual([]);
  });

  it('rejects a non-object bible', () => {
    expect(validateBible(undefined).join()).toMatch(/bible harus berupa objek/);
    expect(validateBible('nope').join()).toMatch(/bible harus berupa objek/);
    expect(validateBible([]).join()).toMatch(/bible harus berupa objek/);
  });
});

describe('bible helpers', () => {
  it('anchorIsGeneric: no concrete noun means generic', () => {
    for (const a of ['beautiful', 'indah dan megah', 'epic', 'cinematic', 'a beautiful woman', 'very pretty']) {
      expect(anchorIsGeneric(a), a).toBe(true);
    }
    for (const a of ['two black braids', 'a red knitted scarf', 'a small scar above the left eyebrow', 'wooden leg', 'an orange cat']) {
      expect(anchorIsGeneric(a), a).toBe(false);
    }
    expect(GENERIC_ANCHOR.length).toBeGreaterThanOrEqual(2);
    for (const re of GENERIC_ANCHOR) expect(re.flags).not.toContain('g');
  });

  it('rulesOf defaults to 6 s and 12 words, and keeps explicit rules', () => {
    expect(DEFAULT_RULES).toEqual({ maxShotSec: 6, narrationMaxWords: 12 });
    expect(rulesOf(valid())).toEqual({ maxShotSec: 6, narrationMaxWords: 12 });
    expect(rulesOf({ ...valid(), rules: { maxShotSec: 4, narrationMaxWords: 9 } })).toEqual({ maxShotSec: 4, narrationMaxWords: 9 });
    expect(rulesOf(undefined)).toEqual(DEFAULT_RULES);
  });

  it('looks up characters, locations and scenes by token/key/id', () => {
    const b = valid();
    expect(characterByToken(b, 'KAPAS')?.name).toBe('Kapas');
    expect(characterByToken(b, 'LARAS')?.want).toMatch(/ikan/);
    expect(characterByToken(b, 'NOPE')).toBeUndefined();
    expect(locationByKey(b, 'HUTAN')?.lookdev).toMatch(/pine/);
    expect(locationByKey(b, 'PANTAI')).toBeUndefined();
    expect(sceneById(b, 'hutan')?.goal).toMatch(/Kapas/);
    expect(sceneById(b, 'nope')).toBeUndefined();
  });
});
