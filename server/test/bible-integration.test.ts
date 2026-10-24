import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoryBible } from '../src/bible/story.js';
import { buildApp } from '../src/app.js';
import { FlowStore, type FlowJob } from '../src/flow/store.js';
import { StoryService } from '../src/stories/service.js';
import {
  PROMPT_VERSION, castOf, compileBoardShot, frameHashFor, framePromptFor, hashFor, lookFor, sheetHashFor,
  sheetPromptFor, shotPromptFor, validateStoryboard, type Storyboard
} from '../src/stories/storyboard.js';

const fixture: { prompts: Record<string, string>; hashes: Record<string, string> } =
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 'legacy-prompts.json'), 'utf8'));

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The board captured before the compiler landed (no `bible`, legacy `style` string). */
const legacy = (): Storyboard => ({
  title: 'Pasar Pagi',
  mode: 'konsisten',
  aspect: '9:16',
  template: 'drama-hewan',
  look: { style: 'storybook', genre: 'drama', era: 'auto', camera: 'auto', lens: 'halation', aperture: 'f14', palette: 'senja-dongeng', lighting: 'golden-hour', tempo: 'mengalir' },
  style: 'Style: storybook watercolor, intimate emotional drama, cinematic composition. Halation vintage lens look. Color grade: dusky violet shadows. Lighting: warm golden hour sunlight.',
  characters: { LARAS: 'a girl with two black braids', KAPAS: { name: 'Kapas', look: 'a cream rabbit with a red scarf' } },
  narrator: 'a warm Indonesian female storyteller',
  audio: 'Audio: voice-over by {narrator}, speaking Bahasa Indonesia slowly: "{line}" Quiet ambience.',
  audioSilent: 'Audio: soft wind and strings, no voice.',
  negative: 'Negative prompt: subtitles, captions, on-screen text, watermark, logos, warped hands, camera equipment, camera crane, film crew, drone in frame.',
  crossfade: 0.3,
  locations: {
    PASAR_IKAN: { name: 'Pasar Ikan', look: 'a busy fish market at dawn with wet stone floors' },
    HUTAN: { name: 'Hutan', look: 'a misty pine forest' }
  },
  scenes: [
    { id: 'pasar', title: 'Di Pasar', location: 'PASAR_IKAN', shots: ['00-intro', '01-laras'] },
    { id: 'hutan', title: 'Ke Hutan', location: 'HUTAN', shots: ['02-kapas'] }
  ],
  shots: [
    { id: '00-intro', silent: true, prompt: 'Extreme wide shot, the camera pushes in slowly. Morning light over rooftops.' },
    { id: '01-laras', prompt: 'Medium shot, the camera stays still. LARAS buys fish from a stall.', narration: 'Laras pergi ke pasar pagi itu.' },
    { id: '02-kapas', prompt: 'Wide shot, the camera tracks slowly. KAPAS hops between trees.', narration: 'Kapas menunggu di hutan.' }
  ]
});

const bible = (): StoryBible => ({
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
    { token: 'LARAS', name: 'Laras', anchors: ['two black braids', 'a faded blue school uniform'], want: 'menjual semua ikan', need: 'keberanian menolong', arc: 'ragu menjadi berani' },
    { token: 'KAPAS', name: 'Kapas', anchors: ['a cream rabbit with one floppy ear'], want: 'kembali ke hutan', need: 'percaya pada Laras', arc: 'takut menjadi percaya' }
  ],
  locations: [{ key: 'PASAR_IKAN', name: 'Pasar Ikan', lookdev: 'a busy fish market at dawn with wet stone floors' }],
  scenes: [{ id: 'pasar', title: 'Di Pasar', goal: 'Laras menyembunyikan Kapas dari pembeli', location: 'PASAR_IKAN' }],
  rules: { maxShotSec: 6, narrationMaxWords: 12 }
});

