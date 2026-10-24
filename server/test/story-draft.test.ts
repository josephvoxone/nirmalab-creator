import { describe, expect, it } from 'vitest';
import { draftStoryboard, parseJsonBlock } from '../src/stories/draft.js';
import { buildShotPrompt, validateStoryboard } from '../src/stories/storyboard.js';
import { validateBible } from '../src/bible/story.js';

const goodShots = [
  { id: 'intro', silent: true, prompt: 'Extreme wide shot, the camera pushes in slowly. A misty valley at sunrise, open sky above.' },
  { id: 'Satu Hadiah', prompt: 'Medium shot, the camera stays still. GIRL hugs CAT on a porch.', narration: 'Mimi kucing kesayangan Sari.' },
  { id: 'pulang', prompt: 'Wide shot, the camera pulls back slowly. GIRL carries CAT home.', narration: 'Mereka pulang bersama.' }
];
const good = JSON.stringify({
  title: 'Kucing Hilang',
  titleCard: { lines: ['KUCING', 'HILANG'], kicker: 'Sebuah Dongeng' },
  characters: { GIRL: 'a seven-year-old girl with a yellow dress', CAT: 'a small orange kitten with a blue collar' },
  shots: goodShots
});

describe('parseJsonBlock', () => {
  it('reads JSON from a fenced or chatty reply', () => {
    expect(parseJsonBlock('Here you go:\n```json\n{"a":1}\n```\nEnjoy')).toEqual({ a: 1 });
    expect(parseJsonBlock('{"a":{"b":2}} trailing')).toEqual({ a: { b: 2 } });
    expect(() => parseJsonBlock('no json')).toThrow();
  });
});

