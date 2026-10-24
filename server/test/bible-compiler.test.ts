import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ShotCompileError, compileShot, lintPrompt, type ShotIntent } from '../src/bible/compiler.js';
import { lookById, type LookId } from '../src/bible/styles.js';
import type { StoryBible } from '../src/bible/story.js';

const goldens: Record<string, unknown> = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'shot-goldens.json'), 'utf8'));

const bible = (): StoryBible => ({
  logline: 'Seorang gadis penjual ikan menyembunyikan kelinci putih dari pasar yang lapar.',
  theme: 'Keberanian kecil menolong yang lemah',
  tone: 'hangat dan tenang',
  audience: 'anak',
  structure: [
    { act: 'hook', goal: 'menarik perhatian', beat: 'pasar ramai saat subuh' },
    { act: 'payoff', goal: 'menutup cerita', beat: 'Laras menemukan kelinci' }
  ],
  characters: [
    { token: 'LARAS', name: 'Laras', anchors: ['two black braids'], want: 'menjual semua ikan', need: 'keberanian menolong', arc: 'ragu menjadi berani' },
    { token: 'KAPAS', name: 'Kapas', anchors: ['a cream rabbit with one floppy ear'], want: 'kembali ke hutan', need: 'percaya pada Laras', arc: 'takut menjadi percaya' }
  ],
  locations: [{ key: 'PASAR_IKAN', name: 'Pasar Ikan', lookdev: 'a busy fish market at dawn with wet stone floors' }],
  scenes: [{ id: 'pasar', title: 'Di Pasar', goal: 'Laras menyembunyikan Kapas', location: 'PASAR_IKAN' }],
  rules: { maxShotSec: 6, narrationMaxWords: 12 }
});

const scene = () => bible().scenes[0]!;

const intents: Record<'still' | 'action' | 'dialogue', ShotIntent> = {
  still: {
    subject: 'LARAS',
    action: 'stands still behind the fish stall',
    startState: 'her hands are empty',
    endState: 'her hands close around a hidden basket',
    framing: 'medium',
    move: 'static',
    emotion: 'waspada',
    silent: true
  },
  action: {
    subject: 'LARAS',
    action: 'lifts the woven basket off the wet stones',
    startState: 'the basket is hidden under the table',
    endState: 'the basket is held against her chest',
    framing: 'medium-close',
    move: 'push-in',
    emotion: 'takut ketahuan',
    narration: 'Laras mengangkat keranjang itu pelan-pelan.'
  },
  dialogue: {
    subject: 'LARAS',
    action: 'kneels beside the basket and whispers to KAPAS',
    startState: 'the basket lid is closed',
    endState: 'the lid is open and one ear pokes out',
    framing: 'close-up',
    move: 'push-in',
    emotion: 'lembut',
    speaker: 'LARAS',
    narration: 'Tarik napas, kita pulang sebentar lagi.'
  }
};

const FAMILIES: LookId[] = ['film-real', 'painterly', 'cel-anime', 'clay', 'docu', 'noir'];
const KINDS = ['still', 'action', 'dialogue'] as const;

const compile = (family: LookId, kind: keyof typeof intents, over: Partial<ShotIntent> = {}, extra: { negative?: string } = {}) =>
  compileShot({ look: lookById(family)!, bible: bible(), scene: scene(), shot: { ...intents[kind], ...over }, ...extra });

describe('18 golden shots (6 families × still / action / dialogue)', () => {
  const cases = FAMILIES.flatMap(family => KINDS.map(kind => `${family}/${kind}`));

  it('freezes an exact compiled shot for every family and shot kind', () => {
    expect(Object.keys(goldens).sort()).toEqual([...cases].sort());
  });

  it.each(FAMILIES.flatMap(family => KINDS.map(kind => [family, kind] as const)))('%s / %s', (family, kind) => {
    const actual = compile(family, kind);
    // UPDATE_GOLDENS=1 rewrites the fixture from this single source of truth, so the goldens can
    // never drift from the bible/intents defined above.
    if (process.env.UPDATE_GOLDENS === '1') {
      goldens[`${family}/${kind}`] = actual;
      writeFileSync(join(__dirname, 'fixtures', 'shot-goldens.json'), JSON.stringify(goldens, null, 2) + '\n');
    }
    expect(actual).toEqual(goldens[`${family}/${kind}`]);
  });
});