/** A bible board: same ids as the legacy one, intent instead of prose. */
const bibleBoard = (): Storyboard => ({
  title: 'Pasar Pagi',
  mode: 'cepat',
  aspect: '9:16',
  look: { family: 'film-real', variant: 'cinematic-drama' },
  characters: { LARAS: 'a girl with two black braids', KAPAS: 'a cream rabbit with a red scarf' },
  locations: { PASAR_IKAN: { name: 'Pasar Ikan', look: 'a busy fish market at dawn with wet stone floors' } },
  scenes: [{ id: 'pasar', title: 'Di Pasar', location: 'PASAR_IKAN', shots: ['01-laras', '02-kapas', '03-basket'] }],
  bible: bible(),
  shots: [
    { id: '01-laras', narration: 'Laras pergi ke pasar pagi itu.', intent: { subject: 'LARAS', action: 'stands still behind the fish stall', startState: 'her hands are empty', endState: 'her hands close around a hidden basket', framing: 'medium', move: 'static', emotion: 'waspada' } },
    { id: '02-kapas', narration: 'Kapas menunggu di hutan.', intent: { subject: 'LARAS', action: 'lifts the woven basket off the wet stones', startState: 'the basket is hidden under the table', endState: 'the basket is held against her chest', framing: 'medium-close', move: 'push-in', emotion: 'takut ketahuan' } },
    { id: '03-basket', silent: true, intent: { subject: 'LARAS', action: 'kneels beside the basket and whispers to KAPAS', startState: 'the basket lid is closed', endState: 'the lid is open and one ear pokes out', framing: 'close-up', move: 'push-in' } }
  ]
});

describe('legacy boards are byte-identical to v1', () => {
  const board = legacy();

  it('builds exactly the prompts captured before the compiler existed', () => {
    for (const shot of board.shots) {
      expect(shotPromptFor(board, shot), `clip ${shot.id}`).toBe(fixture.prompts[`clip:${shot.id}`]);
      expect(framePromptFor(board, shot), `frame ${shot.id}`).toBe(fixture.prompts[`frame:${shot.id}`]);
    }
    for (const member of castOf(board)) expect(sheetPromptFor(member, board), `sheet ${member.token}`).toBe(fixture.prompts[`sheet:${member.token}`]);
  });

  it('hashes exactly what v1 hashed (no PROMPT_VERSION prefix without a bible)', () => {
    expect(PROMPT_VERSION).toBe(2);
    for (const shot of board.shots) {
      expect(hashFor(board, shot), `clip ${shot.id}`).toBe(fixture.hashes[`clip:${shot.id}`]);
      expect(frameHashFor(board, shot), `frame ${shot.id}`).toBe(fixture.hashes[`frame:${shot.id}`]);
      expect(hashFor(board, shot)).toBe(digest(shotPromptFor(board, shot)));
    }
    for (const member of castOf(board)) expect(sheetHashFor(member, board)).toBe(fixture.hashes[`sheet:${member.token}`]);
    // A reuse clip hashes its reuse spec, as before.
    const reuse = { id: '09-reuse', prompt: '', reuse: { jobId: 'job_0123456789abcdef' } };
    expect(hashFor(board, reuse)).toBe(digest(JSON.stringify(reuse.reuse)));
  });

  it('resolves its look through the legacy style id, without touching the stored style', () => {
    expect(lookFor(board).family).toBe('painterly');
    expect(lookFor(board).variant).toBe('storybook');
    expect(lookFor({ ...board, look: undefined }).family).toBe('film-real');
    expect(lookFor({ ...board, look: { family: 'noir' } }).family).toBe('noir');
    expect(lookFor({ ...board, look: { family: 'clay', variant: 'claymation' } }).variant).toBe('clay');
  });

  it('keeps validating legacy prose exactly as before', () => {
    expect(validateStoryboard(board)).toEqual([]);
    const geared = { ...board, shots: [{ id: 'a', prompt: 'A jib arm lifts above LARAS.', narration: 'Satu dua.' }] };
    expect(validateStoryboard(geared).join()).toMatch(/camera gear/);
  });
});

