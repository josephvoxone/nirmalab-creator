import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { FlowStore, type FlowJob } from '../src/flow/store.js';
import { StoryService, idleStatus, type StoryRecord } from '../src/stories/service.js';
import { buildShotPrompt, framePrompt, normalizeScenes, sceneOf, validateStoryboard, type Storyboard } from '../src/stories/storyboard.js';

const shots: Storyboard['shots'] = [
  { id: '00-intro', silent: true, prompt: 'Extreme wide shot, the camera pushes in slowly. Morning light over rooftops.' },
  { id: '01-laras', prompt: 'Medium shot, the camera stays still. LARAS buys fish.', narration: 'Laras pergi ke pasar.' },
  { id: '02-kapas', prompt: 'Wide shot, the camera tracks slowly. KAPAS hops between trees.', narration: 'Kapas menunggu di hutan.' }
];

const board: Storyboard = {
  title: 'Pasar Pagi',
  mode: 'konsisten',
  style: 'Style: storybook watercolor.',
  characters: { LARAS: 'a girl with two black braids', KAPAS: { name: 'Kapas', look: 'a cream rabbit with a red scarf' } },
  audio: 'Audio: voice-over: "{line}"',
  audioSilent: 'Audio: wind.',
  locations: {
    PASAR_IKAN: { name: 'Pasar Ikan', look: 'a busy fish market at dawn with wet stone floors' },
    HUTAN: { name: 'Hutan', look: 'a misty pine forest' }
  },
  scenes: [
    { id: 'pasar', title: 'Di Pasar', location: 'PASAR_IKAN', shots: ['00-intro', '01-laras'] },
    { id: 'hutan', title: 'Ke Hutan', location: 'HUTAN', shots: ['02-kapas'] }
  ],
  shots
};

const cepat: Storyboard = { ...board, mode: 'cepat' };

/** A GET reconciles and starts the assembly in the background (the page polls): wait until it is no longer "assembling". */
async function settled(server: { inject: (o: any) => Promise<any> }, cookie: string, id: string) {
  for (let i = 0; i < 150; i++) {
    const r = (await server.inject({ url: `/api/stories/${id}`, headers: { cookie } })).json();
    if (r.story.status !== 'assembling') return r;
    await new Promise(res => setTimeout(res, 20));
  }
  throw new Error('assembly did not finish');
}

describe('normalizeScenes', () => {
  it('no or empty scenes → one scene with every shot', () => {
    const plain = { ...board, scenes: undefined };
    expect(normalizeScenes(plain).scenes).toEqual([{ id: 'scene-1', title: 'Scene 1', shots: ['00-intro', '01-laras', '02-kapas'] }]);
    expect(normalizeScenes({ ...board, scenes: [] }).scenes).toEqual([{ id: 'scene-1', title: 'Scene 1', shots: ['00-intro', '01-laras', '02-kapas'] }]);
  });

  it('drops unknown ids, keeps the first place of a duplicate, appends unlisted shots to the last scene, allows empty scenes', () => {
    const out = normalizeScenes({
      ...board,
      scenes: [
        { id: 'a', title: 'A', shots: ['02-kapas', 'ghost', '00-intro'] },
        { id: 'b', title: 'B', shots: ['00-intro'] },
        { id: 'c', title: 'C', shots: [] }
      ]
    });
    expect(out.scenes!.map(s => s.shots)).toEqual([['02-kapas', '00-intro'], [], ['01-laras']]);
    const empty = normalizeScenes({ ...board, scenes: [{ id: 'a', title: 'A', shots: ['00-intro', '01-laras', '02-kapas'] }, { id: 'b', title: 'B', shots: [] }] });
    expect(empty.scenes!.map(s => s.shots)).toEqual([['00-intro', '01-laras', '02-kapas'], []]);
  });

  it('reorders board.shots to the scene order', () => {
    const out = normalizeScenes({ ...board, scenes: [{ id: 'a', title: 'A', shots: ['02-kapas'] }, { id: 'b', title: 'B', shots: ['01-laras', '00-intro'] }] });
    expect(out.shots.map(s => s.id)).toEqual(['02-kapas', '01-laras', '00-intro']);
    expect(out.shots[0]).toBe(board.shots[2]);
  });

  it('drops a scene location that is not a key of locations', () => {
    const out = normalizeScenes({ ...board, scenes: [{ id: 'a', title: 'A', location: 'LAUT', shots: [] }, { id: 'b', title: 'B', location: 'HUTAN', shots: [] }] });
    expect(out.scenes![0]).not.toHaveProperty('location');
    expect(out.scenes![1]!.location).toBe('HUTAN');
    expect(normalizeScenes({ ...board, locations: undefined }).scenes!.every(s => !('location' in s))).toBe(true);
  });

  it('does not mutate its input', () => {
    const input = JSON.parse(JSON.stringify({ ...board, scenes: [{ id: 'a', title: 'A', shots: ['02-kapas'] }] }));
    const copy = JSON.stringify(input);
    normalizeScenes(input);
    expect(JSON.stringify(input)).toBe(copy);
  });

  it('sceneOf finds the scene that holds a shot', () => {
    expect(sceneOf(board, '02-kapas')!.id).toBe('hutan');
    expect(sceneOf({ ...board, scenes: undefined }, '01-laras')!.id).toBe('scene-1');
    expect(sceneOf(board, 'nope')).toBeUndefined();
  });
});

