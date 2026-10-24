/**
 * P4: anti-slop lint for Indonesian copy (spec §4.3 lint list, §7 P4).
 *
 * The lint is the single source of truth for "this reads like AI slop": every finding is a
 * plain Indonesian sentence a user can act on. `repairCopy` fixes only what can be fixed
 * mechanically (emoji, exclamation stacks, shouting, filler prefixes, over-long narration)
 * and reports what it fixed; a copy that still fails after repair is rejected upstream.
 */
import { describe, expect, it } from 'vitest';
import { BANNED_WORDS, hookScore, lintCopy, lintCover, repairCopy } from '../src/text/lint.js';

const joined = (text: string, kind: 'narration' | 'caption' | 'title' | 'tagline' = 'narration') =>
  lintCopy(text, { kind }).join(' | ');

describe('lintCopy: banned words', () => {
  it('flags an empty adjective that props up the sentence', () => {
    expect(joined('Pemandangan yang indah sekali.')).toMatch(/kata sifat kosong/i);
    expect(joined('Rumah megah itu kosong.')).toMatch(/kata sifat kosong/i);
    expect(joined('Adegan yang epic dan memukau.')).toMatch(/epic/);
    expect(joined('Video motivasi sinematik.')).toMatch(/sinematik/);
  });

  it('exposes the banned list, with the Indonesian and English spellings of each claim', () => {
    for (const word of ['indah', 'megah', 'epic', 'epik', 'memukau', 'mengagumkan', 'luar biasa', 'menakjubkan', 'cinematic', 'sinematik']) {
      expect(BANNED_WORDS, word).toContain(word);
    }
  });

  it('passes a line made of visible facts', () => {
    expect(lintCopy('Jingga menunggu di pagar setiap sore.', { kind: 'narration' })).toEqual([]);
    expect(lintCopy('Ibu memotong tempe tipis di dapur.', { kind: 'narration' })).toEqual([]);
  });
});

describe('lintCopy: AI tells, punctuation, shouting', () => {
  it('flags every listed AI tell', () => {
    expect(joined('Dalam dunia yang penuh rahasia, kucing itu pulang.')).toMatch(/dalam dunia yang/i);
    expect(joined('Kucing itu tak hanya pintar.')).toMatch(/tak hanya/i);
    expect(joined('Ini bukan sekadar cerita kucing.')).toMatch(/bukan sekadar/i);
    expect(joined('Mari kita lihat pagar itu.')).toMatch(/mari kita/i);
    expect(joined('Simak kisah kucing ini.')).toMatch(/simak/i);
    expect(joined('Yuk tonton sampai habis.')).toMatch(/yuk/i);
  });

  it('flags exclamation stacks, emoji and shouting', () => {
    expect(joined('Kucing itu pergi!!')).toMatch(/tanda seru/i);
    expect(joined('Kucing itu pergi 🐈')).toMatch(/emoji/i);
    expect(joined('MIMI menunggu di pagar.')).toMatch(/huruf besar/i);
    // A short ALL-CAPS title card is a design choice, not shouting.
    expect(lintCopy('KUCING HILANG', { kind: 'title' })).toEqual([]);
  });

  it('flags filler words that delay the event', () => {
    expect(joined('Sinopsis: kucing pergi dari rumah.')).toMatch(/sinopsis/i);
    expect(joined('Cerita ini tentang kucing yang pergi.')).toMatch(/cerita ini/i);
  });
});

describe('lintCopy: per-kind rules', () => {
  it('caps narration at 12 words but leaves a caption room to breathe', () => {
    const long = 'Jingga menunggu di depan pagar kayu setiap sore sampai pemiliknya kembali menjemputnya lagi.';
    expect(joined(long)).toMatch(/maks 12 agar muat/);
    expect(lintCopy(long, { kind: 'caption' }).join(' ')).not.toMatch(/12 kata/);
  });

  it('rejects a caption without a concrete subject', () => {
    expect(joined('Kisah yang sangat haru dan penuh makna.', 'caption')).toMatch(/subjek konkret/i);
    expect(lintCopy('Jingga menunggu di pagar sampai pemiliknya kembali.', { kind: 'caption' })).toEqual([]);
  });

  it('rejects a tagline that names no actor and does nothing', () => {
    const issues = joined('Kisah sedih hewan peliharaan yang menyentuh', 'tagline');
    expect(issues).toMatch(/kata kerja/i);
    expect(issues).toMatch(/subjek konkret/i);
    expect(lintCopy('Kucing oranye menunggu di pagar setelah pemiliknya pindah.', { kind: 'tagline' })).toEqual([]);
  });

  it('never flags a plain, specific title', () => {
    expect(lintCopy('Misteri Rumah Kosong', { kind: 'title' })).toEqual([]);
    expect(lintCopy('Perjuangan Ibu', { kind: 'title' })).toEqual([]);
  });
});