// ------------------------------------------------------------------ service with a fake Flow

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-bible-'));
  const flow = new FlowStore(join(dataDir, 'flow'));
  const service = new StoryService({
    dataDir, flow,
    probe: async () => ({ durationSec: 6, hasAudio: true }),
    imageSize: async () => ({ width: 768, height: 1376 }),
    assemble: async dir => { writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(4096, 1)); }
  });
  return { dataDir, flow, service };
}
type T = ReturnType<typeof setup>;

async function finish(t: T, kind: FlowJob['kind']) {
  const dir = join(t.dataDir, 'flow', 'clips');
  mkdirSync(dir, { recursive: true });
  for (const job of (await t.flow.listJobs()).filter(j => j.kind === kind && j.status === 'queued')) {
    const file = join(dir, `${job.id}.${kind === 'video' ? 'mp4' : 'png'}`);
    writeFileSync(file, Buffer.alloc(20_000, 3));
    await t.flow.completeJob(job.id, { filePath: file, bytes: 20_000, result: { mediaId: `m-${job.id}`, caption: `cap ${job.id}` } });
  }
}

describe('legacy board in the service', () => {
  it('keeps every done take, jobId and promptHash after an edit (nothing is re-rendered)', async () => {
    const t = setup();
    const story = await t.service.create(legacy());
    await t.service.prepare(story.id);
    await finish(t, 'character'); await t.service.reconcile(story.id);
    await finish(t, 'image'); await t.service.reconcile(story.id);
    await t.service.render(story.id, { force: true });
    await finish(t, 'video'); await t.service.reconcile(story.id);
    const done = (await t.service.get(story.id))!;
    expect(done.status).toBe('done');
    for (const shot of done.shots) expect(shot.promptHash).toBe(fixture.hashes[`clip:${shot.id}`]);
    for (const member of done.cast!) expect(member.promptHash).toBe(fixture.hashes[`sheet:${member.token}`]);

    const jobs = (await t.flow.listJobs()).length;
    const board = await t.service.readStoryboard(story.id);
    const edited = await t.service.updateStoryboard(story.id, {
      ...board,
      title: 'Pasar Pagi (baru)',
      scenes: board.scenes!.map(s => ({ ...s, title: `${s.title}!` }))
    });
    expect(edited.shots.map(s => s.status)).toEqual(['done', 'done', 'done']);
    expect(edited.shots.map(s => s.jobId)).toEqual(done.shots.map(s => s.jobId));
    expect(edited.shots.map(s => s.promptHash)).toEqual(done.shots.map(s => s.promptHash));
    expect(edited.cast!.map(c => c.promptHash)).toEqual(done.cast!.map(c => c.promptHash));
    expect(edited.status).toBe('done');
    expect((await t.flow.listJobs()).length).toBe(jobs);
  });

  it('a bible board compiles its clip prompt and hashes the versioned text', async () => {
    const t = setup();
    const board = bibleBoard();
    expect(validateStoryboard(board)).toEqual([]);
    const story = await t.service.create(board);
    await t.service.render(story.id, { force: true });
    const job = (await t.flow.listJobs()).find(j => j.technique === `story:${story.id}/01-laras`)!;
    const shot = board.shots.find(s => s.id === '01-laras')!;
    const compiled = compileBoardShot(board, shot);
    expect(job.prompt).toBe(compiled.videoPrompt);
    expect(job.prompt).toBe(shotPromptFor(board, shot));
    expect(job.prompt).toContain('Style: Shot on ');
    expect(job.prompt).toContain('Negative: ');
    expect(job.prompt).toContain('Audio: Voice-over in Bahasa Indonesia: "Laras pergi ke pasar pagi itu."');
    const state = (await t.service.get(story.id))!.shots.find(s => s.id === '01-laras')!;
    expect(state.promptHash).toBe(digest(`${PROMPT_VERSION}|${compiled.videoPrompt}`));
    // Same prose would hash differently without the bible: the compiler path is really used.
    expect(state.promptHash).not.toBe(hashFor(legacy(), legacy().shots[1]!));
  });

  it('a bible board round-trips the bible through disk and keeps the shot intent', async () => {
    const t = setup();
    const story = await t.service.create(bibleBoard());
    const stored = await t.service.readStoryboard(story.id);
    expect(stored.bible).toEqual(bible());
    expect(stored.shots.find(s => s.id === '03-basket')!.intent!.endState).toMatch(/one ear/);
    expect(stored.bible!.characters[0]!.want).toMatch(/ikan/);
  });

  it('saves a draft whose intent still misses a slot, and only rejects it at render', async () => {
    const t = setup();
    const board = bibleBoard();
    board.shots[0] = { ...board.shots[0]!, intent: { ...board.shots[0]!.intent!, endState: '' } };
    const story = await t.service.create(board);
    const saved = await t.service.updateStoryboard(story.id, await t.service.readStoryboard(story.id));
    expect(saved.shots.map(s => s.status)).toEqual(['pending', 'pending', 'pending']);
    expect(saved.shots.every(s => s.promptHash === undefined)).toBe(true);
  });

  it('rejects a render whose intent misses a mandatory slot, without queueing a job', async () => {
    const t = setup();
    const board = bibleBoard();
    board.shots[0] = { ...board.shots[0]!, intent: { ...board.shots[0]!.intent!, endState: '' } };
    const story = await t.service.create(board);
    await expect(t.service.render(story.id, { force: true })).rejects.toMatchObject({ code: 'INVALID' });
    expect((await t.flow.listJobs()).filter(j => j.kind === 'video')).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ routes

async function app() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-bible-r-'));
  const server = await buildApp({
    dataDir,
    env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
    stories: {
      reconcileMs: 0,
      probe: async () => ({ durationSec: 6, hasAudio: true }),
      assemble: async dir => writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(5000, 3)),
      generateText: async () => '{}'
    }
  });
  const res = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  return { server, cookie };
}

describe('bible routes', () => {
  const invalid = () => {
    const board = bibleBoard();
    board.bible!.characters[0]!.anchors = ['beautiful'];
    return board;
  };

  it('rejects an invalid bible with 400 on create and on update, and stores a valid one', async () => {
    const { server, cookie } = await app();
    const post = (payload: unknown) => server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: payload as object });
    const bad = await post({ storyboard: invalid() });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID');
    expect(bad.json().error.message).toMatch(/terlalu umum/);

    const created = await post({ storyboard: bibleBoard() });
    expect(created.statusCode).toBe(201);
    const id = created.json().story.id;
    const got = (await server.inject({ url: `/api/stories/${id}`, headers: { cookie } })).json();
    expect(got.storyboard.bible.characters[0].anchors).toEqual(['two black braids', 'a faded blue school uniform']);

    const put = await server.inject({ method: 'PUT', url: `/api/stories/${id}`, headers: { cookie }, payload: { storyboard: invalid() } });
    expect(put.statusCode).toBe(400);
    expect(put.json().error.message).toMatch(/terlalu umum/);
    // The stored board is untouched by the rejected PUT.
    expect((await server.inject({ url: `/api/stories/${id}`, headers: { cookie } })).json().storyboard.bible.characters[0].anchors[0]).toBe('two black braids');
  });

  it('still accepts a legacy board without a bible exactly as before', async () => {
    const { server, cookie } = await app();
    const created = await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: legacy() } });
    expect(created.statusCode).toBe(201);
    const got = (await server.inject({ url: `/api/stories/${created.json().story.id}`, headers: { cookie } })).json();
    expect(got.storyboard.bible).toBeUndefined();
    expect(got.story.status).toBe('draft');
    expect(got.storyboard.style).toBe(legacy().style);
  });
});