describe('scene/location validation', () => {
  const errs = (b: Partial<Storyboard>) => validateStoryboard({ ...board, ...b });
  it('a valid board with scenes and locations passes; an unknown scene location is not an error (it is dropped)', () => {
    expect(errs({})).toEqual([]);
    expect(errs({ scenes: [{ id: 'a', title: 'A', location: 'LAUT', shots: [] }] })).toEqual([]);
  });

  it('scene rules', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `s-${i}`, title: `S${i}`, shots: [] }));
    expect(errs({ scenes: many }).join()).toMatch(/too many scenes/);
    expect(errs({ scenes: [{ id: 'Bad Id', title: 'A', shots: [] }] }).join()).toMatch(/invalid scene id/);
    expect(errs({ scenes: [{ id: 'a', title: 'A', shots: [] }, { id: 'a', title: 'B', shots: [] }] }).join()).toMatch(/duplicate scene id/);
    expect(errs({ scenes: [{ id: 'a', title: '  ', shots: [] }] }).join()).toMatch(/title is empty/);
    expect(errs({ scenes: [{ id: 'a', title: 'x'.repeat(81), shots: [] }] }).join()).toMatch(/title too long/);
    expect(errs({ scenes: [{ id: 'a', title: 'A', summary: 'x'.repeat(301), shots: [] }] }).join()).toMatch(/summary too long/);
    expect(errs({ scenes: [{ id: 'a', title: 'A', shots: 'nope' as unknown as string[] }] }).join()).toMatch(/shots must be a list/);
  });

  it('location rules', () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`LOC_${i}`, { name: 'x', look: 'y' }]));
    expect(errs({ locations: many }).join()).toMatch(/too many locations/);
    expect(errs({ locations: { pasar: { name: 'a', look: 'b' } } }).join()).toMatch(/invalid location key/);
    expect(errs({ locations: { PASAR: { name: '', look: 'b' } } }).join()).toMatch(/PASAR: name is empty/);
    expect(errs({ locations: { PASAR: { name: 'a', look: ' ' } } }).join()).toMatch(/PASAR: look is empty/);
  });
});

describe('Setting line', () => {
  it('frame and video prompts add the scene location right after the shot body, before Style', () => {
    const shot = board.shots[1]!;
    for (const p of [framePrompt(board, shot), buildShotPrompt(board, shot)]) {
      const body = p.indexOf('Laras buys fish.');
      const setting = p.indexOf('Setting: a busy fish market at dawn with wet stone floors.');
      expect(body).toBeGreaterThanOrEqual(0);
      expect(setting).toBeGreaterThan(body);
      expect(p.indexOf('Style:')).toBeGreaterThan(setting);
    }
    expect(buildShotPrompt(board, board.shots[2]!)).toContain('Setting: a misty pine forest.');
  });

  it('no Setting without a scene location', () => {
    const noLoc = { ...board, scenes: [{ id: 'pasar', title: 'Di Pasar', shots: ['00-intro', '01-laras'] }, board.scenes![1]!] };
    expect(framePrompt(noLoc, board.shots[1]!)).not.toContain('Setting:');
    expect(buildShotPrompt(noLoc, board.shots[1]!)).not.toContain('Setting:');
    expect(buildShotPrompt({ ...board, scenes: undefined }, board.shots[1]!)).not.toContain('Setting:');
  });
});