describe('draftStoryboard', () => {
  it('turns a premise into a valid storyboard with house defaults filled in', async () => {
    const calls: string[] = [];
    const board = await draftStoryboard({ premise: 'Kucing hilang lalu ditemukan', shots: 3 }, async (_system, prompt) => {
      calls.push(prompt);
      return '```json\n' + good + '\n```';
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('Kucing hilang lalu ditemukan');
    expect(validateStoryboard(board)).toEqual([]);
    expect(board.shots.map(s => s.id)).toEqual(['00-intro', '01-satu-hadiah', '02-pulang']);
    expect(board.aspect).toBe('9:16');
    expect(board.audio).toContain('{line}');
    expect(board.audioSilent).toBeTruthy();
    expect(board.negative).toMatch(/camera equipment/);
    expect(board.crossfade).toBe(0.3);
    expect(board.titleCard?.lines).toEqual(['KUCING', 'HILANG']);
  });

  it('feeds validation errors back to the model and accepts the fix', async () => {
    const broken = JSON.stringify({ title: 'X', characters: {}, shots: [{ id: 'a', prompt: 'A jib arm rises over the town.', narration: 'Halo.' }] });
    const prompts: string[] = [];
    const board = await draftStoryboard({ premise: 'kota' }, async (_s, prompt) => {
      prompts.push(prompt);
      return prompts.length === 1 ? broken : good;
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/gear/);
    expect(board.title).toBe('Kucing Hilang');
  });

  it('gives up after 3 attempts with the remaining problems', async () => {
    await expect(draftStoryboard({ premise: 'x' }, async () => 'tidak ada json')).rejects.toThrow(/3/);
  });

  it('clamps the requested shot count to 3..12', async () => {
    let seen = '';
    await draftStoryboard({ premise: 'x', shots: 99 }, async (_s, p) => { seen = p; return good; });
    expect(seen).toMatch(/exactly 12 shots/);
  });

  it('asks for an Indonesian title and descriptive shot ids', async () => {
    let system = '';
    await draftStoryboard({ premise: 'x' }, async (sys) => { system = sys; return good; });
    expect(system).toMatch(/title.*Bahasa Indonesia/i);
    expect(system).toMatch(/"id" is a short descriptive/);
  });

  it('template + look: style line composed from the picks, mode/narrator/look saved, move list given to the writer', async () => {
    let system = '', prompt = '';
    const board = await draftStoryboard({ premise: 'Kucing hilang', template: 'drama-hewan', look: { palette: 'hujan-biru' } }, async (s, p) => {
      system = s; prompt = p;
      return good;
    });
    expect(board.mode).toBe('konsisten');
    expect(board.template).toBe('drama-hewan');
    expect(board.look).toMatchObject({ style: 'storybook', genre: 'drama', palette: 'hujan-biru' });
    expect(board.style).toMatch(/watercolor/);
    expect(board.style).toMatch(/teal blues/);
    expect(board.narrator).toMatch(/female storyteller/);
    expect(prompt).toMatch(/exactly 8 shots/);
    expect(system + prompt).toMatch(/the camera arcs slowly around the subject/);
    expect(validateStoryboard(board)).toEqual([]);
  });

  it('explicit mode and shot count beat the template', async () => {
    let prompt = '';
    const board = await draftStoryboard({ premise: 'x', template: 'drama-hewan', mode: 'cepat', shots: 4, aspect: '16:9' }, async (_s, p) => { prompt = p; return good; });
    expect(board.mode).toBe('cepat');
    expect(board.aspect).toBe('16:9');
    expect(prompt).toMatch(/exactly 4 shots/);
  });

  it('narration and title read like Indonesian prose: tokens become names, ALL-CAPS title becomes title case', async () => {
    const reply = JSON.stringify({ title: 'JINGGA DI PAGAR', characters: { JINGGA: 'an orange tabby cat' }, shots: [
      { id: 'buka', silent: true, prompt: 'Extreme wide shot, the camera pushes in slowly. A gate.' },
      { id: 'tunggu', prompt: 'Medium shot, the camera stays still. JINGGA waits.', narration: 'Setiap sore, JINGGA menunggu di depan pagar.' }] });
    const board = await draftStoryboard({ premise: 'x', template: 'drama-hewan', shots: 2 }, async () => reply);
    expect(board.shots[1]!.narration).toBe('Setiap sore, Jingga menunggu di depan pagar.');
    expect(board.title).toBe('Jingga di Pagar');
  });

  it('asks the writer for a logline, locations and scenes following the story arc', async () => {
    let system = '';
    await draftStoryboard({ premise: 'x' }, async sys => { system = sys; return good; });
    expect(system).toMatch(/"logline"/);
    expect(system).toMatch(/"locations"/);
    expect(system).toMatch(/"scenes"/);
    expect(system).toMatch(/2-4 scenes/);
    expect(system).toMatch(/setup.*conflict.*turning point.*resolution/i);
  });

  it('parses logline, locations and scenes; scene shot ids follow the shot id rewriting; bad references dropped', async () => {
    const reply = JSON.stringify({
      ...JSON.parse(good),
      logline: 'Seekor kucing hilang dan ditemukan kembali.',
      locations: { DESA: 'a quiet village with wooden houses at dawn', 'laut kecil': 'bad key', HUTAN: { name: 'Hutan Pinus', look: 'a misty pine forest' }, KOSONG: '' },
      scenes: [
        { id: 'Awal Cerita', title: 'Awal', summary: 'Sari dan Mimi.', location: 'DESA', shots: ['intro', 'Satu Hadiah', 'ghost'] },
        { id: 'pulang', title: 'Pulang', location: 'LAUT', shots: ['02-pulang'] }
      ]
    });
    const calls: string[] = [];
    const board = await draftStoryboard({ premise: 'kucing', shots: 3 }, async (_s, p) => { calls.push(p); return reply; });
    expect(calls).toHaveLength(1);
    expect(validateStoryboard(board)).toEqual([]);
    expect(board.logline).toBe('Seekor kucing hilang dan ditemukan kembali.');
    expect(board.locations).toEqual({ DESA: { name: 'Desa', look: 'a quiet village with wooden houses at dawn' }, HUTAN: { name: 'Hutan Pinus', look: 'a misty pine forest' } });
    expect(board.scenes).toEqual([
      { id: 'awal-cerita', title: 'Awal', summary: 'Sari dan Mimi.', location: 'DESA', shots: ['00-intro', '01-satu-hadiah'] },
      { id: 'pulang', title: 'Pulang', shots: ['02-pulang'] }
    ]);
    expect(buildShotPrompt(board, board.shots[1]!)).toContain('Setting: a quiet village with wooden houses at dawn.');
  });

  it('missing scenes fall back to one scene with every shot', async () => {
    const board = await draftStoryboard({ premise: 'kucing', shots: 3 }, async () => good);
    expect(board.scenes).toEqual([{ id: 'scene-1', title: 'Scene 1', shots: ['00-intro', '01-satu-hadiah', '02-pulang'] }]);
    expect(board.locations ?? {}).toEqual({});
  });

  it('never fails a draft only because of broken scenes or locations', async () => {
    const scenes = [
      { title: '', shots: 'intro' }, { id: 'dup', title: 'x'.repeat(200), summary: 'y'.repeat(900), shots: ['pulang'] }, { id: 'dup', title: 'Lagi', shots: [] },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, title: `S${i}`, shots: [] })), 'nonsense'
    ];
    const locations = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`LOC_${i}`, `place ${i}`]));
    const calls: string[] = [];
    const board = await draftStoryboard({ premise: 'kucing', shots: 3 }, async (_s, p) => { calls.push(p); return JSON.stringify({ ...JSON.parse(good), scenes, locations, logline: 42 }); });
    expect(calls).toHaveLength(1);
    expect(validateStoryboard(board)).toEqual([]);
    expect(board.scenes!.length).toBeLessThanOrEqual(20);
    expect(new Set(board.scenes!.map(s => s.id)).size).toBe(board.scenes!.length);
    expect(board.scenes!.flatMap(s => s.shots).sort()).toEqual(['00-intro', '01-satu-hadiah', '02-pulang']);
    expect(Object.keys(board.locations!).length).toBeLessThanOrEqual(20);
    expect(board.logline).toBeUndefined();
    const garbage = await draftStoryboard({ premise: 'kucing', shots: 3 }, async () => JSON.stringify({ ...JSON.parse(good), scenes: 'x', locations: ['y'] }));
    expect(garbage.scenes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// intent + story bible (plan Task 5, spec §4.2/§9.6)
// ---------------------------------------------------------------------------

const intentReply = JSON.stringify({
  title: 'Kucing Hilang',
  bible: {
    logline: 'Sari mencari Mimi yang hilang dan menemukan rumahnya kembali.',
    theme: 'kehilangan dan pulang',
    tone: 'hangat dan sedih',
    audience: 'anak',
    structure: [
      { act: 'hook', goal: 'perkenalkan Sari dan Mimi', beat: 'pagi di teras' },
      { act: 'setup', goal: 'Mimi menghilang', beat: 'pagar terbuka' },
      { act: 'turn', goal: 'Sari berhenti mengejar', beat: 'hujan di pasar' },
      { act: 'payoff', goal: 'Mimi pulang', beat: 'pelukan di teras' }
    ],
    characters: [
      {
        token: 'SARI', name: 'Sari', want: 'ingin Mimi kembali', need: 'belajar merelakan', arc: 'dari mengejar ke menunggu',
        anchors: ['seven years old', 'faded yellow cotton dress', 'red plastic hair clip']
      },
      {
        token: 'MIMI', name: 'Mimi', want: 'ingin pulang', need: 'tempat aman', arc: 'dari liar ke rumahan',
        anchors: ['beautiful', 'orange tabby with a torn left ear']
      }
    ],
    locations: [{ key: 'TERAS', name: 'Teras Rumah', lookdev: 'a wooden porch with a broken gate at dawn' }],
    scenes: [
      { id: 'Awal Cerita', title: 'Awal', goal: 'memperlihatkan ikatan Sari dan Mimi' },
      { id: 'pulang', title: 'Pulang', goal: 'menyatukan mereka lagi' }
    ]
  },
  characters: { SARI: 'a seven-year-old girl in a faded yellow dress', MIMI: 'a small orange tabby with a torn ear' },
  locations: { TERAS: 'a wooden porch with a broken gate at dawn' },
  scenes: [
    { id: 'Awal Cerita', title: 'Awal', summary: 'Sari dan Mimi di teras.', location: 'TERAS', shots: ['intro', 'Satu Hadiah'] },
    { id: 'pulang', title: 'Pulang', summary: 'Mimi pulang.', location: 'TERAS', shots: ['hujan', 'pelukan'] }
  ],
  shots: [
    { id: 'intro', silent: true, framing: 'Extreme wide shot', move: 'the camera pushes in slowly',
      intent: { subject: 'the empty porch', action: 'sits quiet in the dawn mist', startState: 'the porch dark and empty', endState: 'the porch lit by a rising sun, gate ajar', emotion: 'tenang' } },
    { id: 'Satu Hadiah', framing: 'Close-up', move: 'the camera stays still',
      intent: { subject: 'SARI', action: 'hugs MIMI on the porch steps', startState: 'Sari kneels alone, hands empty', endState: 'Mimi held against her chest', emotion: 'lega' },
      narration: 'Sari memeluk Mimi di teras.' },
    { id: 'hujan', framing: 'Cinematic 70mm crane shot', move: 'the camera cranes up over the town',
      intent: { subject: 'SARI', action: 'walks home through the rain', startState: 'Sari alone under the market awning', endState: 'Sari soaked at her own gate', emotion: 'lelah' },
      narration: 'Sari pulang kehujanan.' },
    { id: 'pelukan', framing: 'Wide shot', move: 'the camera pulls back slowly',
      intent: { subject: 'MIMI', action: 'walks back through the broken gate', startState: 'the gate stands empty in the rain', endState: 'Mimi sits on the step, fur wet', emotion: 'haru' },
      narration: 'Mimi pulang saat hujan reda.' }
  ]
});

describe('draftStoryboard: intent + bible', () => {
  it('parses per-shot intent and the story bible, and keeps ids, cast, locations and scenes in sync', async () => {
    const calls: string[] = [];
    const board = await draftStoryboard({ premise: 'Kucing hilang lalu pulang', shots: 4 }, async (_s, p) => { calls.push(p); return intentReply; });
    expect(calls).toHaveLength(1);
    expect(validateStoryboard(board)).toEqual([]);
    expect(board.shots.map(s => s.id)).toEqual(['00-intro', '01-satu-hadiah', '02-hujan', '03-pelukan']);

    // intent is authored, not derived, and carries the camera picks
    expect(board.shots[1]).toMatchObject({
      intent: { subject: 'SARI', action: 'hugs MIMI on the porch steps', startState: 'Sari kneels alone, hands empty', endState: 'Mimi held against her chest', emotion: 'lega' },
      framing: 'Close-up',
      move: 'the camera stays still'
    });
    expect(board.shots[1]!.intentDerived).toBeUndefined();
    expect(board.shots[0]).toMatchObject({ silent: true, framing: 'Extreme wide shot', move: 'the camera pushes in slowly' });

    // no prose from the model: the prompt is compiled from the intent with catalog camera text
    expect(board.shots[1]!.prompt).toBe('Close-up, the camera stays still. SARI hugs MIMI on the porch steps.');
    expect(board.shots[0]!.prompt).toBe('Extreme wide shot, the camera pushes in slowly. the empty porch sits quiet in the dawn mist.');
    // unknown framing/move (crane, 70mm) never reaches a prompt: Veo would render the gear
    expect(board.shots[2]).toMatchObject({ framing: 'Medium close-up', move: 'the camera stays still' });
    expect(board.shots[2]!.prompt).toBe('Medium close-up, the camera stays still. SARI walks home through the rain.');

    const bible = board.bible!;
    expect(bible).toBeDefined();
    expect(bible.logline).toBe('Sari mencari Mimi yang hilang dan menemukan rumahnya kembali.');
    expect(bible.theme).toBe('kehilangan dan pulang');
    expect(bible.tone).toBe('hangat dan sedih');
    expect(bible.audience).toBe('anak');
    expect(bible.structure.map(s => s.act)).toEqual(['hook', 'setup', 'turn', 'payoff']);
    expect(bible.structure[3]).toEqual({ act: 'payoff', goal: 'Mimi pulang', beat: 'pelukan di teras' });
    expect(bible.rules).toEqual({ maxShotSec: 6, narrationMaxWords: 12 });

    // anchors are visible facts: "beautiful" is dropped, the rest survives
    const sari = bible.characters.find(c => c.token === 'SARI')!;
    expect(sari).toMatchObject({ name: 'Sari', want: 'ingin Mimi kembali', need: 'belajar merelakan', arc: 'dari mengejar ke menunggu' });
    expect(sari.anchors).toEqual(['seven years old', 'faded yellow cotton dress', 'red plastic hair clip']);
    expect(bible.characters.find(c => c.token === 'MIMI')!.anchors).toEqual(['orange tabby with a torn left ear']);

    // bible locations/scenes mirror the board (scene ids go through the same slug rewrite)
    expect(bible.locations).toEqual([{ key: 'TERAS', name: 'Teras', lookdev: 'a wooden porch with a broken gate at dawn' }]);
    expect(bible.scenes).toEqual([
      { id: 'awal-cerita', title: 'Awal', goal: 'memperlihatkan ikatan Sari dan Mimi', location: 'TERAS' },
      { id: 'pulang', title: 'Pulang', goal: 'menyatukan mereka lagi', location: 'TERAS' }
    ]);
    // a drafted bible is always saveable: the canonical validator accepts it as-is
    expect(validateBible(bible)).toEqual([]);
  });

  it('legacy reply without intent or bible still drafts: intent derived from the prose, flagged for the compiler', async () => {
    const calls: string[] = [];
    const board = await draftStoryboard({ premise: 'kucing', shots: 3 }, async (_s, p) => { calls.push(p); return good; });
    expect(calls).toHaveLength(1); // never retried just because intent was missing
    expect(validateStoryboard(board)).toEqual([]);
    expect(board.bible).toBeUndefined();
    expect(board.shots.every(s => s.intentDerived === true)).toBe(true);
    // subject = first noun phrase, action = first verb clause, states default conservatively
    expect(board.shots[1]!.intent).toEqual({
      subject: 'GIRL',
      action: 'hugs CAT on a porch',
      startState: 'GIRL in the opening frame, before the action begins',
      endState: 'GIRL in the closing frame, the action complete',
      emotion: 'neutral'
    });
    expect(board.shots[2]!.intent).toMatchObject({ subject: 'GIRL', action: 'carries CAT home' });
    // the silent establishing frame has no verb: noun phrase only, no invented action, no prose lost
    expect(board.shots[0]!.intent).toMatchObject({ subject: 'A misty valley', action: 'remains still' });
    expect(board.shots[0]!.prompt).toBe(goodShots[0]!.prompt);
  });

  it('drops an invalid bible section instead of failing the draft', async () => {
    // no hook and no payoff: the whole bible is dropped, the board stays valid on the legacy path
    const spineBroken = JSON.stringify({
      ...JSON.parse(good),
      bible: {
        logline: 'Sari mencari Mimi.', theme: 'kehilangan', tone: 'hangat', audience: 'robot',
        structure: [{ act: 'setup', goal: 'x', beat: 'y' }, { act: 'montage', goal: 'z', beat: 'w' }],
        characters: [{ token: 'GIRL', name: 'Sari', anchors: ['beautiful'], want: '', need: '' }]
      }
    });
    const calls: string[] = [];
    const noBible = await draftStoryboard({ premise: 'kucing', shots: 3 }, async (_s, p) => { calls.push(p); return spineBroken; });
    expect(calls).toHaveLength(1);
    expect(validateStoryboard(noBible)).toEqual([]);
    expect(noBible.bible).toBeUndefined();
    expect(Object.keys(noBible.characters ?? {})).toEqual(['GIRL', 'CAT']);

    // valid spine, one unusable character card (no anchor, no want/need) and one good card
    const partlyBroken = JSON.stringify({
      ...JSON.parse(good),
      bible: {
        logline: 'Sari mencari Mimi.', theme: 'kehilangan', tone: 'hangat', audience: 'robot',
        structure: [{ act: 'hook', goal: 'perkenalkan', beat: 'pagi' }, { act: 'payoff', goal: 'pulang', beat: 'pelukan' }],
        audienceNote: 'ignored',
        characters: [
          { token: 'CAT', name: 'Mimi', anchors: ['beautiful', 'epic'], want: '', need: '', arc: '' },
          { token: 'GIRL', name: 'Sari', anchors: ['seven years old', 'yellow cotton dress'], want: 'ingin Mimi kembali', need: 'belajar merelakan', arc: 'menunggu' }
        ],
        locations: 'bukan daftar',
        scenes: [{ id: 'ghost', goal: '' }, { title: 'tanpa id', goal: 'tanpa id' }]
      }
    });
    const partly = await draftStoryboard({ premise: 'kucing', shots: 3 }, async () => partlyBroken);
    expect(validateStoryboard(partly)).toEqual([]);
    expect(partly.bible!.audience).toBe('umum');
    expect(partly.bible!.characters.map(c => c.token)).toEqual(['GIRL']);
    // no bible scenes with goals → each board scene gets a deterministic goal
    expect(partly.bible!.scenes).toEqual([{ id: 'scene-1', title: 'Scene 1', goal: 'Beat: Scene 1' }]);
    expect(partly.bible!.locations).toEqual([]);
  });

  it('asks the writer for intent and a story bible', async () => {
    let system = '', prompt = '';
    await draftStoryboard({ premise: 'x' }, async (s, p) => { system = s; prompt = p; return good; });
    expect(system).toMatch(/"intent"/);
    expect(system).toMatch(/"startState"/);
    expect(system).toMatch(/"endState"/);
    expect(system).toMatch(/"bible"/);
    expect(system).toMatch(/anchors/);
    expect(system).toMatch(/hook/);
    expect(system).toMatch(/payoff/);
    expect(prompt).toMatch(/intent per shot/);
  });
});
