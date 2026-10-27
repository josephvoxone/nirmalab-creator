import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTIONS, runAction, toolSpecs, type ActionContext, type ActionName, type ActionResult } from '../src/assistant/actions.js';
import { resolveScene, resolveShot } from '../src/assistant/resolve.js';
import { imageInfo } from '../src/assistant/uploads.js';
import { buildApp } from '../src/app.js';
import { FlowStore } from '../src/flow/store.js';
import { CATALOG } from '../src/stories/looks.js';
import { STALE_MESSAGE } from '../src/stories/service.js';
import type { SnapshotStore } from '../src/stories/snapshots.js';
import { compileBoardShot, validateStoryboard, type Storyboard } from '../src/stories/storyboard.js';
import { bibleBoard, finishQueued, renderedStory, serviceSetup } from './bible-board.js';

type T = ReturnType<typeof serviceSetup>;

const ctxFor = (t: T, extra: Partial<ActionContext> = {}): ActionContext => ({
  stories: t.service, snapshots: t.service.snapshots, userId: 'u_admin', source: 'chat', turn: {}, ...extra
});
const run = (ctx: ActionContext, storyId: string, name: ActionName, input: Record<string, unknown> = {}) => ACTIONS[name].run(ctx, storyId, input);
const boardFile = (t: T, id: string) => join(t.dataDir, 'stories', id, 'storyboard.json');
const okOf = (r: ActionResult) => { if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`); return r; };
const errOf = (r: ActionResult) => { if (r.ok || 'needsConfirm' in r) throw new Error(`expected error, got ${JSON.stringify(r)}`); return r.error; };

const legacyBoard = (): Storyboard => ({
  title: 'Kucing Hilang',
  audio: 'Audio: voice-over: "{line}"',
  shots: [
    { id: '00-intro', silent: true, prompt: 'Extreme wide shot of a valley.' },
    { id: '01-a', prompt: 'Medium shot of a kitten on a porch.', narration: 'Mimi menunggu.' }
  ]
});

/** Two scenes, three shots: numbering runs 1..3 across scenes in board order. */
const twoScenes = (): Storyboard => {
  const b = bibleBoard();
  return {
    ...b,
    scenes: [...b.scenes!, { id: 'gang', title: 'Di Gang', location: 'PASAR_IKAN', shots: ['03-gang'] }],
    bible: { ...b.bible!, scenes: [...b.bible!.scenes, { id: 'gang', title: 'Di Gang', goal: 'Laras membawa Kapas keluar pasar', location: 'PASAR_IKAN' }] },
    shots: [...b.shots, {
      id: '03-gang', prompt: 'Wide shot, the camera tracks alongside the subject. LARAS carries the basket into the alley.', narration: 'Laras berlari ke gang.',
      intent: { subject: 'LARAS', action: 'carries the basket into the narrow alley', startState: 'she stands at the market gate', endState: 'she disappears into the alley', framing: 'wide', move: 'tracking', emotion: 'tegang' }
    }]
  };
};

/** konsisten board where shot 2 shows KAPAS, so the cast is LARAS + KAPAS. */
const konsistenBoard = (engine?: Storyboard['engine']): Storyboard => {
  const b = bibleBoard();
  return {
    ...b, mode: 'konsisten', ...(engine ? { engine } : {}),
    shots: b.shots.map(s => (s.id === '02-kapas'
      ? { ...s, prompt: 'Medium close-up, the camera pushes in slowly. KAPAS hides in the woven basket.', intent: { ...s.intent!, subject: 'KAPAS', action: 'hides deeper in the woven basket' } }
      : s))
  };
};

function png(w: number, h: number, size = 2000): Buffer {
  const buf = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

function jpeg(w: number, h: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(1000, 0), Buffer.from([0xff, 0xd9])]);
}

function webpVp8x(w: number, h: number): Buffer {
  const buf = Buffer.alloc(1200, 0);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf.writeUIntLE(w - 1, 24, 3);
  buf.writeUIntLE(h - 1, 27, 3);
  return buf;
}

describe('number → id resolution', () => {
  it('numbers shots 1..N across scenes in board order and scenes 1..M; unknown lists the valid range', () => {
    const b = twoScenes();
    expect(resolveShot(b, 3)).toEqual({ id: '03-gang', n: 3 });
    expect(resolveShot(b, '2')).toEqual({ id: '02-kapas', n: 2 });
    expect(resolveShot(b, 'shot 1')).toEqual({ id: '01-laras', n: 1 });
    expect(resolveShot(b, '02-kapas')).toEqual({ id: '02-kapas', n: 2 });
    expect(resolveShot(b, 99)).toEqual({ error: 'Shot 99 tidak ada. Shot yang ada: 1–3.' });
    expect(resolveScene(b, 2)).toEqual({ id: 'gang', n: 2 });
    expect(resolveScene(b, 'pasar')).toEqual({ id: 'pasar', n: 1 });
    expect('error' in resolveScene(b, 5) && resolveScene(b, 5)).toEqual({ error: 'Scene 5 tidak ada. Scene yang ada: 1–2.' });
  });
});

describe('image uploads (helper)', () => {
  it('reads w/h from PNG, JPEG and WebP headers and refuses other bytes', () => {
    expect(imageInfo(png(768, 1376))).toMatchObject({ mime: 'image/png', ext: 'png', w: 768, h: 1376 });
    expect(imageInfo(jpeg(640, 480))).toMatchObject({ mime: 'image/jpeg', ext: 'jpg', w: 640, h: 480 });
    expect(imageInfo(webpVp8x(1024, 1536))).toMatchObject({ mime: 'image/webp', ext: 'webp', w: 1024, h: 1536 });
    expect(imageInfo(Buffer.from('hello, this is not an image at all'))).toBeUndefined();
  });
});

describe('get_project', () => {
  it('summarises scenes and globally numbered shots, characters, locations and the remaining cost', async () => {
    const t = serviceSetup();
    const story = await t.service.create(twoScenes());
    const r = okOf(await run(ctxFor(t), story.id, 'get_project'));
    const data = r.data as { title: string; rev: number; scenes: Array<{ n: number; id: string }>; shots: Array<{ n: number; id: string; scene: number }>; characters: Array<{ token: string }>; locations: unknown[]; estimate: { credits?: number } };
    expect(data.title).toBe('Pasar Pagi');
    expect(data.rev).toBe(1);
    expect(data.scenes.map(s => [s.n, s.id])).toEqual([[1, 'pasar'], [2, 'gang']]);
    expect(data.shots.map(s => [s.n, s.id, s.scene])).toEqual([[1, '01-laras', 1], [2, '02-kapas', 1], [3, '03-gang', 2]]);
    expect(data.characters.map(c => c.token)).toEqual(['LARAS', 'KAPAS']);
    expect(data.locations).toHaveLength(1);
    expect(data.estimate.credits).toBe(30);
  });

  it('stays compact for a full 30-shot project', async () => {
    const t = serviceSetup();
    const b = bibleBoard();
    const long = 'x'.repeat(400);
    const shots = Array.from({ length: 30 }, (_, i) => ({ ...b.shots[0]!, id: `s-${i + 1}`, narration: 'Laras pergi ke pasar pagi itu.', intent: { ...b.shots[0]!.intent!, action: `stands still behind the fish stall ${long}` } }));
    const story = await t.service.create({ ...b, shots, scenes: [{ ...b.scenes![0]!, shots: shots.map(s => s.id) }] });
    const r = okOf(await run(ctxFor(t), story.id, 'get_project'));
    expect(JSON.stringify(r.data).length).toBeLessThan(6000);
  });
});

describe('edit_shot', () => {
  it('bible board: edits the intent, rebuilds the prompt, snapshots once per turn and bumps rev each time', async () => {
    const t = serviceSetup();
    const story = await t.service.create(twoScenes());
    const before = readFileSync(boardFile(t, story.id), 'utf8');
    const ctx = ctxFor(t);
    const r = okOf(await run(ctx, story.id, 'edit_shot', { shot: 3, action: 'runs with the basket into the narrow alley' }));
    expect(r.changed).toBe(true);
    expect(r.label).toMatch(/Shot 3/);
    const board = await t.service.readStoryboard(story.id);
    const shot = board.shots.find(s => s.id === '03-gang')!;
    expect(shot.intent!.action).toBe('runs with the basket into the narrow alley');
    expect(shot.prompt).toContain('LARAS runs with the basket into the narrow alley');
    expect(board.shots.find(s => s.id === '01-laras')).toEqual(twoScenes().shots[0]);
    expect((await t.service.get(story.id))!.rev).toBe(2);
    expect(ctx.turn.undoId).toBeTruthy();
    const first = ctx.turn.undoId;

    okOf(await run(ctx, story.id, 'edit_shot', { shot: 1, emotion: 'lega' }));
    expect(ctx.turn.undoId).toBe(first);
    expect((await t.service.get(story.id))!.rev).toBe(3);
    const snaps = await t.service.snapshots.list(story.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.revAfter).toBe(3);
    // The one snapshot of the turn holds the board from before the turn.
    expect(snaps[0]!.storyboard).toBe(before);
  });

  it('bible board: raw prompt text is refused (intent only) and nothing changes', async () => {
    const t = serviceSetup();
    const story = await t.service.create(twoScenes());
    const before = readFileSync(boardFile(t, story.id), 'utf8');
    const error = errOf(await run(ctxFor(t), story.id, 'edit_shot', { shot: 1, prompt: 'A cinematic shot of Laras.' }));
    expect(error).toMatch(/intent/);
    expect(readFileSync(boardFile(t, story.id), 'utf8')).toBe(before);
    expect(await t.service.snapshots.list(story.id)).toHaveLength(0);
  });

  it('bible board: an edit that breaks a compiling shot is refused with the compiler issues', async () => {
    const t = serviceSetup();
    const story = await t.service.create(twoScenes());
    const error = errOf(await run(ctxFor(t), story.id, 'edit_shot', { shot: 1, endState: 'her hands are empty' }));
    expect(error).toMatch(/state change/);
    expect((await t.service.get(story.id))!.rev).toBe(1);
  });

  it('bible board: framing must be a catalog id', async () => {
    const t = serviceSetup();
    const story = await t.service.create(twoScenes());
    expect(errOf(await run(ctxFor(t), story.id, 'edit_shot', { shot: 1, framing: 'drone shot' }))).toMatch(/medium-close/);
    okOf(await run(ctxFor(t), story.id, 'edit_shot', { shot: 1, framing: 'close-up', move: 'push-in' }));
    const shot = (await t.service.readStoryboard(story.id)).shots[0]!;
    expect(shot.intent).toMatchObject({ framing: 'close-up', move: 'push-in' });
    expect(shot.prompt.startsWith('Close-up, the camera pushes in slowly.')).toBe(true);
  });

  it('camera ids: rack-focus is a catalog move and compiles as one; spelled loosely it is normalised; unknown ids list the choices', async () => {
    expect(CATALOG.moves.map(m => m.id)).toContain('rack-focus');
    const t = serviceSetup();
    const story = await t.service.create(twoScenes());
    okOf(await run(ctxFor(t), story.id, 'edit_shot', { shot: 1, move: 'rack-focus' }));
    let board = await t.service.readStoryboard(story.id);
    expect(board.shots[0]!.intent!.move).toBe('rack-focus');
    expect(compileBoardShot(board, board.shots[0]!).videoPrompt).toContain('focus shifts from the foreground to the subject');
    expect(compileBoardShot(board, board.shots[0]!).videoPrompt).not.toContain('the camera stays still');
    okOf(await run(ctxFor(t), story.id, 'edit_shot', { shot: 2, move: 'Rack Focus', framing: 'Medium Close' }));
    board = await t.service.readStoryboard(story.id);
    expect(board.shots[1]!.intent).toMatchObject({ move: 'rack-focus', framing: 'medium-close' });
    const error = errOf(await run(ctxFor(t), story.id, 'edit_shot', { shot: 1, move: 'snap-focus' }));
    expect(error).toMatch(/snap-focus/);
    for (const id of CATALOG.moves.map(m => m.id)) expect(error).toContain(id);
    const added = okOf(await run(ctxFor(t), story.id, 'add_shot', {
      scene: 1, subject: 'KAPAS', action: 'peeks out of the woven basket', startState: 'the basket lid is closed', endState: 'one floppy ear shows above the rim',
      framing: 'close-up', move: 'rack focus', narration: 'Kapas mengintip dari keranjang.'
    }));
    expect(added.ok).toBe(true);
    board = await t.service.readStoryboard(story.id);
    expect(board.shots.find(s => s.intent?.subject === 'KAPAS' && s.intent.action.includes('peeks'))!.intent!.move).toBe('rack-focus');
    expect(errOf(await run(ctxFor(t), story.id, 'add_shot', {
      scene: 1, subject: 'KAPAS', action: 'hops out', startState: 'in the basket', endState: 'on the floor', move: 'snap-focus'
    }))).toMatch(/Pilihan: .*rack-focus/);
  });

  it('tool schemas carry the catalog framing and move ids as enums', () => {
    for (const name of ['edit_shot', 'add_shot'] as const) {
      const props = (toolSpecs().find(s => s.function.name === name)!.function.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
      expect(props.framing!.enum).toEqual(CATALOG.framings.map(f => f.id));
      expect(props.move!.enum).toEqual(CATALOG.moves.map(m => m.id));
    }
  });

  it('legacy board: edits only that shot\'s prose, passes validateStoryboard, keeps the other paid clip', async () => {
    const t = serviceSetup();
    const done = await renderedStory(t, legacyBoard());
    const introBefore = done.shots.find(s => s.id === '00-intro')!;
    okOf(await run(ctxFor(t), done.id, 'edit_shot', { shot: 2, prompt: 'Close-up of a kitten asleep on a porch.', narration: 'Mimi tertidur.' }));
    const board = await t.service.readStoryboard(done.id);
    expect(board.bible).toBeUndefined();
    expect(board.shots[1]).toMatchObject({ id: '01-a', prompt: 'Close-up of a kitten asleep on a porch.', narration: 'Mimi tertidur.' });
    expect(board.shots[0]).toEqual(legacyBoard().shots[0]);
    expect(validateStoryboard(board)).toEqual([]);
    const record = (await t.service.get(done.id))!;
    expect(record.shots.find(s => s.id === '00-intro')).toEqual(introBefore);
    expect(record.shots.find(s => s.id === '01-a')!.status).toBe('pending');
  });

  it('legacy board: intent fields are refused (no silent upgrade to a bible)', async () => {
    const t = serviceSetup();
    const story = await t.service.create(legacyBoard());
    expect(errOf(await run(ctxFor(t), story.id, 'edit_shot', { shot: 2, action: 'sleeps' }))).toMatch(/bible/);
    expect((await t.service.readStoryboard(story.id)).bible).toBeUndefined();
  });

  it('unknown shot 99 → plain error listing valid numbers, nothing changed, no snapshot', async () => {
    const t = serviceSetup();
    const story = await t.service.create(twoScenes());
    const before = readFileSync(boardFile(t, story.id), 'utf8');
    const error = errOf(await run(ctxFor(t), story.id, 'edit_shot', { shot: 99, emotion: 'lega' }));
    expect(error).toBe('Shot 99 tidak ada. Shot yang ada: 1–3.');
    expect(error).toContain('1–');
    expect(readFileSync(boardFile(t, story.id), 'utf8')).toBe(before);
    expect(await t.service.snapshots.list(story.id)).toHaveLength(0);
  });
});

describe('scope', () => {
  it('an action on story A never touches story B, even with B\'s shot ids or B\'s undo id', async () => {
    const t = serviceSetup();
    const a = await t.service.create(legacyBoard());
    const b = await t.service.create(twoScenes());
    const bBefore = readFileSync(boardFile(t, b.id), 'utf8');
    const ctx = ctxFor(t);
    expect(errOf(await run(ctx, a.id, 'edit_shot', { shot: '03-gang', prompt: 'Close-up of a kitten.' }))).toMatch(/Shot yang ada: 1–2/);
    expect(errOf(await run(ctx, a.id, 'remove_shot', { shot: '02-kapas' }))).toMatch(/tidak ada/);
    expect(errOf(await run(ctxFor(t, { confirmed: true }), a.id, 'render', { shot: '03-gang' }))).toMatch(/tidak ada/);
    // A turn id that belongs to B is never committed by an edit of A.
    const bTurn = await t.service.snapshots.take(b.id, 'b');
    const mixed = ctxFor(t, { turn: { undoId: bTurn.undoId } });
    okOf(await run(mixed, a.id, 'edit_shot', { shot: 2, narration: 'Mimi pulang.' }));
    expect(mixed.turn.undoId).not.toBe(bTurn.undoId);
    expect((await t.service.snapshots.get(bTurn.undoId))!.revAfter).toBeUndefined();
    expect(readFileSync(boardFile(t, b.id), 'utf8')).toBe(bBefore);
    expect((await t.service.get(b.id))!.rev).toBe(1);
    expect(await t.flow.listJobs()).toHaveLength(0);
  });

  it('an unknown story is a plain error', async () => {
    const t = serviceSetup();
    expect(errOf(await run(ctxFor(t), 'story_0000000000000000', 'get_project'))).toMatch(/tidak ditemukan/);
  });
});

describe('structure actions', () => {
  it('add_shot on a bible board adds a compiled intent shot after the given shot; remove_shot and move_shot work by number', async () => {
    const t = serviceSetup();
    const story = await t.service.create(twoScenes());
    const ctx = ctxFor(t);
    const added = okOf(await run(ctx, story.id, 'add_shot', {
      scene: 1, after: 1, subject: 'KAPAS', action: 'peeks out of the woven basket', startState: 'the basket lid is closed', endState: 'one floppy ear shows above the rim',
      emotion: 'penasaran', framing: 'close-up', move: 'static', narration: 'Kapas mengintip dari keranjang.'
    }));
    expect(added.label).toMatch(/Shot 2/);
    let board = await t.service.readStoryboard(story.id);
    expect(board.scenes![0]!.shots).toHaveLength(3);
    const id = board.scenes![0]!.shots[1]!;
    const shot = board.shots.find(s => s.id === id)!;
    expect(shot.intent!.subject).toBe('KAPAS');
    expect(() => compileBoardShot(board, shot)).not.toThrow();

    okOf(await run(ctx, story.id, 'move_shot', { shot: 2, scene: 2 }));
    board = await t.service.readStoryboard(story.id);
    expect(board.scenes![1]!.shots).toEqual(['03-gang', id]);
    okOf(await run(ctx, story.id, 'remove_shot', { shot: 4 }));
    board = await t.service.readStoryboard(story.id);
    expect(board.shots.map(s => s.id)).toEqual(['01-laras', '02-kapas', '03-gang']);
    expect(await t.service.snapshots.list(story.id)).toHaveLength(1);
  });

  it('add_scene on a bible board needs a goal and writes the bible card; edit_scene sets title and goal', async () => {
    const t = serviceSetup();
    const story = await t.service.create(twoScenes());
    expect(errOf(await run(ctxFor(t), story.id, 'add_scene', { title: 'Di Rumah' }))).toMatch(/goal|tujuan/);
    okOf(await run(ctxFor(t), story.id, 'add_scene', { title: 'Di Rumah', goal: 'Laras melepaskan Kapas di kebun', location: 'PASAR_IKAN' }));
    let board = await t.service.readStoryboard(story.id);
    expect(board.scenes).toHaveLength(3);
    const scene = board.scenes![2]!;
    expect(board.bible!.scenes.find(c => c.id === scene.id)).toMatchObject({ title: 'Di Rumah', goal: 'Laras melepaskan Kapas di kebun' });
    okOf(await run(ctxFor(t), story.id, 'edit_scene', { scene: 3, title: 'Di Kebun', goal: 'Kapas kembali ke hutan' }));
    board = await t.service.readStoryboard(story.id);
    expect(board.scenes![2]!.title).toBe('Di Kebun');
    expect(board.bible!.scenes.find(c => c.id === scene.id)).toMatchObject({ title: 'Di Kebun', goal: 'Kapas kembali ke hutan' });
    okOf(await run(ctxFor(t), story.id, 'remove_scene', { scene: 3 }));
    expect((await t.service.readStoryboard(story.id)).scenes).toHaveLength(2);
  });

  it('edit_character changes the bible card; anchors rebuild the cast look; add_location writes both sides', async () => {
    const t = serviceSetup();
    const story = await t.service.create(twoScenes());
    okOf(await run(ctxFor(t), story.id, 'edit_character', { token: 'Laras', anchors: ['two black braids', 'a red scarf'] }));
    let board = await t.service.readStoryboard(story.id);
    expect(board.bible!.characters[0]!.anchors).toEqual(['two black braids', 'a red scarf']);
    expect(board.characters!.LARAS).toBe('Laras, two black braids, a red scarf');
    okOf(await run(ctxFor(t), story.id, 'add_location', { key: 'GANG_SEMPIT', name: 'Gang Sempit', lookdev: 'a narrow alley with mossy brick walls' }));
    board = await t.service.readStoryboard(story.id);
    expect(board.locations!.GANG_SEMPIT).toEqual({ name: 'Gang Sempit', look: 'a narrow alley with mossy brick walls' });
    expect(board.bible!.locations.find(l => l.key === 'GANG_SEMPIT')).toMatchObject({ lookdev: 'a narrow alley with mossy brick walls' });
    okOf(await run(ctxFor(t), story.id, 'add_character', { token: 'IBU', name: 'Ibu Sari', anchors: ['a green batik headscarf'], want: 'menjual ikan', need: 'percaya pada Laras' }));
    board = await t.service.readStoryboard(story.id);
    expect(board.bible!.characters.map(c => c.token)).toEqual(['LARAS', 'KAPAS', 'IBU']);
  });

  it('edit_character says what must be made again when a rename or new anchors invalidate paid clips', async () => {
    const t = serviceSetup();
    const story = await renderedStory(t, bibleBoard());
    expect(story.shots.filter(s => s.status === 'done')).toHaveLength(2);
    const r = okOf(await run(ctxFor(t), story.id, 'edit_character', { token: 'LARAS', name: 'Larasati' }));
    const after = (await t.service.get(story.id))!;
    const redone = after.shots.filter(s => s.status !== 'done').length;
    expect(redone).toBeGreaterThan(0);
    expect(r.label).toContain(`${redone} klip`);
    expect(r.label).toContain(`±${redone * 10} kredit Flow`);
    // A change that keeps every take says nothing about re-rendering.
    const r2 = okOf(await run(ctxFor(t), story.id, 'edit_character', { token: 'LARAS', want: 'menjual semua ikan sebelum siang' }));
    expect(r2.label).not.toMatch(/dibuat ulang/);
  });

  it('set_look changes the look family and bumps rev', async () => {
    const t = serviceSetup();
    const story = await t.service.create(twoScenes());
    const r = okOf(await run(ctxFor(t), story.id, 'set_look', { family: 'noir' }));
    expect(r.changed).toBe(true);
    expect((await t.service.readStoryboard(story.id)).look!.family).toBe('noir');
    expect((await t.service.get(story.id))!.rev).toBe(2);
    expect(errOf(await run(ctxFor(t), story.id, 'set_look', { family: 'tidak-ada' }))).toMatch(/look/i);
  });

  it('set_look refuses a pick that is not a catalog id (no silent fallback), and the schema lists the ids', async () => {
    const t = serviceSetup();
    const story = await t.service.create(twoScenes());
    const before = readFileSync(boardFile(t, story.id), 'utf8');
    const err = errOf(await run(ctxFor(t), story.id, 'set_look', { palette: 'warm golden tones' }));
    expect(err).toContain('palette');
    expect(err).toContain(CATALOG.palettes[1]!.id);
    expect(readFileSync(boardFile(t, story.id), 'utf8')).toBe(before);
    const schema = ACTIONS.set_look.schema as { properties: Record<string, { enum?: string[] }> };
    expect(schema.properties.palette!.enum).toEqual(CATALOG.palettes.map(o => o.id));
    expect(okOf(await run(ctxFor(t), story.id, 'set_look', { palette: CATALOG.palettes[1]!.id })).changed).toBe(true);
  });
});

describe('spending actions need confirm', () => {
  it('render without confirm → needsConfirm with the credits estimate and no job; with confirm → jobs queued', async () => {
    const t = serviceSetup();
    const story = await t.service.create(twoScenes());
    const r = await run(ctxFor(t), story.id, 'render', { scene: 1 });
    expect(r).toMatchObject({ ok: false, needsConfirm: true, estimate: { credits: 20 } });
    expect((r as { label: string }).label).toMatch(/20/);
    expect(await t.flow.listJobs()).toHaveLength(0);
    expect((await t.service.get(story.id))!.status).toBe('draft');
    okOf(await run(ctxFor(t, { confirmed: true }), story.id, 'render', { scene: 1 }));
    const jobs = await t.flow.listJobs();
    expect(jobs.map(j => j.technique).sort()).toEqual([`story:${story.id}/01-laras`, `story:${story.id}/02-kapas`]);
  });

  it('confirmation comes from the caller (ctx.confirmed === true), never from model input', async () => {
    const t = serviceSetup();
    const story = await t.service.create(twoScenes());
    // A model that writes confirm:true itself gets the question back, and nothing is queued.
    expect(await run(ctxFor(t), story.id, 'render', { shot: 1, confirm: true })).toMatchObject({ needsConfirm: true });
    expect(await runAction(ctxFor(t), story.id, 'render', { shot: 1, confirm: true })).toMatchObject({ needsConfirm: true });
    for (const confirmed of ['true', 1, 'ya']) {
      expect(await run(ctxFor(t, { confirmed } as unknown as Partial<ActionContext>), story.id, 'render', { shot: 1 })).toMatchObject({ needsConfirm: true });
    }
    expect(await t.flow.listJobs()).toHaveLength(0);
    // The caller confirmed: a confirm:false the model added is ignored too.
    okOf(await runAction(ctxFor(t, { confirmed: true }), story.id, 'render', { shot: 1, confirm: false }));
    expect(await t.flow.listJobs()).toHaveLength(1);
  });

  it('render on an OpenRouter video engine estimates USD from usdPerClip', async () => {
    const t = serviceSetup();
    const story = await t.service.create({ ...twoScenes(), engine: { video: { provider: 'openrouter', model: 'google/veo-3.1-fast' } } });
    const price = { usdPerClip: async (model: string) => (model === 'google/veo-3.1-fast' ? 0.4 : null) };
    const r = await run(ctxFor(t, { price }), story.id, 'render', {});
    expect(r).toMatchObject({ needsConfirm: true });
    expect((r as { estimate: { usd?: number } }).estimate.usd).toBeCloseTo(1.2);
    expect(await t.flow.listJobs()).toHaveLength(0);
  });

  it('assemble and prepare also ask first', async () => {
    const t = serviceSetup();
    const story = await t.service.create(konsistenBoard());
    expect(await run(ctxFor(t), story.id, 'prepare', {})).toMatchObject({ needsConfirm: true, estimate: { credits: 0 } });
    expect(await run(ctxFor(t), story.id, 'assemble', {})).toMatchObject({ needsConfirm: true, estimate: { credits: 0 } });
    expect(await t.flow.listJobs()).toHaveLength(0);
    okOf(await run(ctxFor(t, { confirmed: true }), story.id, 'prepare', {}));
    expect((await t.flow.listJobs()).every(j => j.kind === 'character')).toBe(true);
  });

  it('every spending action is marked spends:true and the rest are not', () => {
    const spending = Object.entries(ACTIONS).filter(([, a]) => a.spends).map(([n]) => n).sort();
    expect(spending).toEqual(['assemble', 'make_sheet', 'prepare', 'redraw_frame', 'render']);
  });
});

describe('make_sheet', () => {
  it('queues exactly one sheet job for that token only (0 credits on Flow)', async () => {
    const t = serviceSetup();
    const story = await t.service.create(konsistenBoard());
    expect(await run(ctxFor(t), story.id, 'make_sheet', { token: 'KAPAS' })).toMatchObject({ needsConfirm: true, estimate: { credits: 0 } });
    expect(await t.flow.listJobs()).toHaveLength(0);
    okOf(await run(ctxFor(t, { confirmed: true }), story.id, 'make_sheet', { token: 'KAPAS' }));
    const jobs = await t.flow.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: 'character', technique: `story:${story.id}/cast:KAPAS` });
    const record = (await t.service.get(story.id))!;
    expect(record.cast!.find(c => c.token === 'LARAS')!.status).toBe('pending');
    expect(record.status).toBe('casting');
    // The sheet finishes: no keyframe is queued, the story rests again.
    await finishQueued(t, 'character');
    const after = (await t.service.reconcile(story.id))!;
    expect(after.cast!.find(c => c.token === 'KAPAS')!.status).toBe('done');
    expect(['draft', 'review']).toContain(after.status);
    expect(await t.flow.listJobs()).toHaveLength(1);
  });

  it('a cepat board has no sheets', async () => {
    const t = serviceSetup();
    const story = await t.service.create(twoScenes());
    expect(errOf(await run(ctxFor(t, { confirmed: true }), story.id, 'make_sheet', { token: 'LARAS' }))).toMatch(/konsisten/);
  });
});

describe('references', () => {
  async function upload(t: T, storyId: string, bytes = png(768, 1024)) {
    const { saveUpload } = await import('../src/assistant/uploads.js');
    return saveUpload(t.service.storyDir(storyId), bytes);
  }

  it('edit_character {reference} stores the upload on the card; make_sheet sends it to OpenRouter as a reference', async () => {
    const t = serviceSetup();
    const story = await t.service.create(konsistenBoard({ image: { provider: 'openrouter', model: 'google/gemini-2.5-flash-image' } }));
    const up = await upload(t, story.id);
    okOf(await run(ctxFor(t), story.id, 'edit_character', { token: 'KAPAS', reference: up.id }));
    const card = (await t.service.readStoryboard(story.id)).bible!.characters.find(c => c.token === 'KAPAS')!;
    expect(card.reference).toBe(`uploads/${up.file}`);
    // A reference adds, it never re-draws: the sheet hash (and so the cast take) is untouched.
    expect((await t.service.get(story.id))!.cast!.find(c => c.token === 'KAPAS')!.status).toBe('pending');
    okOf(await run(ctxFor(t, { confirmed: true }), story.id, 'make_sheet', { token: 'KAPAS' }));
    const [job] = await t.flow.listJobs();
    expect(job!.provider).toBe('openrouter');
    expect(job!.references).toEqual([join(t.service.storyDir(story.id), 'uploads', up.file)]);
  });

  it('on Flow the reference is stored and the label says Flow uses the generated sheet', async () => {
    const t = serviceSetup();
    const story = await t.service.create(konsistenBoard());
    const up = await upload(t, story.id);
    const r = okOf(await run(ctxFor(t), story.id, 'edit_character', { token: 'LARAS', reference: up.id }));
    expect(r.label).toContain('Referensi disimpan; Flow memakai sheet yang dibuat');
    expect((await t.service.readStoryboard(story.id)).bible!.characters.find(c => c.token === 'LARAS')!.reference).toBe(`uploads/${up.file}`);
  });

  it('an unknown or traversal reference is refused', async () => {
    const t = serviceSetup();
    const story = await t.service.create(konsistenBoard());
    expect(errOf(await run(ctxFor(t), story.id, 'edit_character', { token: 'LARAS', reference: '../../etc/passwd' }))).toMatch(/[Rr]eferensi/);
    expect(errOf(await run(ctxFor(t), story.id, 'edit_character', { token: 'LARAS', reference: 'up_0123456789abcdef' }))).toMatch(/[Rr]eferensi/);
  });

  it('media pointers resolve to story media: "sheet LARAS" is copied into uploads', async () => {
    const t = serviceSetup();
    const story = await t.service.create(konsistenBoard());
    writeFileSync(t.service.castPath(story.id, 'LARAS'), png(1024, 576, 20_000));
    okOf(await run(ctxFor(t), story.id, 'edit_character', { token: 'KAPAS', reference: 'sheet LARAS' }));
    const card = (await t.service.readStoryboard(story.id)).bible!.characters.find(c => c.token === 'KAPAS')!;
    expect(card.reference).toMatch(/^uploads\/up_[a-f0-9]{16}\.png$/);
    expect(existsSync(join(t.service.storyDir(story.id), card.reference!))).toBe(true);
    expect(errOf(await run(ctxFor(t), story.id, 'edit_character', { token: 'KAPAS', reference: 'keyframe shot 2' }))).toMatch(/[Rr]eferensi/);
  });

  it('add_shot {startFrame} is stored for OpenRouter video and used as the first frame; Flow does not store it', async () => {
    const t = serviceSetup();
    const story = await t.service.create({ ...twoScenes(), engine: { video: { provider: 'openrouter', model: 'google/veo-3.1-fast' } } });
    const up = await upload(t, story.id);
    const shotInput = {
      scene: 2, subject: 'KAPAS', action: 'peeks out of the woven basket', startState: 'the basket lid is closed', endState: 'one floppy ear shows above the rim',
      framing: 'close-up', move: 'static', narration: 'Kapas mengintip dari keranjang.', startFrame: up.id
    };
    okOf(await run(ctxFor(t), story.id, 'add_shot', shotInput));
    const board = await t.service.readStoryboard(story.id);
    const added = board.shots.at(-1)!;
    expect(added.startFrame).toBe(`uploads/${up.file}`);
    okOf(await run(ctxFor(t, { confirmed: true }), story.id, 'render', { shot: 4 }));
    const [job] = await t.flow.listJobs();
    expect(job!.startImage).toBe(join(t.service.storyDir(story.id), 'uploads', up.file));

    const flowStory = await t.service.create(twoScenes());
    const flowUp = await upload(t, flowStory.id);
    const r = okOf(await run(ctxFor(t), flowStory.id, 'add_shot', { ...shotInput, startFrame: flowUp.id }));
    expect(r.label).toMatch(/OpenRouter/);
    expect((await t.service.readStoryboard(flowStory.id)).shots.at(-1)!.startFrame).toBeUndefined();
  });

  it('redraw_frame {reference} sends it with the keyframe job on OpenRouter, after confirm', async () => {
    const t = serviceSetup();
    const story = await t.service.create(konsistenBoard({ image: { provider: 'openrouter', model: 'google/gemini-2.5-flash-image' } }));
    await t.service.prepare(story.id);
    await finishQueued(t, 'character');
    await t.service.reconcile(story.id);
    await finishQueued(t, 'image');
    await t.service.reconcile(story.id);
    const up = await upload(t, story.id);
    const before = (await t.flow.listJobs()).length;
    expect(await run(ctxFor(t), story.id, 'redraw_frame', { shot: 1, reference: up.id })).toMatchObject({ needsConfirm: true });
    expect((await t.flow.listJobs()).length).toBe(before);
    okOf(await run(ctxFor(t, { confirmed: true }), story.id, 'redraw_frame', { shot: 1, reference: up.id, note: 'Keep the basket in her left hand.' }));
    const jobs = await t.flow.listJobs();
    const frame = jobs.find(j => j.technique === `story:${story.id}/frame:01-laras` && j.status === 'queued')!;
    expect(frame.references![0]).toBe(join(t.service.storyDir(story.id), 'uploads', up.file));
    expect(frame.prompt).toContain('Keep the basket in her left hand.');
  });
});

describe('undo_last', () => {
  it('restores the latest committed snapshot byte for byte', async () => {
    const t = serviceSetup();
    const story = await t.service.create(twoScenes());
    const before = readFileSync(boardFile(t, story.id), 'utf8');
    okOf(await run(ctxFor(t), story.id, 'edit_shot', { shot: 2, emotion: 'lega' }));
    const r = okOf(await run(ctxFor(t), story.id, 'undo_last', {}));
    expect(r.label).toMatch(/Dibatalkan/);
    expect(readFileSync(boardFile(t, story.id), 'utf8')).toBe(before);
  });

  it('refuses after a later manual edit with the spec message', async () => {
    const t = serviceSetup();
    const story = await t.service.create(twoScenes());
    okOf(await run(ctxFor(t), story.id, 'edit_shot', { shot: 2, emotion: 'lega' }));
    const board = await t.service.readStoryboard(story.id);
    await t.service.updateStoryboard(story.id, { ...board, title: 'Pasar Siang' });
    const after = readFileSync(boardFile(t, story.id), 'utf8');
    expect(errOf(await run(ctxFor(t), story.id, 'undo_last', {}))).toBe('Ada perubahan setelah ini — batalkan yang terbaru dulu');
    expect(readFileSync(boardFile(t, story.id), 'utf8')).toBe(after);
  });

  it('nothing to undo → plain error; busy story → wait message', async () => {
    const t = serviceSetup();
    const story = await t.service.create(twoScenes());
    expect(errOf(await run(ctxFor(t), story.id, 'undo_last', {}))).toMatch(/Belum ada/);
    okOf(await run(ctxFor(t), story.id, 'edit_shot', { shot: 2, emotion: 'lega' }));
    await t.service.render(story.id, { force: true });
    expect(errOf(await run(ctxFor(t), story.id, 'undo_last', {}))).toBe('Sedang dirender — tunggu selesai dulu');
    expect(errOf(await run(ctxFor(t), story.id, 'edit_shot', { shot: 2, emotion: 'takut' }))).toBe('Sedang dirender — tunggu selesai dulu');
  });
});

describe('toolSpecs', () => {
  it('one OpenAI function per action with an object schema; spending tools explain confirm', () => {
    const specs = toolSpecs();
    expect(specs.map(s => s.function.name).sort()).toEqual([
      'add_character', 'add_location', 'add_scene', 'add_shot', 'assemble', 'breakdown_scene', 'edit_character', 'edit_location', 'edit_scene', 'edit_shot',
      'get_project', 'make_sheet', 'move_shot', 'prepare', 'redraw_frame', 'remove_scene', 'remove_shot', 'render', 'set_look', 'undo_last'
    ]);
    for (const spec of specs) {
      expect(spec.type).toBe('function');
      expect((spec.function.parameters as { type: string }).type).toBe('object');
      expect(spec.function.description.length).toBeGreaterThan(20);
      if (ACTIONS[spec.function.name as ActionName].spends) expect(spec.function.description).toMatch(/confirm/);
    }
    // No tool lets the model confirm a cost itself: no `confirm` property anywhere in any schema.
    const keys = (value: unknown): string[] => (value && typeof value === 'object'
      ? Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [k, ...keys(v)]) : []);
    for (const spec of specs) expect(keys(spec.function.parameters)).not.toContain('confirm');
    expect(JSON.stringify(specs)).not.toMatch(/"confirm"/);
    expect(specs.find(s => s.function.name === 'edit_shot')!.function.description).toMatch(/number/);
  });
});

describe('story routes: uploads, sheet, scope', () => {
  async function setup() {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-aa-'));
    const server = await buildApp({
      dataDir,
      env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
      stories: { reconcileMs: 0, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined },
      providers: { workerMs: 0 },
      media: { cleanupMs: 0 }
    });
    const res = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;
    const id = (await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: konsistenBoard() } })).json().story.id as string;
    return { server, cookie, id, dataDir, flow: new FlowStore(join(dataDir, 'flow')) };
  }

  it('POST uploads stores a PNG in the story dir and GET serves it with its content type', async () => {
    const { server, cookie, id, dataDir } = await setup();
    const res = await server.inject({ method: 'POST', url: `/api/stories/${id}/uploads`, headers: { cookie, 'content-type': 'image/png' }, payload: png(768, 1376) });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ w: 768, h: 1376, bytes: 2000 });
    expect(body.id).toMatch(/^up_[a-f0-9]{16}$/);
    expect(body.url).toMatch(new RegExp(`^/api/stories/${id}/uploads/up_[a-f0-9]{16}\\.png$`));
    expect(existsSync(join(dataDir, 'stories', id, 'uploads', body.url.split('/').pop()))).toBe(true);
    const got = await server.inject({ url: body.url, headers: { cookie } });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.rawPayload.equals(png(768, 1376))).toBe(true);
    // JPEG and WebP are accepted too, by their bytes.
    expect((await server.inject({ method: 'POST', url: `/api/stories/${id}/uploads`, headers: { cookie, 'content-type': 'image/jpeg' }, payload: jpeg(640, 480) })).json()).toMatchObject({ w: 640, h: 480 });
    expect((await server.inject({ method: 'POST', url: `/api/stories/${id}/uploads`, headers: { cookie, 'content-type': 'image/webp' }, payload: webpVp8x(512, 512) })).json()).toMatchObject({ w: 512, h: 512 });
  });

  it('rejects text/plain, fake image bytes and files over 10 MB with plain messages', async () => {
    const { server, cookie, id } = await setup();
    const text = await server.inject({ method: 'POST', url: `/api/stories/${id}/uploads`, headers: { cookie, 'content-type': 'text/plain' }, payload: 'halo' });
    expect(text.statusCode).toBe(400);
    expect(text.json().error.message).toMatch(/PNG, JPEG atau WebP/);
    const fake = await server.inject({ method: 'POST', url: `/api/stories/${id}/uploads`, headers: { cookie, 'content-type': 'image/png' }, payload: Buffer.alloc(3000, 65) });
    expect(fake.statusCode).toBe(400);
    expect(fake.json().error.message).toMatch(/PNG, JPEG atau WebP/);
    const big = png(1000, 1000, 11 * 1024 * 1024);
    const large = await server.inject({ method: 'POST', url: `/api/stories/${id}/uploads`, headers: { cookie, 'content-type': 'image/png' }, payload: big });
    expect(large.statusCode).toBe(413);
    expect(large.json().error.message).toMatch(/10 MB/);
  });

  it('uploads are admin-only and the file name is validated', async () => {
    const { server, cookie, id } = await setup();
    expect((await server.inject({ method: 'POST', url: `/api/stories/${id}/uploads`, headers: { 'content-type': 'image/png' }, payload: png(10, 10) })).statusCode).toBe(401);
    expect((await server.inject({ url: `/api/stories/${id}/uploads/up_0123456789abcdef.png` })).statusCode).toBe(401);
    expect((await server.inject({ url: `/api/stories/${id}/uploads/..%2Fstory.json`, headers: { cookie } })).statusCode).toBe(404);
    expect((await server.inject({ url: `/api/stories/${id}/uploads/up_0123456789abcdef.png`, headers: { cookie } })).statusCode).toBe(404);
  });

  it('POST cast/:token/sheet asks first, then queues one sheet job', async () => {
    const { server, cookie, id, flow } = await setup();
    const ask = await server.inject({ method: 'POST', url: `/api/stories/${id}/cast/KAPAS/sheet`, headers: { cookie }, payload: {} });
    expect(ask.statusCode).toBe(200);
    expect(ask.json()).toMatchObject({ needsConfirm: true, estimate: { credits: 0 } });
    expect(await flow.listJobs()).toHaveLength(0);
    // A click made on an older view of the project (another tab, the assistant) is refused, nothing queued.
    const stale = await server.inject({ method: 'POST', url: `/api/stories/${id}/cast/KAPAS/sheet`, headers: { cookie }, payload: { confirm: true, rev: 99 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('STALE');
    expect(await flow.listJobs()).toHaveLength(0);
    const go = await server.inject({ method: 'POST', url: `/api/stories/${id}/cast/KAPAS/sheet`, headers: { cookie }, payload: { confirm: true, rev: ask.json().rev ?? 1 } });
    expect(go.statusCode).toBe(200);
    expect(go.json().story.status).toBe('casting');
    expect(await flow.listJobs()).toHaveLength(1);
    expect((await server.inject({ method: 'POST', url: `/api/stories/${id}/cast/NOPE/sheet`, headers: { cookie }, payload: { confirm: true } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: `/api/stories/${id}/cast/KAPAS/sheet`, payload: { confirm: true } })).statusCode).toBe(401);
  });
});

// ------------------------------------------------------------------ review fix round 1

const storyFile = (t: T, id: string) => join(t.dataDir, 'stories', id, 'story.json');
const uploadsOf = (t: T, id: string) => { const dir = join(t.service.storyDir(id), 'uploads'); return existsSync(dir) ? readdirSync(dir) : []; };
/** The real snapshot store with some methods replaced (same files, same `this`). */
const snapshotsWith = (t: T, over: Partial<Record<keyof SnapshotStore, unknown>>) => Object.assign(Object.create(t.service.snapshots), over) as SnapshotStore;
/** A take() that lets another writer change the board right after the snapshot (between take and write). */
const racingTake = (t: T, taken: string[]) => async (storyId: string, label: string) => {
  const out = await t.service.snapshots.take(storyId, label);
  taken.push(out.undoId);
  const board = await t.service.readStoryboard(storyId);
  await t.service.updateStoryboard(storyId, { ...board, title: 'Pasar Siang' });
  return out;
};

/** Bible board with a third, intent-less prose shot (made before the bible existed). */
const withProseShot = (): Storyboard => {
  const b = bibleBoard();
  return {
    ...b,
    scenes: [{ ...b.scenes![0]!, shots: [...b.scenes![0]!.shots, '03-prose'] }],
    shots: [...b.shots, { id: '03-prose', prompt: 'Wide shot, the camera stays still. LARAS walks past the fish stalls at dawn.', narration: 'Laras berjalan pulang.' }]
  };
};

describe('edit_shot on an intent-less shot of a bible board', () => {
  it('a narration edit keeps the prose prompt byte-identical, attaches no intent and keeps the paid clip', async () => {
    const t = serviceSetup();
    const done = await renderedStory(t, withProseShot());
    expect(done.shots.find(s => s.id === '03-prose')!.status).toBe('done');
    const jobs = (await t.flow.listJobs()).length;
    const prompt = withProseShot().shots[2]!.prompt;
    const r = okOf(await run(ctxFor(t), done.id, 'edit_shot', { shot: 3, narration: 'Laras pulang lewat gang.' }));
    expect(r.changed).toBe(true);
    const shot = (await t.service.readStoryboard(done.id)).shots.find(s => s.id === '03-prose')!;
    expect(shot.prompt).toBe(prompt);
    expect(shot.intent).toBeUndefined();
    expect(shot.narration).toBe('Laras pulang lewat gang.');
    const record = (await t.service.get(done.id))!;
    expect(record.shots.find(s => s.id === '03-prose')!.status).toBe('done');
    expect((await t.flow.listJobs()).length).toBe(jobs);
  });

  it('intent fields on an intent-less shot need all four slots at once', async () => {
    const t = serviceSetup();
    const story = await t.service.create(withProseShot());
    const before = readFileSync(boardFile(t, story.id), 'utf8');
    expect(errOf(await run(ctxFor(t), story.id, 'edit_shot', { shot: 3, action: 'walks home' })))
      .toBe('Shot 3 belum punya niat — isi subjek, aksi, keadaan awal dan akhir sekaligus.');
    expect(readFileSync(boardFile(t, story.id), 'utf8')).toBe(before);
    okOf(await run(ctxFor(t), story.id, 'edit_shot', {
      shot: 3, subject: 'LARAS', action: 'walks past the fish stalls', startState: 'she stands at the first stall', endState: 'she reaches the market gate', framing: 'wide', move: 'static'
    }));
    const shot = (await t.service.readStoryboard(story.id)).shots.find(s => s.id === '03-prose')!;
    expect(shot.intent).toMatchObject({ subject: 'LARAS', endState: 'she reaches the market gate' });
    expect(() => compileBoardShot(withProseShot(), shot)).not.toThrow();
  });
});

describe('mutate: commit and stale edges', () => {
  it('a commit failure after the board was written still reports the change', async () => {
    const t = serviceSetup();
    const story = await t.service.create(twoScenes());
    const snapshots = snapshotsWith(t, { commit: async () => { throw new Error('disk full'); } });
    const r = okOf(await run(ctxFor(t, { snapshots }), story.id, 'edit_shot', { shot: 2, emotion: 'lega' }));
    expect(r.changed).toBe(true);
    expect((await t.service.readStoryboard(story.id)).shots[1]!.intent!.emotion).toBe('lega');
    expect((await t.service.get(story.id))!.rev).toBe(2);
  });

  it('STALE between take and write → plain error, the snapshot is discarded, no orphan upload', async () => {
    const t = serviceSetup();
    const story = await t.service.create(konsistenBoard());
    writeFileSync(t.service.castPath(story.id, 'LARAS'), png(1024, 576, 20_000));
    const taken: string[] = [];
    const snapshots = snapshotsWith(t, { take: racingTake(t, taken) });
    const error = errOf(await run(ctxFor(t, { snapshots }), story.id, 'edit_character', { token: 'KAPAS', reference: 'sheet LARAS' }));
    expect(error).toBe(STALE_MESSAGE);
    expect(taken).toHaveLength(1);
    expect(await t.service.snapshots.get(taken[0]!)).toBeUndefined();
    expect(await t.service.snapshots.list(story.id)).toHaveLength(0);
    expect(uploadsOf(t, story.id)).toEqual([]);
    expect((await t.service.readStoryboard(story.id)).title).toBe('Pasar Siang');
  });
});

describe('plans have no side effects', () => {
  it('needsConfirm with a media-pointer reference copies nothing into uploads', async () => {
    const t = serviceSetup();
    const story = await t.service.create(konsistenBoard({ image: { provider: 'openrouter', model: 'google/gemini-2.5-flash-image' } }));
    writeFileSync(t.service.castPath(story.id, 'LARAS'), png(1024, 576, 20_000));
    expect(await run(ctxFor(t), story.id, 'make_sheet', { token: 'KAPAS', reference: 'sheet LARAS' })).toMatchObject({ needsConfirm: true });
    expect(uploadsOf(t, story.id)).toEqual([]);
    // A refused edit does not copy either.
    expect(errOf(await run(ctxFor(t), story.id, 'edit_character', { token: 'NOPE', reference: 'sheet LARAS' }))).toMatch(/NOPE/);
    expect(uploadsOf(t, story.id)).toEqual([]);
    // Confirmed: the copy is made and sent.
    okOf(await run(ctxFor(t, { confirmed: true }), story.id, 'make_sheet', { token: 'KAPAS', reference: 'sheet LARAS' }));
    expect(uploadsOf(t, story.id)).toHaveLength(1);
    const [job] = await t.flow.listJobs();
    expect(job!.references).toEqual([join(t.service.storyDir(story.id), 'uploads', uploadsOf(t, story.id)[0]!)]);
  });

  it('edit_character {reference: null} clears the card reference', async () => {
    const t = serviceSetup();
    const story = await t.service.create(konsistenBoard());
    writeFileSync(t.service.castPath(story.id, 'LARAS'), png(1024, 576, 20_000));
    okOf(await run(ctxFor(t), story.id, 'edit_character', { token: 'KAPAS', reference: 'sheet LARAS' }));
    expect((await t.service.readStoryboard(story.id)).bible!.characters.find(c => c.token === 'KAPAS')!.reference).toBeTruthy();
    const r = okOf(await run(ctxFor(t), story.id, 'edit_character', { token: 'KAPAS', reference: null }));
    expect(r.changed).toBe(true);
    expect((await t.service.readStoryboard(story.id)).bible!.characters.find(c => c.token === 'KAPAS')!.reference).toBeUndefined();
  });
});

describe('render and redraw edges', () => {
  it('konsisten render: a missing keyframe only blocks when its shot will actually be rendered', async () => {
    const t = serviceSetup();
    const story = await t.service.create(konsistenBoard());
    const record = JSON.parse(readFileSync(storyFile(t, story.id), 'utf8'));
    // Shot 1: clip already paid, keyframe since redrawn (not done). Shot 2: keyframe done, clip still to render.
    record.shots[0].status = 'done';
    record.shots[0].frame = { status: 'pending', attempts: 0 };
    record.shots[1].frame = { status: 'done', attempts: 1 };
    writeFileSync(storyFile(t, story.id), JSON.stringify(record));
    expect(await run(ctxFor(t), story.id, 'render', {})).toMatchObject({ needsConfirm: true, estimate: { credits: 10 } });
    // Shot 2's own keyframe missing still refuses.
    record.shots[1].frame = { status: 'pending', attempts: 0 };
    writeFileSync(storyFile(t, story.id), JSON.stringify(record));
    expect(errOf(await run(ctxFor(t), story.id, 'render', {}))).toMatch(/Keyframe shot 2 belum siap/);
  });

  it('redraw_frame {note} keeps a pending audit repair of the shot', async () => {
    const t = serviceSetup();
    const story = await t.service.create(konsistenBoard());
    await t.service.prepare(story.id);
    await finishQueued(t, 'character');
    await t.service.reconcile(story.id);
    await finishQueued(t, 'image');
    await t.service.reconcile(story.id);
    const record = JSON.parse(readFileSync(storyFile(t, story.id), 'utf8'));
    record.shots[0].auditRepair = 'Keep the scarf red.';
    writeFileSync(storyFile(t, story.id), JSON.stringify(record));
    okOf(await run(ctxFor(t, { confirmed: true }), story.id, 'redraw_frame', { shot: 1, note: 'Keep the basket in her left hand.' }));
    const frame = (await t.flow.listJobs()).find(j => j.technique === `story:${story.id}/frame:01-laras` && j.status === 'queued')!;
    expect(frame.prompt).toContain('Keep the basket in her left hand.');
    expect(JSON.parse(readFileSync(storyFile(t, story.id), 'utf8')).shots[0].auditRepair).toBe('Keep the scarf red.');
  });
});

describe('get_project worst case', () => {
  it('20 scenes, 20 locations and 30 shots stay within 6500 chars', async () => {
    const t = serviceSetup();
    const b = bibleBoard();
    const long = 'y'.repeat(300);
    const keys = Array.from({ length: 20 }, (_, i) => `LOKASI_PANJANG_${String.fromCharCode(65 + i)}`);
    const locations = Object.fromEntries(keys.map(k => [k, { name: `Lokasi ${k} ${'n'.repeat(40)}`, look: `a very long location description ${long}` }]));
    const shots = Array.from({ length: 30 }, (_, i) => ({ ...b.shots[0]!, id: `s-${i + 1}`, narration: 'Laras pergi ke pasar pagi itu bersama Kapas.', intent: { ...b.shots[0]!.intent!, action: `stands still behind the fish stall ${long}` } }));
    const scenes = Array.from({ length: 20 }, (_, i) => ({ id: `scene-${i + 1}`, title: `Scene ${i + 1} ${'t'.repeat(70)}`, location: keys[i]!, shots: shots.filter((_, j) => j % 20 === i).map(s => s.id) }));
    const bible = {
      ...b.bible!,
      locations: keys.map(k => ({ key: k, name: locations[k]!.name, lookdev: locations[k]!.look })),
      scenes: scenes.map(s => ({ id: s.id, title: s.title, goal: `Laras melakukan sesuatu yang penting ${'g'.repeat(250)}`, location: s.location }))
    };
    const board = { ...b, locations, scenes, shots, bible };
    expect(validateStoryboard(board)).toEqual([]);
    const story = await t.service.create(board);
    const r = okOf(await run(ctxFor(t), story.id, 'get_project'));
    expect(JSON.stringify(r.data).length).toBeLessThanOrEqual(6500);
  });
});

// Keep the fixture helpers honest: the konsisten board must be valid as written.
describe('fixtures', () => {
  it('boards validate', () => {
    for (const b of [twoScenes(), konsistenBoard(), legacyBoard(), withProseShot()]) expect(validateStoryboard(b)).toEqual([]);
  });
});