describe('repairCopy', () => {
  it('strips emoji, exclamation stacks and shouting, and says what it fixed', () => {
    const fixed = repairCopy('MIMI menunggu di pagar!! 🐈', { kind: 'narration' });
    expect(fixed.text).toBe('Mimi menunggu di pagar.');
    expect(fixed.fixed.join(' ')).toMatch(/emoji/);
    expect(fixed.fixed.join(' ')).toMatch(/tanda seru/);
    expect(fixed.fixed.join(' ')).toMatch(/huruf besar/);
    expect(lintCopy(fixed.text, { kind: 'narration' })).toEqual([]);
  });

  it('trims over-long narration at a word boundary instead of dropping the line', () => {
    const long = 'Jingga menunggu di depan pagar kayu setiap sore sampai pemiliknya kembali menjemputnya lagi.';
    const fixed = repairCopy(long, { kind: 'narration' });
    expect(fixed.text.split(/\s+/).length).toBeLessThanOrEqual(12);
    expect(fixed.text.startsWith('Jingga menunggu di depan pagar')).toBe(true);
    expect(fixed.fixed.join(' ')).toMatch(/dipotong/i);
  });

  it('removes a banned adjective and drops a dangling "yang" with it', () => {
    const fixed = repairCopy('Pagar kayu yang indah itu kosong.', { kind: 'narration' });
    expect(fixed.text).toBe('Pagar kayu itu kosong.');
    expect(lintCopy(fixed.text, { kind: 'narration' })).toEqual([]);
  });

  it('leaves a clean line untouched and reports nothing', () => {
    expect(repairCopy('Jingga menunggu di pagar.', { kind: 'narration' })).toEqual({ text: 'Jingga menunggu di pagar.', fixed: [] });
  });

  it('does not invent content when the whole line is slop: it repairs what it can and leaves the rest to the lint', () => {
    const fixed = repairCopy('Dalam dunia yang indah, mari kita simak!!', { kind: 'narration' });
    expect(fixed.fixed.length).toBeGreaterThan(0);
    expect(lintCopy(fixed.text, { kind: 'narration' }).length).toBeGreaterThan(0);
  });
});

describe('hookScore', () => {
  it('rewards a concrete subject, a verb and a tension word', () => {
    expect(hookScore('Jingga menunggu di pagar sampai pemiliknya kembali.')).toBeGreaterThanOrEqual(80);
    expect(hookScore('Kucing oranye ditinggal pemiliknya di pagar.')).toBeGreaterThanOrEqual(60);
  });

  it('punishes the banned list, AI tells, emoji and shouting', () => {
    expect(hookScore('Kisah yang indah, megah, dan menyentuh.')).toBeLessThanOrEqual(30);
    expect(hookScore('Dalam dunia yang indah, simak kisahnya!!')).toBeLessThanOrEqual(20);
    expect(hookScore('')).toBe(0);
  });

  it('is deterministic and always inside 0..100', () => {
    for (const text of ['Jingga menunggu di pagar.', 'Kisah sedih hewan peliharaan.', 'Ibu memotong tempe di dapur sampai subuh.', '']) {
      const score = hookScore(text);
      expect(score).toBe(hookScore(text));
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
      expect(Number.isInteger(score)).toBe(true);
    }
  });

  it('ranks a concrete line above a vague one on the same story', () => {
    expect(hookScore('Jingga menunggu di pagar sampai pemiliknya kembali.'))
      .toBeGreaterThan(hookScore('Kisah sedih tentang kesetiaan yang menyentuh.'));
  });
});

describe('lintCover: the cover prompt slots', () => {
  it('accepts a frame with a subject, an action, a place, a light direction and a lens', () => {
    expect(lintCover('A ginger cat sits by a wooden gate on a village lane, amber window light from the porch across its back, 35mm.')).toEqual([]);
  });

  it('rejects an empty adjective instead of a described frame', () => {
    expect(lintCover('A beautiful epic shot of a cat.').join(' ')).toMatch(/kata sifat kosong/i);
  });

  it('asks for the missing slot by name', () => {
    expect(lintCover('A ginger cat sits on a wooden chair, 35mm.').join(' ')).toMatch(/cahaya/i);
    expect(lintCover('A ginger cat sits by a wooden gate, amber window light from the porch, 35mm.').join(' ')).toMatch(/tempat/i);
    expect(lintCover('A ginger cat sits by a wooden gate on a village lane, amber window light from the porch').join(' ')).toMatch(/lensa/i);
    expect(lintCover('A ginger cat by a wooden gate on a village lane, amber window light from the porch, 35mm.').join(' ')).toMatch(/aksi|kata kerja/i);
  });
});
