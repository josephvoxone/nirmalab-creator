/**
 * P4: the draft writer must produce narration and captions that survive the anti-slop lint.
 *
 * Policy under test: mechanically fixable slop is repaired (emoji, exclamation stacks,
 * shouting, empty adjectives, filler prefixes, over-long narration); a line that only a
 * rewrite can fix is rejected and sent back to the model with the lint's own words.
 */
import { describe, expect, it } from 'vitest';
import { draftStoryboard } from '../src/stories/draft.js';
import { validateStoryboard } from '../src/stories/storyboard.js';
import { lintCopy } from '../src/text/lint.js';

type Reply = Record<string, unknown>;

function reply(overrides: { narration?: string[]; caption?: unknown; logline?: string; shots?: Reply[] } = {}): string {
  const narrations = overrides.narration ?? [
    'Jingga duduk di depan pagar kayu.',
    'Truk pindah pergi meninggalkan kampung.',
    'Jingga menunggu sampai pemiliknya kembali menjemput.'
  ];
  return JSON.stringify({
    title: 'Jingga di Pagar',
    logline: overrides.logline ?? 'Jingga menunggu pemiliknya yang pindah ke kota lain setiap sore di depan pagar.',
    ...(overrides.caption === undefined ? {} : { caption: overrides.caption }),
    characters: { JINGGA: 'a ginger cat with a torn left ear' },
    shots: overrides.shots ?? [
      { id: 'intro', silent: true, prompt: 'Extreme wide shot, the camera pushes in slowly. A village lane at dawn, the gate shut.' },
      { id: 'tunggu', prompt: 'Medium shot, the camera stays still. JINGGA sits by the gate.', narration: narrations[0] },
      { id: 'truk', prompt: 'Wide shot, the camera pulls back slowly. A moving truck leaves the lane.', narration: narrations[1] },
      { id: 'pulang', prompt: 'Medium close-up, the camera stays still. JINGGA waits by the gate.', narration: narrations[2] }
    ]
  });
}