describe('idleStatus', () => {
  const rec = (over: Partial<StoryRecord>): StoryRecord => ({ id: 'story_0000000000000000', title: 't', status: 'rendering', createdAtMs: 0, updatedAtMs: 0, events: [], shots: [], ...over });
  it('done only when every shot is done and a fresh video exists; review when every clip is done but the cut is missing/stale or konsisten frames are all done; else draft', () => {
    const doneShots = [{ id: 'a', status: 'done' as const, attempts: 0, frame: { status: 'done' as const, attempts: 0 } }];
    const video = { bytes: 1, finishedAtMs: 1 };
    expect(idleStatus(rec({ shots: doneShots, video }))).toBe('done');
    expect(idleStatus(rec({ shots: doneShots, video, videoStale: true }))).toBe('review');
    expect(idleStatus(rec({ shots: [{ id: 'a', status: 'done', attempts: 0 }] }))).toBe('review');
    expect(idleStatus(rec({ shots: doneShots, video, videoStale: true, mode: 'konsisten' }))).toBe('review');
    expect(idleStatus(rec({ mode: 'konsisten', shots: [{ id: 'a', status: 'pending', attempts: 0, frame: { status: 'pending', attempts: 0 } }] }))).toBe('draft');
    expect(idleStatus(rec({ shots: [{ id: 'a', status: 'pending', attempts: 0 }] }))).toBe('draft');
  });
});

// ------------------------------------------------------------------ service with a fake Flow

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-scenes-'));
  const flow = new FlowStore(join(dataDir, 'flow'));
  const assembled: string[][] = [];
  const service = new StoryService({
    dataDir, flow,
    probe: async () => ({ durationSec: 6, hasAudio: true }),
    imageSize: async () => ({ width: 768, height: 1376 }),
    assemble: async dir => {
      assembled.push(JSON.parse(readFileSync(join(dir, 'assemble.json'), 'utf8')).shots.map((s: { id: string }) => s.id));
      writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(4096, 1));
    }
  });
  return { dataDir, flow, service, assembled };
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

const shotIdOf = (j: FlowJob) => j.technique!.split('/').pop()!;

async function fullyRendered(t: T, b: Storyboard) {
  const story = await t.service.create(b);
  if (b.mode === 'konsisten') {
    await t.service.prepare(story.id);
    await finish(t, 'character'); await t.service.reconcile(story.id);
    await finish(t, 'image'); await t.service.reconcile(story.id);
  }
  await t.service.render(story.id, { force: true });
  await finish(t, 'video'); await t.service.reconcile(story.id);
  const rec = (await t.service.get(story.id))!;
  expect(rec.status).toBe('done');
  return rec;
}

