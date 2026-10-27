import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bibleSceneErrors, syncBible } from '../src/bible/sync.js';
import { StoryError } from '../src/stories/service.js';
import { castOf, hashFor, promptFromIntent, validateStoryboard, type Storyboard } from '../src/stories/storyboard.js';
import { bibleBoard, renderedStory, serviceSetup } from './bible-board.js';

const card = (board: Storyboard, token: string) => board.bible!.characters.find(c => c.token === token)!;
const withCard = (board: Storyboard, token: string, patch: object): Storyboard => ({
  ...board,
  bible: { ...board.bible!, characters: board.bible!.characters.map(c => (c.token === token ? { ...c, ...patch } : c)) }
});

describe('syncBible: characters', () => {
  it('keeps look frozen when only want/need/arc/name change', () => {
    const prev = bibleBoard();
    const next = withCard(prev, 'LARAS', { want: 'pulang cepat', need: 'teman', arc: 'sendiri menjadi bersama', name: 'Laras Ayu' });
    const out = syncBible(next, prev);
    // The look (sheet) stays frozen; the new name reaches the cast (Flow picks a character by it).
    expect(out.characters!.LARAS).toEqual({ name: 'Laras Ayu', look: 'a girl with two black braids' });
    expect(out.characters!.KAPAS).toEqual({ name: 'Kapas', look: 'a cream rabbit with a red scarf' });
  });

  it('rebuilds look from name + anchors only for the character whose anchors changed', () => {
    const prev = bibleBoard();
    const next = withCard(withCard(prev, 'KAPAS', { anchors: ['a cream rabbit', 'a red knitted scarf'] }), 'LARAS', { want: 'x' });
    const out = syncBible(next, prev);
    expect(out.characters!.KAPAS).toEqual({ name: 'Kapas', look: 'Kapas, a cream rabbit, a red knitted scarf' });
    expect(out.characters!.LARAS).toBe('a girl with two black braids');
    const laras = syncBible(withCard(prev, 'LARAS', { anchors: ['two red braids'] }), prev);
    expect(laras.characters!.LARAS).toBe('Laras, two red braids');
  });

  it('a card that predates the cast sync (no board entry before or now) gets one on the next save', () => {
    // Shape of an older production board: bible card PAK_TUA, no board.characters at all.
    const base = bibleBoard();
    const old: Storyboard = { ...base, characters: undefined, bible: { ...base.bible!, characters: [{ token: 'PAK_TUA', name: 'Pak Tua', anchors: ['topi jerami lebar', 'kemeja biru lusuh'], want: 'a', need: 'b', arc: 'c' }] } };
    const out = syncBible(old, old);
    expect(out.characters).toEqual({ PAK_TUA: 'Pak Tua, topi jerami lebar, kemeja biru lusuh' });
    // A cast entry the user removed on the board side (it existed before) stays removed.
    const removed = syncBible({ ...base, characters: { KAPAS: base.characters!.KAPAS! } }, base);
    expect(removed.characters!.LARAS).toBeUndefined();
  });

  it('a new bible character gets a board character (sheet + TOKEN expansion work)', () => {
    const prev = bibleBoard();
    const next: Storyboard = { ...prev, bible: { ...prev.bible!, characters: [...prev.bible!.characters, { token: 'BAPAK', name: 'Pak Darto', anchors: ['a grey moustache', 'a brown sarong'], want: 'a', need: 'b', arc: 'c' }] } };
    expect(syncBible(next, prev).characters!.BAPAK).toEqual({ name: 'Pak Darto', look: 'Pak Darto, a grey moustache, a brown sarong' });
    const tokenNamed = { ...next, bible: { ...next.bible!, characters: [...prev.bible!.characters, { token: 'DARTO', name: 'Darto', anchors: ['a grey moustache'], want: 'a', need: 'b', arc: 'c' }] } };
    expect(syncBible(tokenNamed, prev).characters!.DARTO).toBe('Darto, a grey moustache');   // name = titleCase(token): plain string as before
  });

  it('does not touch the inputs', () => {
    const prev = bibleBoard();
    const next = withCard(prev, 'KAPAS', { anchors: ['a grey rabbit'] });
    const copy = JSON.stringify(next);
    syncBible(next, prev);
    expect(JSON.stringify(next)).toBe(copy);
    expect(card(next, 'KAPAS').anchors).toEqual(['a grey rabbit']);
  });
});

