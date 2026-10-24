import { describe, expect, it } from 'vitest';
import { SCRIPT_KINDS, buildScriptRequest, estimateSeconds, toSpeech, wordCount } from './scriptTemplates.js';

describe('SCRIPT_KINDS', () => {
  it('offers the four kinds in order, with a hint each', () => {
    expect(SCRIPT_KINDS.map(k => k.label)).toEqual(['Narasi video pendek', 'Hook pembuka', 'Caption & hashtag', 'Bebas']);
    for (const k of SCRIPT_KINDS) expect(k.hint.length).toBeGreaterThan(10);
  });
});

describe('buildScriptRequest', () => {
  it('narasi: a voice-over brief capped at 60 seconds and 6–10 short sentences, spoken text only', () => {
    const r = buildScriptRequest('narasi', '  kenapa kucing suka kotak  ');
    expect(r.prompt).toBe('Topik / ide: kenapa kucing suka kotak');
    expect(r.system).toMatch(/60 detik/);
    expect(r.system).toMatch(/6–10 kalimat pendek/);
    expect(r.system).toMatch(/bahasa Indonesia/i);
    expect(r.system).toMatch(/tanpa judul/i);
    expect(r.system).toMatch(/tanpa hashtag/i);
  });

  it('hook: exactly three numbered options', () => {
    const r = buildScriptRequest('hook', 'tips hemat listrik');
    expect(r.prompt).toBe('Topik / ide: tips hemat listrik');
    expect(r.system).toMatch(/tepat 3 opsi/i);
    expect(r.system).toMatch(/'1\.', '2\.', '3\.'/);
  });

  it('caption: a short caption, then hashtags', () => {
    const r = buildScriptRequest('caption', 'resep sambal matah');
    expect(r.system).toMatch(/caption/i);
    expect(r.system).toMatch(/5–8 hashtag/);
  });

  it('bebas: the idea goes through untouched, with no system brief', () => {
    expect(buildScriptRequest('bebas', ' Tulis puisi pendek tentang hujan ')).toEqual({ prompt: 'Tulis puisi pendek tentang hujan' });
  });
});

describe('toSpeech', () => {
  it('leaves plain narration alone', () => {
    expect(toSpeech('Kucing suka kotak.\nKarena hangat.')).toBe('Kucing suka kotak.\nKarena hangat.');
  });

  it('drops markdown, list markers and hashtags so the voice does not read them', () => {
    const raw = '## Judul\n1. **Pertama** kalimat.\n- Kedua _kalimat_.\n\n\n#kucing #fyp';
    expect(toSpeech(raw)).toBe('Judul\nPertama kalimat.\nKedua kalimat.');
  });
});

describe('wordCount / estimateSeconds', () => {
  it('counts words and estimates spoken seconds at ~2.5 words per second', () => {
    expect(wordCount('  satu dua\ntiga  ')).toBe(3);
    expect(wordCount('')).toBe(0);
    expect(estimateSeconds('')).toBe(0);
    expect(estimateSeconds(Array.from({ length: 150 }, () => 'kata').join(' '))).toBe(60);
    expect(estimateSeconds('satu')).toBe(1);
  });
});
