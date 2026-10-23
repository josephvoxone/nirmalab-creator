import { describe, expect, it } from 'vitest';
import techniquesJson from './techniques.json' with { type: 'json' };
import { shortReference, type Technique } from './compose.js';
import {
  CURATED_PRESETS,
  DEFAULT_NEGATIVE,
  allPresets,
  applyPreset,
  catalogPresets,
  composeShot,
  presetPreview
} from './presets.js';

const catalog = techniquesJson as Technique[];
const byKey = new Map(catalog.map(t => [`${t.c}/${t.s}`, t]));

describe('curated presets (integritas data)', () => {
  it('ada preset untuk drama, kids, dan faceless', () => {
    for (const group of ['drama', 'kids', 'faceless'] as const) {
      expect(CURATED_PRESETS.filter(p => p.group === group).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('setiap teknik yang dirujuk benar-benar ada di katalog 424', () => {
    for (const preset of CURATED_PRESETS) {
      for (const key of preset.techniques) expect(byKey.has(key), `${preset.id} -> ${key}`).toBe(true);
      expect(byKey.has(preset.previewKey), `${preset.id} preview`).toBe(true);
    }
  });

  it('aturan Veo: maksimal satu gerakan kamera per preset, durasi 4/6/8', () => {
    for (const preset of CURATED_PRESETS) {
      const moves = preset.techniques.filter(k => k.startsWith('camera-movement/'));
      expect(moves.length, preset.id).toBeLessThanOrEqual(1);
      expect([4, 6, 8]).toContain(preset.durationSec);
    }
  });

  it('id unik', () => {
    const ids = allPresets(catalog).map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('catalogPresets', () => {
  it('membuat preset dari 27 genre look + 44 viral look, lengkap dengan preview', () => {
    const presets = catalogPresets(catalog);
    expect(presets.filter(p => p.group === 'genre')).toHaveLength(27);
    expect(presets.filter(p => p.group === 'viral')).toHaveLength(44);
    for (const preset of presets) expect(presetPreview(preset, catalog).image ?? presetPreview(preset, catalog).video).toBeTruthy();
  });
});

describe('applyPreset + composeShot', () => {
  const preset = CURATED_PRESETS.find(p => p.group === 'drama')!;

  it('clone preset menghasilkan teknik berurutan, aspek, durasi, contoh subjek', () => {
    const state = applyPreset(preset, catalog);
    expect(state.picked.map(t => `${t.c}/${t.s}`)).toEqual(preset.techniques);
    expect(state.aspect).toBe(preset.aspect);
    expect(state.durationSec).toBe(preset.durationSec);
    expect(state.subject).toBe(preset.subjectExample);
    expect(state.style).toBe(preset.style);
    expect(state.negative).toEqual(preset.negative);
  });

  it('kunci teknik yang tidak dikenal dibuang, bukan crash', () => {
    const state = applyPreset({ ...preset, techniques: ['nope/missing', preset.techniques[0]!] }, catalog);
    expect(state.picked).toHaveLength(1);
  });

  it('prompt akhir: kamera, karakter+subjek, look, Style, lalu Negative prompt sebagai daftar kata benda', () => {
    const dolly: Technique = { c: 'camera-movement', s: 'dolly', n: 'Dolly', d: '', p: 'The camera dollies around [Subject].' };
    const rim: Technique = { c: 'lighting', s: 'rim', n: 'Rim', d: '', p: 'Rim light on [Subject].' };
    const out = composeShot({
      subject: 'she reads the letter',
      character: 'a woman in her thirties, yellow raincoat, short black hair',
      picked: [rim, dolly],
      style: 'soft film grain',
      negative: ['subtitles', 'watermark']
    });
    expect(out).toBe(
      'The camera dollies around a woman in her thirties, yellow raincoat, short black hair. '
      + 'The woman — she reads the letter. '
      + 'Rim light on the woman. '
      + 'Style: soft film grain.\nNegative prompt: subtitles, watermark.'
    );
    expect(out).not.toMatch(/\bno\s/i);
  });

  it('tanpa style/negative/karakter tetap bersih', () => {
    const out = composeShot({ subject: 'x', character: '', picked: [], style: '', negative: [] });
    expect(out).toBe('X');
  });

  it('negative default memuat anti-subtitle (masalah Veo yang terdokumentasi)', () => {
    expect(DEFAULT_NEGATIVE).toEqual(expect.arrayContaining(['subtitles', 'captions', 'on-screen text', 'watermark']));
  });
});

describe('kualitas prompt preset kurasi (dibaca dari katalog asli)', () => {
  for (const preset of CURATED_PRESETS) {
    it(`${preset.id}: satu focal length, descriptor penuh sekali, ringkas, kalimat kapital`, () => {
      const state = applyPreset(preset, catalog);
      const out = composeShot({ subject: state.subject, character: state.character, picked: state.picked, style: state.style, negative: state.negative });
      const focal = new Set((out.match(/\b\d{2,3}\s?mm\b/g) ?? []).map(x => x.replace(/\s/g, '')));
      expect(focal.size, out).toBeLessThanOrEqual(1);
      expect(preset.techniques.filter(k => k.startsWith('lenses/')).length).toBeLessThanOrEqual(1);
      const char = state.character.toLowerCase();
      if (char && !shortReference(state.character).toLowerCase().includes(char)) {
        expect(out.toLowerCase().split(char).length - 1, out).toBe(1);
      }
      expect(out.split('\nNegative prompt:')[0]!.length, out).toBeLessThan(950);
      for (const sentenceStart of out.split(/(?<=[.!?])\s+/)) expect(sentenceStart.charAt(0), sentenceStart).toMatch(/[^a-z]/);
    });
  }
});

describe('shortReference', () => {
  it.each([
    ['a small round orange cat with a blue backpack and huge curious eyes', 'the small round orange cat'],
    ['three round balloons in red, yellow and blue', 'the three round balloons'],
    ['a young couple, she in a red trench coat', 'the young couple'],
    ['an abandoned wooden house at the edge of a rice field', 'the abandoned wooden house'],
    ['a toy train carrying fruit', 'the toy train'],
    ['a lone hiker', 'the lone hiker']
  ])('%s -> %s', (input, expected) => {
    expect(shortReference(input)).toBe(expected);
  });
});

describe('anti-kontaminasi template katalog', () => {
  const prompt = (id: string) => {
    const p = CURATED_PRESETS.find(x => x.id === id)!;
    const s = applyPreset(p, catalog);
    return composeShot({ subject: s.subject, character: s.character, picked: s.picked, style: s.style, negative: [] });
  };
  it('tidak ada kuda di dongeng kelinci', () => expect(prompt('kids-storybook')).not.toMatch(/horse/i));
  it.each(['kids-miniature', 'faceless-hands-pov', 'faceless-product', 'faceless-broll-doc', 'kids-3d-cute'])('%s tidak menyebut kulit', id => {
    expect(prompt(id)).not.toMatch(/skin/i);
  });
  it('rumah misteri tidak punya lampu di meja', () => expect(prompt('faceless-mystery')).not.toMatch(/table/i));
  it('tidak ada fallback "the subject" di preset kurasi', () => {
    for (const p of CURATED_PRESETS) expect(prompt(p.id), p.id).not.toMatch(/the subject/i);
  });
});

describe('alat kamera tidak boleh muncul di frame (temuan render Flow 2026-10-23)', () => {
  it('negative default menolak alat kamera dan kru', () => {
    expect(DEFAULT_NEGATIVE).toEqual(expect.arrayContaining(['camera equipment', 'camera crane', 'film crew', 'drone in frame']));
  });
  it('preset kurasi tidak menyebut alat sebagai benda (jib arm, slider rig, dolly track)', () => {
    for (const p of CURATED_PRESETS) {
      const s = applyPreset(p, catalog);
      const out = composeShot({ subject: s.subject, character: s.character, picked: s.picked, style: s.style, negative: [] });
      expect(out, p.id).not.toMatch(/jib arm|slider rig|dolly track|camera rig|technocrane/i);
    }
  });
});