describe('syncBible: locations and scenes', () => {
  it('mirrors a bible lookdev edit to the board look', () => {
    const prev = bibleBoard();
    const next: Storyboard = { ...prev, bible: { ...prev.bible!, locations: [{ key: 'PASAR_IKAN', name: 'Pasar Ikan', lookdev: 'a quiet fish market at noon, dry stones' }] } };
    const out = syncBible(next, prev);
    expect(out.locations!.PASAR_IKAN!.look).toBe('a quiet fish market at noon, dry stones');
    expect(out.bible!.locations[0]!.lookdev).toBe('a quiet fish market at noon, dry stones');
  });

  it('mirrors a board look edit to the bible lookdev, and a new board location into the bible', () => {
    const prev = bibleBoard();
    const next: Storyboard = { ...prev, locations: { PASAR_IKAN: { name: 'Pasar Ikan', look: 'a fish market in the rain' }, HUTAN: { name: 'Hutan', look: 'a misty pine forest' } } };
    const out = syncBible(next, prev);
    expect(out.bible!.locations).toEqual([
      { key: 'PASAR_IKAN', name: 'Pasar Ikan', lookdev: 'a fish market in the rain' },
      { key: 'HUTAN', name: 'Hutan', lookdev: 'a misty pine forest' }
    ]);
  });

  it('the bible wins when both sides changed', () => {
    const prev = bibleBoard();
    const next: Storyboard = {
      ...prev,
      locations: { PASAR_IKAN: { name: 'Pasar Ikan', look: 'board side' } },
      bible: { ...prev.bible!, locations: [{ key: 'PASAR_IKAN', name: 'Pasar Ikan', lookdev: 'bible side' }] }
    };
    const out = syncBible(next, prev);
    expect(out.locations!.PASAR_IKAN!.look).toBe('bible side');
    expect(out.bible!.locations[0]!.lookdev).toBe('bible side');
  });

  it('mirrors scene title/location both ways and keeps the goal on the bible card', () => {
    const prev = bibleBoard();
    const renamed = syncBible({ ...prev, scenes: [{ ...prev.scenes![0]!, title: 'Pasar Subuh' }] }, prev);
    expect(renamed.bible!.scenes[0]).toMatchObject({ id: 'pasar', title: 'Pasar Subuh', goal: 'Laras menyembunyikan Kapas dari pembeli' });
    const moved = syncBible({ ...prev, bible: { ...prev.bible!, scenes: [{ ...prev.bible!.scenes[0]!, title: 'Pasar Siang' }] } }, prev);
    expect(moved.scenes![0]!.title).toBe('Pasar Siang');
  });

  it('a card matched by title (not id) gets the scene title/location mirrored, like the goal check finds it', () => {
    const prev: Storyboard = {
      ...bibleBoard(),
      locations: { ...bibleBoard().locations!, HUTAN: { name: 'Hutan', look: 'a misty pine forest' } }
    };
    prev.bible = { ...prev.bible!, locations: [...prev.bible!.locations, { key: 'HUTAN', name: 'Hutan', lookdev: 'a misty pine forest' }] };
    const next: Storyboard = {
      ...prev,
      scenes: [...prev.scenes!, { id: 'hutan', title: 'Ke Hutan', location: 'HUTAN', shots: [] }],
      bible: { ...prev.bible!, scenes: [...prev.bible!.scenes, { id: 'scene-2', title: 'ke hutan', goal: 'Kapas kabur ke hutan' }] }
    };
    const out = syncBible(next, prev);
    expect(bibleSceneErrors(out, prev)).toEqual([]);
    expect(out.bible!.scenes).toHaveLength(2);
    expect(out.bible!.scenes.find(c => c.id === 'scene-2')).toMatchObject({ title: 'ke hutan', goal: 'Kapas kabur ke hutan', location: 'HUTAN' });
    expect(out.scenes!.find(s => s.id === 'hutan')!.title).toBe('ke hutan');
  });

  it('a new board scene without a bible card (add_scene without goal) is rejected; with a card it passes', () => {
    const prev = bibleBoard();
    const added: Storyboard = { ...prev, scenes: [...prev.scenes!, { id: 'hutan', title: 'Ke Hutan', shots: [] }] };
    expect(bibleSceneErrors(syncBible(added, prev), prev)).toEqual(['scene Ke Hutan: tujuan (goal) wajib di proyek bible']);
    const carded: Storyboard = { ...added, bible: { ...added.bible!, scenes: [...added.bible!.scenes, { id: 'hutan', title: 'Ke Hutan', goal: 'Kapas kabur ke hutan' }] } };
    expect(bibleSceneErrors(syncBible(carded, prev), prev)).toEqual([]);
  });
});

