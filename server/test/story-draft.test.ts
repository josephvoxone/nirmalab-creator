import { describe, expect, it } from 'vitest';
import { draftStoryboard, parseJsonBlock } from '../src/stories/draft.js';
import { buildShotPrompt, validateStoryboard } from '../src/stories/storyboard.js';

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