describe('draftStoryboard: narration lint', () => {
  it('leaves a good reply unchanged, in one call', async () => {
    const calls: string[] = [];
    const board = await draftStoryboard({ premise: 'kucing ditinggal pindah', shots: 4 }, async (_s, p) => { calls.push(p); return reply(); });
    expect(calls).toHaveLength(1);
    expect(validateStoryboard(board)).toEqual([]);
    expect(board.shots.map(s => s.narration).filter(Boolean)).toEqual([
      'Jingga duduk di depan pagar kayu.',
      'Truk pindah pergi meninggalkan kampung.',
      'Jingga menunggu sampai pemiliknya kembali menjemput.'
    ]);
    for (const shot of board.shots) if (shot.narration) expect(lintCopy(shot.narration, { kind: 'narration' }), shot.id).toEqual([]);
  });

  it('repairs slop in a narration line instead of asking the model again', async () => {
    const calls: string[] = [];
    const board = await draftStoryboard({ premise: 'kucing', shots: 4 }, async (_s, p) => {
      calls.push(p);
      return reply({ narration: ['Pagar kayu yang indah itu kosong!! 🐈', 'MIMI menunggu truk pergi.', 'Jingga menunggu sampai pemiliknya kembali menjemput.'] });
    });
    expect(calls).toHaveLength(1);
    expect(validateStoryboard(board)).toEqual([]);
    const spoken = board.shots.map(s => s.narration).filter(Boolean) as string[];
    expect(spoken[0]).toBe('Pagar kayu itu kosong.');
    expect(spoken[1]).toBe('Mimi menunggu truk pergi.');
    for (const line of spoken) expect(lintCopy(line, { kind: 'narration' })).toEqual([]);
  });

  it('trims a narration line over 12 words instead of dropping it', async () => {
    const long = 'Jingga menunggu di depan pagar kayu setiap sore sampai pemiliknya kembali menjemputnya di kampung yang sudah sepi itu.';
    const calls: string[] = [];
    const board = await draftStoryboard({ premise: 'kucing', shots: 3 }, async (_s, p) => {
      calls.push(p);
      return reply({ narration: [long, 'Truk pindah pergi meninggalkan kampung.', 'Jingga pulang ke rumah tetangga.'] });
    });
    expect(calls).toHaveLength(1); // no retry: the line is trimmed, not rejected
    expect(board.shots).toHaveLength(4);
    const first = board.shots.find(s => s.narration)!.narration!;
    expect(first.split(/\s+/).length).toBeLessThanOrEqual(12);
    expect(first.startsWith('Jingga menunggu di depan pagar')).toBe(true);
    expect(validateStoryboard(board)).toEqual([]);
  });

  it('sends back a line only a rewrite can fix, naming the rule in Indonesian', async () => {
    const prompts: string[] = [];
    const bad = reply({ narration: ['Dalam dunia yang penuh rahasia, Jingga menunggu di pagar.', 'Truk pindah pergi meninggalkan kampung.', 'Jingga pulang ke rumah tetangga.'] });
    const board = await draftStoryboard({ premise: 'kucing', shots: 4 }, async (_s, p) => {
      prompts.push(p);
      return prompts.length === 1 ? bad : reply();
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/dalam dunia yang/i);
    expect(validateStoryboard(board)).toEqual([]);
    expect(board.shots.find(s => s.narration)!.narration).toBe('Jingga duduk di depan pagar kayu.');
  });

  it('gives up with the lint issue when every attempt keeps the tell', async () => {
    const bad = reply({ narration: ['Mari kita simak Jingga di pagar.', 'Truk pindah pergi meninggalkan kampung.', 'Jingga pulang ke rumah tetangga.'] });
    await expect(draftStoryboard({ premise: 'kucing', shots: 4 }, async () => bad)).rejects.toThrow(/mari kita/i);
  });
});

describe('draftStoryboard: logline and caption', () => {
  it('keeps a clean model caption verbatim', async () => {
    const caption = 'Jingga duduk di pagar kayu.\nTruk pindah pergi pagi itu.\nPemiliknya kembali menjemput.';
    const board = await draftStoryboard({ premise: 'kucing', shots: 4 }, async () => reply({ caption }));
    expect(board.caption).toBe(caption);
    expect(lintCopy(board.caption!, { kind: 'caption' })).toEqual([]);
  });

  it('replaces a sloppy caption with one built from the story facts', async () => {
    const board = await draftStoryboard({ premise: 'kucing', shots: 4 }, async () => reply({ caption: 'Dalam dunia yang indah, mari kita simak kisah mengharukan ini!!' }));
    expect(board.caption).toBeTruthy();
    expect(board.caption).not.toMatch(/dalam dunia yang|mari kita|simak|\bindah\b|!!/i);
    expect(lintCopy(board.caption!, { kind: 'caption' })).toEqual([]);
    expect(board.caption).toContain('Jingga');
  });

  it('always ends up with a lint-clean caption, even when the model sends none', async () => {
    const board = await draftStoryboard({ premise: 'kucing', shots: 4 }, async () => reply());
    expect(board.caption).toBeTruthy();
    expect(lintCopy(board.caption!, { kind: 'caption' })).toEqual([]);
    expect(board.caption!.split('\n')[0]).toContain('Jingga');
  });

  it('drops a logline that stays slop after repair, keeping the board valid', async () => {
    const board = await draftStoryboard({ premise: 'kucing', shots: 4 }, async () => reply({ logline: 'Dalam dunia yang indah, mari kita simak kisah ini.' }));
    expect(validateStoryboard(board)).toEqual([]);
    if (board.logline) expect(lintCopy(board.logline, { kind: 'caption' })).toEqual([]);
  });
});

describe('draftStoryboard: the system prompt teaches the rules', () => {
  it('tells the writer one concrete action per line, 12 words, name the character, no adjectives, no camera', async () => {
    let system = '';
    await draftStoryboard({ premise: 'x' }, async sys => { system = sys; return reply(); });
    expect(system).toMatch(/one concrete action or image per line/i);
    expect(system).toMatch(/max 12 words/i);
    expect(system).toMatch(/name the character/i);
    expect(system).toMatch(/no adjective without evidence/i);
    expect(system).toMatch(/never describe the camera/i);
  });

  it('teaches the caption hook formula: concrete first line, one tension, one payoff', async () => {
    let system = '';
    await draftStoryboard({ premise: 'x' }, async sys => { system = sys; return reply(); });
    expect(system).toMatch(/"caption"/);
    expect(system).toMatch(/concrete first line/i);
    expect(system).toMatch(/one tension/i);
    expect(system).toMatch(/one payoff/i);
  });
});