describe('cast display names', () => {
  it('a bible name that differs from the token reaches the cast (Flow + prompts); a token-shaped name keeps the plain look string', () => {
    const board = bibleBoard();
    const synced = syncBible(board) as Storyboard;
    expect(typeof synced.characters!.LARAS).toBe('string');             // "Laras" = titleCase(LARAS): unchanged format, unchanged hashes
    const named = bibleBoard();
    named.bible!.characters[0]!.name = 'Laras Sederhana';
    delete named.characters!.LARAS;                                      // a fresh card (new project)
    const s2 = syncBible(named) as Storyboard;
    expect(castOf(s2).find(c => c.token === 'LARAS')?.name).toBe('Laras Sederhana');
  });

  it('renaming a card without touching its anchors renames the cast member', () => {
    const prev = syncBible(bibleBoard()) as Storyboard;
    const next = JSON.parse(JSON.stringify(prev)) as Storyboard;
    next.bible!.characters[0]!.name = 'Laras Sukses';
    const s = syncBible(next, prev) as Storyboard;
    expect(castOf(s).find(c => c.token === 'LARAS')?.name).toBe('Laras Sukses');
    expect(castOf(s).find(c => c.token === 'LARAS')?.look).toBe(castOf(prev).find(c => c.token === 'LARAS')?.look);   // sheet look frozen
  });

  it('validateStoryboard rejects cast names that equal or word-prefix each other, also on boards without a bible', () => {
    const board: Storyboard = { title: 't', mode: 'konsisten', characters: { NADIA: 'a woman in white', NADIA_SUKSES: 'a woman in black' }, shots: [{ id: 'a', prompt: 'NADIA and NADIA_SUKSES meet.', narration: 'Dua wajah.' }] };
    expect(validateStoryboard(board).join()).toMatch(/karakter NADIA_SUKSES: nama "Nadia Sukses" bentrok dengan "Nadia" \(NADIA\)/);
    board.characters = { NADIA_SEDERHANA: 'a woman in white', NADIA_SUKSES: 'a woman in black' };
    expect(validateStoryboard(board)).toEqual([]);
  });
});

describe('promptFromIntent', () => {
  it('builds "<framing>, the camera <move>. <TOKEN> <action>." with the tokens named in the subject', () => {
    const board = bibleBoard();
    const shot = board.shots[1]!;
    expect(promptFromIntent(board, shot)).toBe('Medium close-up, the camera pushes in slowly. LARAS lifts the woven basket off the wet stones.');
    const byName = { ...shot, intent: { ...shot.intent!, subject: 'laras and Kapas', framing: 'wide', move: 'static' } };
    expect(promptFromIntent(board, byName)).toBe('Wide shot, the camera stays still. LARAS and KAPAS lifts the woven basket off the wet stones.');
    const nobody = { ...shot, intent: { ...shot.intent!, subject: 'the wet stones', action: 'glisten under the lamp', framing: undefined, move: undefined } };
    expect(promptFromIntent(board, nobody)).toBe('Medium shot, the camera stays still. the wet stones glisten under the lamp.');
  });

  it('a name inside a longer name is not a second character ("Nadia" in "Nadia Sukses")', () => {
    const board = bibleBoard();
    board.bible!.characters[1]!.name = `${board.bible!.characters[0]!.name} Dewasa`;
    const shot = { ...board.shots[1]!, intent: { ...board.shots[1]!.intent!, subject: `${board.bible!.characters[0]!.name} Dewasa`, framing: 'wide', move: 'static' } };
    expect(promptFromIntent(board, shot)).toBe('Wide shot, the camera stays still. KAPAS lifts the woven basket off the wet stones.');
  });
});