describe('StoryService scenes', () => {
  it('create and readStoryboard normalise: scenes always present, record shots in scene order', async () => {
    const t = setup();
    const plain = await t.service.create({ ...cepat, scenes: undefined, locations: undefined });
    expect((await t.service.readStoryboard(plain.id)).scenes).toEqual([{ id: 'scene-1', title: 'Scene 1', shots: ['00-intro', '01-laras', '02-kapas'] }]);
    const reordered = await t.service.create({ ...cepat, scenes: [{ id: 'a', title: 'A', shots: ['02-kapas'] }, { id: 'b', title: 'B', shots: [] }] });
    expect(reordered.shots.map(s => s.id)).toEqual(['02-kapas', '00-intro', '01-laras']);
    const stored = await t.service.readStoryboard(reordered.id);
    expect(stored.shots.map(s => s.id)).toEqual(['02-kapas', '00-intro', '01-laras']);
    expect(stored.scenes!.map(s => s.shots)).toEqual([['02-kapas'], ['00-intro', '01-laras']]);
  });

  it('readStoryboard normalises a legacy storyboard.json without scenes', async () => {
    const t = setup();
    const story = await t.service.create(cepat);
    const file = join(t.service.storyDir(story.id), 'storyboard.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    delete raw.scenes;
    writeFileSync(file, JSON.stringify(raw));
    expect((await t.service.readStoryboard(story.id)).scenes![0]!.shots).toEqual(['00-intro', '01-laras', '02-kapas']);
  });

  it('reordering shots across scenes keeps every done take and frame; marks the video stale; assemble rebuilds in the new order', async () => {
    const t = setup();
    const rec = await fullyRendered(t, { ...board, locations: undefined, scenes: undefined });
    expect(t.assembled).toEqual([['00-intro', '01-laras', '02-kapas']]);
    const jobs = (await t.flow.listJobs()).length;
    const before = await t.service.readStoryboard(rec.id);
    const moved = { ...before, scenes: [{ id: 'a', title: 'A', shots: ['02-kapas', '00-intro'] }, { id: 'b', title: 'B', shots: ['01-laras'] }] };
    const after = await t.service.updateStoryboard(rec.id, moved);
    expect(after.shots.map(s => s.id)).toEqual(['02-kapas', '00-intro', '01-laras']);
    expect(after.shots.every(s => s.status === 'done' && s.frame?.status === 'done')).toBe(true);
    expect(after.shots.map(s => s.jobId)).toEqual(['02-kapas', '00-intro', '01-laras'].map(id => rec.shots.find(s => s.id === id)!.jobId));
    expect(after.videoStale).toBe(true);
    expect(after.status).toBe('review');
    const done = await t.service.assemble(rec.id);
    expect(done.status).toBe('done');
    expect(done.videoStale).toBeUndefined();
    expect(t.assembled.at(-1)).toEqual(['02-kapas', '00-intro', '01-laras']);
    expect((await t.flow.listJobs()).length).toBe(jobs);
  });

  it('an unchanged storyboard PUT keeps a done story done and the video fresh', async () => {
    const t = setup();
    const rec = await fullyRendered(t, cepat);
    const same = await t.service.updateStoryboard(rec.id, await t.service.readStoryboard(rec.id));
    expect(same.status).toBe('done');
    expect(same.videoStale).toBeFalsy();
  });

  it('a failed re-assembly keeps the previous final video playable', async () => {
    const t = setup();
    const rec = await fullyRendered(t, cepat);
    const final = join(t.service.storyDir(rec.id), 'final.mp4');
    const before = readFileSync(final);
    const broken = new StoryService({
      dataDir: t.dataDir, flow: t.flow,
      probe: async () => ({ durationSec: 6, hasAudio: true }),
      imageSize: async () => ({ width: 768, height: 1376 }),
      assemble: async dir => { writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(10, 9)); throw new Error('ffmpeg exited 1'); }
    });
    const failed = await broken.assemble(rec.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/ffmpeg exited 1/);
    expect(failed.video).toEqual(rec.video);
    expect(readFileSync(final).equals(before)).toBe(true);
  });

  it('splitting into scenes or renaming them (same play order, same clips) keeps the video fresh and the story done', async () => {
    const t = setup();
    const rec = await fullyRendered(t, cepat);
    const b = await t.service.readStoryboard(rec.id);
    const split = await t.service.updateStoryboard(rec.id, { ...b, title: 'Judul baru', scenes: [{ id: 'buka', title: 'Pembuka', summary: 'Awal', location: 'PASAR_IKAN', shots: ['00-intro'] }, { id: 'inti', title: 'Inti', location: 'PASAR_IKAN', shots: ['01-laras'] }, { id: 'akhir', title: 'Akhir', location: 'HUTAN', shots: ['02-kapas'] }] });
    expect(split.status).toBe('done');
    expect(split.videoStale).toBeFalsy();
    expect((await t.service.readStoryboard(rec.id)).scenes!.map(s => s.title)).toEqual(['Pembuka', 'Inti', 'Akhir']);
  });

  it('a legacy imported story (done shots without promptHash/jobId) keeps every clip when split into scenes', async () => {
    const t = setup();
    const rec = await fullyRendered(t, { ...cepat, locations: undefined, scenes: undefined });
    const file = join(t.service.storyDir(rec.id), 'story.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.shots = raw.shots.map((s: Record<string, unknown>) => ({ id: s.id, status: 'done', attempts: 0, durationSec: 6.016 }));
    delete raw.mode;
    writeFileSync(file, JSON.stringify(raw));
    const b = await t.service.readStoryboard(rec.id);
    const split = await t.service.updateStoryboard(rec.id, { ...b, scenes: [{ id: 'a', title: 'A', shots: ['00-intro'] }, { id: 'b', title: 'B', shots: ['01-laras', '02-kapas'] }] });
    expect(split.shots.map(s => s.status)).toEqual(['done', 'done', 'done']);
    expect(split.status).toBe('done');
    expect(split.videoStale).toBeFalsy();
    const reordered = await t.service.updateStoryboard(rec.id, { ...b, scenes: [{ id: 'a', title: 'A', shots: ['01-laras', '00-intro'] }, { id: 'b', title: 'B', shots: ['02-kapas'] }] });
    expect(reordered.shots.map(s => s.status)).toEqual(['done', 'done', 'done']);
    expect(reordered.videoStale).toBe(true);
    expect(reordered.status).toBe('review');
    const edited = await t.service.updateStoryboard(rec.id, { ...b, shots: b.shots.map(s => (s.id === '02-kapas' ? { ...s, narration: 'Kapas sendirian.' } : s)) });
    expect(edited.shots.map(s => s.status)).toEqual(['done', 'done', 'pending']);
  });

  it('a cepat content edit on a done story goes back to draft with a stale video', async () => {
    const t = setup();
    const rec = await fullyRendered(t, cepat);
    const b = await t.service.readStoryboard(rec.id);
    const edited = await t.service.updateStoryboard(rec.id, { ...b, shots: b.shots.map(s => (s.id === '02-kapas' ? { ...s, narration: 'Kapas sendirian.' } : s)) });
    expect(edited.status).toBe('draft');
    expect(edited.videoStale).toBe(true);
    expect(edited.shots.find(s => s.id === '02-kapas')!.status).toBe('pending');
  });

  it('changing a location invalidates only the keyframes of the scenes that use it', async () => {
    const t = setup();
    const rec = await fullyRendered(t, board);
    const b = await t.service.readStoryboard(rec.id);
    const after = await t.service.updateStoryboard(rec.id, { ...b, locations: { ...b.locations, HUTAN: { name: 'Hutan', look: 'a burning pine forest' } } });
    expect(after.shots.filter(s => s.frame?.status === 'done').map(s => s.id)).toEqual(['00-intro', '01-laras']);
    expect(after.shots.find(s => s.id === '02-kapas')).toMatchObject({ status: 'pending', frame: { status: 'pending' } });
    expect(after.status).toBe('draft');
  });

  it('assemble refuses unless every shot is done', async () => {
    const t = setup();
    const story = await t.service.create(cepat);
    await expect(t.service.assemble(story.id)).rejects.toMatchObject({ code: 'INVALID' });
    expect(t.assembled).toHaveLength(0);
  });

  it('prepare one scene: only its cast and frames; ends idle even with other scenes pending; render that scene only', async () => {
    const t = setup();
    const story = await t.service.create(board);
    await expect(t.service.prepare(story.id, { scene: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await t.service.prepare(story.id, { scene: 'pasar' });
    let jobs = await t.flow.listJobs();
    expect(jobs.map(j => j.technique)).toEqual([`story:${story.id}/cast:LARAS`]);
    expect((await t.service.get(story.id))!.status).toBe('casting');
    await finish(t, 'character'); await t.service.reconcile(story.id);
    jobs = await t.flow.listJobs();
    expect(jobs.filter(j => j.kind === 'image').map(shotIdOf).sort()).toEqual(['frame:00-intro', 'frame:01-laras']);
    expect((await t.service.get(story.id))!.status).toBe('framing');
    await finish(t, 'image'); await t.service.reconcile(story.id);
    let rec = (await t.service.get(story.id))!;
    expect(rec.status).toBe('draft');
    expect(rec.shots.find(s => s.id === '02-kapas')!.frame!.status).toBe('pending');
    expect(rec.cast!.find(c => c.token === 'KAPAS')!.status).toBe('pending');
    await t.service.redrawFrame(story.id, '01-laras');
    expect((await t.service.get(story.id))!.status).toBe('framing');
    await finish(t, 'image'); await t.service.reconcile(story.id);
    expect((await t.service.get(story.id))!.status).toBe('draft');

    await expect(t.service.render(story.id)).rejects.toThrow(/keyframe/i);
    await t.service.render(story.id, { scene: 'pasar' });
    const videos = (await t.flow.listJobs()).filter(j => j.kind === 'video');
    expect(videos.map(shotIdOf).sort()).toEqual(['00-intro', '01-laras']);
    await finish(t, 'video'); await t.service.reconcile(story.id);
    rec = (await t.service.get(story.id))!;
    expect(rec.status).toBe('draft');
    expect(t.assembled).toHaveLength(0);

    await t.service.prepare(story.id, { scene: 'hutan' });
    expect((await t.flow.listJobs()).filter(j => j.kind === 'character').map(shotIdOf).sort()).toEqual(['cast:KAPAS', 'cast:LARAS']);
    await finish(t, 'character'); await t.service.reconcile(story.id);
    await finish(t, 'image'); await t.service.reconcile(story.id);
    expect((await t.service.get(story.id))!.status).toBe('review');
    await t.service.render(story.id, { scene: 'hutan' });
    expect((await t.flow.listJobs()).filter(j => j.kind === 'video')).toHaveLength(3);
    await finish(t, 'video'); await t.service.reconcile(story.id);
    expect((await t.service.get(story.id))!.status).toBe('done');
    expect(t.assembled).toEqual([['00-intro', '01-laras', '02-kapas']]);
  });

  it('render one shot queues only that shot; the budget counts only the run', async () => {
    const t = setup();
    const acc = await t.flow.addAccount({ label: 'a', email: 'a@x.io' });
    await t.flow.heartbeat('mac', [{ id: acc.id, credits: 15 }]);
    const story = await t.service.create(cepat);
    await expect(t.service.render(story.id)).rejects.toMatchObject({ code: 'BUDGET' });
    await expect(t.service.render(story.id, { scene: 'pasar' })).rejects.toMatchObject({ code: 'BUDGET' });
    await expect(t.service.render(story.id, { shot: 'ghost' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await t.service.render(story.id, { shot: '01-laras' });
    expect((await t.flow.listJobs()).map(shotIdOf)).toEqual(['01-laras']);
    await finish(t, 'video'); await t.service.reconcile(story.id);
    const rec = (await t.service.get(story.id))!;
    expect(rec.status).toBe('draft');
    expect(rec.shots.map(s => s.status)).toEqual(['pending', 'done', 'pending']);
  });

  it('a take of the run that fails after max takes fails the story; other scenes stay pending', async () => {
    const t = setup();
    await t.flow.addAccount({ label: 'A', email: 'a@x' }); // failJob only moves a running job: claimJob needs an account
    const story = await t.service.create(cepat);
    await t.service.render(story.id, { scene: 'hutan' });
    for (let i = 0; i < 3; i++) {
      const job = (await t.flow.listJobs()).find(j => j.status === 'queued')!;
      for (let k = 0; k < 3; k++) { await t.flow.claimJob('mac'); await t.flow.failJob(job.id, 'Flow: policy violation'); }
      await t.service.reconcile(story.id);
    }
    const rec = (await t.service.get(story.id))!;
    expect(rec.status).toBe('failed');
    expect(rec.error).toMatch(/02-kapas.*policy/);
    expect(rec.shots.filter(s => s.status === 'pending').map(s => s.id)).toEqual(['00-intro', '01-laras']);
    await t.service.retry(story.id);
    expect((await t.flow.listJobs()).filter(j => j.status === 'queued').map(shotIdOf)).toEqual(['02-kapas']);
  });
});

// ------------------------------------------------------------------ routes

async function app() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-scenes-r-'));
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
  return { server, cookie, dataDir, flow: new FlowStore(join(dataDir, 'flow')) };
}

describe('scene routes', () => {
  it('prepare/render accept scene/shot, validate them, and assemble rebuilds the video', async () => {
    const { server, cookie, dataDir, flow } = await app();
    const post = (url: string, payload: unknown = {}) => server.inject({ method: 'POST', url, headers: { cookie }, payload: payload as object });
    const id = (await post('/api/stories', { storyboard: cepat })).json().story.id;
    const got = (await server.inject({ url: `/api/stories/${id}`, headers: { cookie } })).json();
    expect(got.storyboard.scenes.map((s: { id: string }) => s.id)).toEqual(['pasar', 'hutan']);

    expect((await post(`/api/stories/${id}/render`, { scene: 'nope' })).statusCode).toBe(404);
    expect((await post(`/api/stories/${id}/render`, { shot: 'ghost' })).statusCode).toBe(404);
    expect((await post(`/api/stories/${id}/render`, { scene: 42 })).statusCode).toBe(400);
    expect((await post(`/api/stories/${id}/render`, { shot: '../x' })).statusCode).toBe(400);
    const konsisten = (await post('/api/stories', { storyboard: board })).json().story.id;
    expect((await post(`/api/stories/${konsisten}/prepare`, { scene: 'nope' })).statusCode).toBe(404);
    expect((await post(`/api/stories/${konsisten}/prepare`, { scene: ['x'] })).statusCode).toBe(400);
    const prep = await post(`/api/stories/${konsisten}/prepare`, { scene: 'hutan' });
    expect(prep.statusCode).toBe(200);
    expect((await flow.listJobs()).map(j => j.technique)).toEqual([`story:${konsisten}/cast:KAPAS`]);

    const early = await post(`/api/stories/${id}/assemble`);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('INVALID');

    const one = await post(`/api/stories/${id}/render`, { shot: '02-kapas' });
    expect(one.statusCode).toBe(200);
    const clips = join(dataDir, 'flow', 'clips');
    mkdirSync(clips, { recursive: true });
    const finishVideos = async () => {
      for (const job of (await flow.listJobs()).filter(j => j.kind === 'video' && j.status === 'queued')) {
        writeFileSync(join(clips, `${job.id}.mp4`), Buffer.alloc(9000, 1));
        await flow.completeJob(job.id, { filePath: join(clips, `${job.id}.mp4`), bytes: 9000 });
      }
    };
    await finishVideos();
    expect((await server.inject({ url: `/api/stories/${id}`, headers: { cookie } })).json().story.status).toBe('draft');
    await post(`/api/stories/${id}/render`, { scene: 'pasar' });
    await finishVideos();
    expect((await settled(server, cookie, id)).story.status).toBe('done');

    const b = (await server.inject({ url: `/api/stories/${id}`, headers: { cookie } })).json().storyboard;
    const put = await server.inject({ method: 'PUT', url: `/api/stories/${id}`, headers: { cookie }, payload: { storyboard: { ...b, scenes: [b.scenes[1], b.scenes[0]] } } });
    expect(put.json().story.videoStale).toBe(true);
    expect((await server.inject({ url: `/api/stories/${id}/video`, headers: { cookie } })).statusCode).toBe(200);
    // The request returns at once (a long assembly must not hold a connection open behind a proxy): 202 + "assembling".
    const assembled = await post(`/api/stories/${id}/assemble`);
    expect(assembled.statusCode).toBe(202);
    expect(assembled.json().story.status).toBe('assembling');
    let final = assembled.json().story;
    for (let i = 0; i < 100 && final.status === 'assembling'; i++) {
      await new Promise(r => setTimeout(r, 20));
      final = (await server.inject({ url: `/api/stories/${id}`, headers: { cookie } })).json().story;
    }
    expect(final.status).toBe('done');
    expect(final.videoStale).toBeUndefined();

    expect((await server.inject({ method: 'POST', url: `/api/stories/${id}/assemble` })).statusCode).toBe(401);
  });
});