describe('compiled segment order', () => {
  const out = compile('film-real', 'dialogue');

  it('follows shot grammar → subject & action → state → setting → light → optics → style → text → negative → audio', () => {
    const marks = [
      'Close-up, the camera pushes in slowly.',
      'Laras kneels beside the basket',
      'Starts: the basket lid is closed.',
      'Setting: Pasar Ikan',
      'Light: ',
      'Optics: ',
      'Style: Shot on ',
      'No on-screen text',
      'Negative: ',
      'Audio: '
    ];
    const at = marks.map(mark => out.videoPrompt.indexOf(mark));
    for (const [i, index] of at.entries()) expect(index, `segment ${i} (${marks[i]})`).toBeGreaterThanOrEqual(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('keeps the image prompt free of the negative and audio segments', () => {
    expect(out.imagePrompt).not.toContain('Negative:');
    expect(out.imagePrompt).not.toContain('Audio:');
    expect(out.imagePrompt.startsWith('Close-up, the camera pushes in slowly. Laras kneels')).toBe(true);
    // One short policy line; the specifics live in the negative list, which the image prompt omits.
    expect(out.imagePrompt.endsWith('No on-screen text.')).toBe(true);
  });

  it('names the speaker in a dialogue line and uses voice-over when nobody speaks on camera', () => {
    expect(out.audio).toBe('Audio: Dialogue, Laras speaking Bahasa Indonesia: "Tarik napas, kita pulang sebentar lagi."');
    expect(compile('film-real', 'action').audio).toBe('Audio: Voice-over in Bahasa Indonesia: "Laras mengangkat keranjang itu pelan-pelan."');
    expect(compile('film-real', 'still').audio).toBe('Audio: ambient room tone only, no voice.');
  });

  it('expands every character TOKEN to its name', () => {
    const spoken = compile('film-real', 'dialogue', { narration: 'KAPAS, kita pulang sekarang.' });
    expect(spoken.audio).toContain('"Kapas, kita pulang sekarang."');
    for (const kind of KINDS) {
      const shot = compile('painterly:wayang', kind);
      expect(shot.videoPrompt).not.toMatch(/\bLARAS\b|\bKAPAS\b/);
      expect(shot.imagePrompt).not.toMatch(/\bLARAS\b|\bKAPAS\b/);
      expect(shot.audio).not.toMatch(/\bLARAS\b|\bKAPAS\b/);
    }
  });
});

describe('negative merge', () => {
  it('merges look.forbidden with the board negative without duplicates, case-insensitively', () => {
    const out = compile('noir', 'still', {}, { negative: 'Negative prompt: Logos, SUBTITLES, grain, film burn' });
    const terms = out.negative.replace(/^Negative: /, '').replace(/\.$/, '').split(', ');
    expect(terms).toContain('logos');
    expect(terms.filter(t => t.toLowerCase() === 'logos')).toHaveLength(1);
    expect(terms).toContain('subtitles');
    expect(terms).toContain('film burn');
    // The look's own forbidden list comes first, in order.
    expect(terms.slice(0, 5)).toEqual(['on-screen text', 'logos', 'colour', 'flat lighting', 'smiling models']);
    expect(out.videoPrompt).toContain(`Negative: ${terms.join(', ')}.`);
  });

  it('falls back to the look forbidden list alone, and skips the line when both are empty', () => {
    const noir = compile('noir', 'still');
    expect(noir.negative).toContain('on-screen text');
    const bare = lookById('film-real')!;
    const out = compileShot({ look: { ...bare, forbidden: [] }, bible: bible(), scene: scene(), shot: intents.still });
    expect(out.negative).toBe('');
    expect(out.videoPrompt).not.toContain('Negative:');
  });
});

describe('mandatory slots', () => {
  const issues = (over: Partial<ShotIntent>, lookId = 'film-real') => {
    try {
      compileShot({ look: lookById(lookId)!, bible: bible(), scene: scene(), shot: { ...intents.action, ...over } });
    } catch (error) {
      expect(error).toBeInstanceOf(ShotCompileError);
      return (error as ShotCompileError).issues;
    }
    throw new Error('compileShot did not reject the shot');
  };

  it('rejects an empty subject, action, startState or endState', () => {
    expect(issues({ subject: ' ' }).join()).toMatch(/subject/);
    expect(issues({ action: '' }).join()).toMatch(/action/);
    expect(issues({ startState: '' }).join()).toMatch(/startState/);
    expect(issues({ endState: '' }).join()).toMatch(/endState/);
  });

  it('rejects a shot without a state change', () => {
    expect(issues({ startState: 'the basket is closed', endState: 'the basket is closed' }).join()).toMatch(/no state change/i);
  });

  it('rejects an empty lens set, an empty light, a thin palette and a missing medium', () => {
    const look = lookById('film-real')!;
    const compileWith = (patch: Partial<typeof look>) => {
      try {
        compileShot({ look: { ...look, ...patch }, bible: bible(), scene: scene(), shot: intents.action });
      } catch (error) {
        return (error as ShotCompileError).issues.join();
      }
      throw new Error('compileShot did not reject the look');
    };
    expect(compileWith({ lenses: [] })).toMatch(/lens/);
    expect(compileWith({ light: { ...look.light, key: '' } })).toMatch(/lightDirection/);
    expect(compileWith({ palette: look.palette.slice(0, 1) })).toMatch(/palette/);
    expect(compileWith({ medium: '' as typeof look.medium })).toMatch(/medium/);
    expect(compileWith({ styleSentence: '' })).toMatch(/styleSentence/);
  });

  it('rejects a setting with no scene location and no explicit setting', () => {
    try {
      compileShot({ look: lookById('film-real')!, bible: bible(), scene: { id: 'x', title: 'X', goal: 'y' }, shot: intents.action });
    } catch (error) {
      expect((error as ShotCompileError).issues.join()).toMatch(/setting/);
      return;
    }
    throw new Error('compileShot did not reject the shot');
  });
});

describe('lint', () => {
  const issues = (over: Partial<ShotIntent>) => {
    try {
      compileShot({ look: lookById('film-real')!, bible: bible(), scene: scene(), shot: { ...intents.action, ...over } });
    } catch (error) {
      return (error as ShotCompileError).issues;
    }
    throw new Error('compileShot did not reject the shot');
  };

  it('rejects an action that is two verb chains ("and then")', () => {
    expect(issues({ action: 'opens the door and then runs' }).join()).toMatch(/and then/);
    expect(issues({ action: 'opens the door; then runs' }).join()).toMatch(/and then/);
  });

  it('rejects more than one camera move in the shot grammar', () => {
    // The move id itself is always one move; a second move written into the action is caught.
    expect(issues({ move: 'tracking', action: 'the camera pans left across the stall' }).join()).toMatch(/camera move/);
  });

  it('rejects narration longer than the bible allows', () => {
    // 15 words: "dua belas" and "tiga belas" are two words each.
    const long = 'satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas dua belas tiga belas';
    expect(issues({ narration: long }).join()).toMatch(/narration has 15 words \(max 12/);
  });

  it('rejects a TOKEN that the bible does not know', () => {
    expect(issues({ subject: 'GADIS_PASAR' }).join()).toMatch(/TOKEN/);
  });

  it('rejects camera gear words and empty adjectives standing alone', () => {
    expect(issues({ action: 'walks past a dolly track' }).join()).toMatch(/camera gear/);
    expect(issues({ subject: 'a beautiful woman' }).join()).toMatch(/empty adjective/);
  });

  it('lintPrompt reports each rule for a raw string and passes a clean one', () => {
    expect(lintPrompt('Medium shot, the camera stays still. Laras waits.')).toEqual([]);
    const found = lintPrompt('A beautiful shot, the camera pans and zooms on a jib arm.', { tokens: ['LARAS'], maxWords: 12 });
    expect(found.join()).toMatch(/empty adjective/);
    expect(found.join()).toMatch(/camera gear/);
    expect(found.join()).toMatch(/camera move/);
    expect(lintPrompt('Audio: Voice-over in Bahasa Indonesia: "satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas dua belas tiga".').join()).toMatch(/14 words/);
    expect(lintPrompt('A crane lifts.', { tokens: ['LARAS'] }).join()).toMatch(/camera gear/);
    expect(lintPrompt('LARAS waits here.', { tokens: ['LARAS'] }).join()).toMatch(/TOKEN/);
    expect(lintPrompt('a shot of a GADIS_PASAR in the rain.').join()).toMatch(/TOKEN/);
  });
});

describe('warnings', () => {
  it('warns when a shot setting overrides the bible location, without failing the shot', () => {
    const out = compile('film-real', 'action', { setting: 'the back of the market, under a tarpaulin' });
    expect(out.warnings.join()).toMatch(/setting/);
    expect(out.videoPrompt).toContain('Setting: the back of the market, under a tarpaulin.');
  });

  it('warns about an unknown framing or move and falls back deterministically', () => {
    const out = compile('film-real', 'action', { framing: 'nope', move: 'nope' });
    expect(out.warnings.join()).toMatch(/framing/);
    expect(out.warnings.join()).toMatch(/move/);
    expect(out.videoPrompt.startsWith('Medium shot, the camera stays still.')).toBe(true);
  });

  it('warns when emotion is missing but still compiles', () => {
    const out = compile('film-real', 'action', { emotion: undefined });
    expect(out.warnings.join()).toMatch(/emotion/);
    expect(out.videoPrompt).toContain('Laras lifts the woven basket');
  });
});