describe('updateStoryboard on bible boards', () => {
  it('rebuilds shot.prompt for an edited intent and keeps the paid clip (status, jobId, promptHash) of an unchanged one', async () => {
    const t = serviceSetup();
    const done = await renderedStory(t, bibleBoard());
    expect(done.shots.map(s => s.status)).toEqual(['done', 'done']);
    const board = await t.service.readStoryboard(done.id);
    const hash01 = hashFor(board, board.shots[0]!);
    const edited = await t.service.updateStoryboard(done.id, {
      ...board,
      shots: board.shots.map(s => (s.id === '02-kapas' ? { ...s, intent: { ...s.intent!, subject: 'KAPAS', action: 'peeks out of the woven basket' } } : s))
    });
    const saved = await t.service.readStoryboard(done.id);
    expect(saved.shots[1]!.prompt).toBe('Medium close-up, the camera pushes in slowly. KAPAS peeks out of the woven basket.');
    // The unchanged shot keeps its own prose (it differs from what promptFromIntent would write).
    expect(saved.shots[0]!.prompt).toBe('Medium shot, the camera stays still. LARAS waits behind the fish stall at dawn.');
    expect(promptFromIntent(board, board.shots[0]!)).not.toBe(saved.shots[0]!.prompt);
    expect(edited.shots[0]).toEqual(done.shots[0]);
    expect(edited.shots[0]!.promptHash).toBe(hash01);
    expect(edited.shots[1]!.status).toBe('pending');
  });

  it('a prompt rebuild never moves the clip hash of a bible shot (the compiler ignores shot.prompt)', () => {
    const board = bibleBoard();
    const shot = board.shots[0]!;
    expect(hashFor(board, { ...shot, prompt: promptFromIntent(board, shot) })).toBe(hashFor(board, shot));
    expect(hashFor(board, { ...shot, prompt: 'anything else' })).toBe(hashFor(board, shot));
  });

  it('writes both sides of a location edit and rejects a new scene without a goal', async () => {
    const t = serviceSetup();
    const story = await t.service.create(bibleBoard());
    const board = await t.service.readStoryboard(story.id);
    await t.service.updateStoryboard(story.id, { ...board, bible: { ...board.bible!, locations: [{ key: 'PASAR_IKAN', name: 'Pasar Ikan', lookdev: 'a quiet fish market at noon' }] } });
    expect((await t.service.readStoryboard(story.id)).locations!.PASAR_IKAN!.look).toBe('a quiet fish market at noon');

    const fresh = await t.service.readStoryboard(story.id);
    const error = await t.service.updateStoryboard(story.id, { ...fresh, scenes: [...fresh.scenes!, { id: 'hutan', title: 'Ke Hutan', shots: [] }] }).catch(e => e);
    expect(error).toBeInstanceOf(StoryError);
    expect((error as StoryError).code).toBe('INVALID');
    expect((error as StoryError).message).toContain('scene Ke Hutan: tujuan (goal) wajib di proyek bible');
  });

  it('an unchanged re-save of a rendered bible board keeps the bytes, the rev and every take', async () => {
    const t = serviceSetup();
    const done = await renderedStory(t, bibleBoard());
    expect(done.shots.map(s => s.status)).toEqual(['done', 'done']);
    const file = join(t.dataDir, 'stories', done.id, 'storyboard.json');
    const bytes = readFileSync(file, 'utf8');
    const saved = await t.service.updateStoryboard(done.id, await t.service.readStoryboard(done.id), { rev: done.rev });
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(saved.rev).toBe(done.rev);
    expect(saved.shots).toEqual(done.shots);
    expect(saved.status).toBe('done');
    expect(saved.videoStale).toBeUndefined();
  });

  it('leaves legacy boards exactly as sent (no sync)', async () => {
    const t = serviceSetup();
    const legacy: Storyboard = {
      title: 'Lama', audio: 'Audio: "{line}"', characters: { MIMI: 'a grey kitten' },
      shots: [{ id: '01-a', prompt: 'Medium shot of MIMI on a porch.', narration: 'Mimi menunggu.' }]
    };
    const story = await t.service.create(legacy);
    const board = await t.service.readStoryboard(story.id);
    await t.service.updateStoryboard(story.id, { ...board, title: 'Lama sekali' });
    expect(await t.service.readStoryboard(story.id)).toEqual({ ...board, title: 'Lama sekali' });
  });
});
