import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlowStore, type FlowJob } from '../src/flow/store.js';
import { StoryService } from '../src/stories/service.js';
import { characterSheetPrompt, framePrompt, castOf, buildShotPrompt, type Storyboard } from '../src/stories/storyboard.js';

const board: Storyboard = {
  title: 'Selendang Merah',
  mode: 'konsisten',
  style: 'Style: storybook watercolor.',
  characters: { LARAS: 'a seven-year-old girl with two black braids and a mustard dress', KAPAS: { name: 'Kapas', look: 'a cream rabbit with a red knitted scarf' } },
  audio: 'Audio: voice-over: "{line}"',
  audioSilent: 'Audio: wind.',
  shots: [
    { id: '00-intro', silent: true, prompt: 'Extreme wide shot, the camera pushes in slowly. A misty valley at sunrise.' },
    { id: '01-hadiah', prompt: 'Medium shot, the camera stays still. LARAS holds KAPAS on a porch.', narration: 'Namanya Kapas.' },
    { id: '02-hujan', prompt: 'Wide shot, the camera tracks slowly. KAPAS waits in the rain.', narration: 'Ia menunggu.' }
  ]
};

describe('consistency prompts', () => {
  it('cast = characters used by shots, with display names', () => {
    expect(castOf(board)).toEqual([
      { token: 'LARAS', name: 'Laras', look: 'a seven-year-old girl with two black braids and a mustard dress' },
      { token: 'KAPAS', name: 'Kapas', look: 'a cream rabbit with a red knitted scarf' }
    ]);
  });

  it('character sheet asks for a turnaround on a plain background in the story style', () => {
    const p = characterSheetPrompt(castOf(board)[0]!, board);
    expect(p).toMatch(/reference sheet/i);
    expect(p).toMatch(/front, side and back/i);
    expect(p).toContain('two black braids');
    expect(p).toContain('storybook watercolor');
  });

  it('frame prompt names the characters (their look comes from the attached reference) and asks to keep them identical', () => {
    const p = framePrompt(board, board.shots[1]!);
    expect(p).toContain('Laras holds Kapas on a porch');
    expect(p).not.toContain('mustard dress');
    expect(p).toMatch(/exactly as in (their|the) character reference/i);
    expect(p).not.toMatch(/voice-over|Audio:/);
  });

  it('narration speaks names, never TOKENs or descriptors', () => {
    const p = buildShotPrompt({ ...board, mode: 'cepat' }, { id: 'x', prompt: 'Medium shot, the camera stays still. LARAS waits.', narration: 'LARAS menunggu KAPAS.' });
    expect(p).toContain('"Laras menunggu Kapas."');
  });

  it('in consistent mode the video prompt also uses names, keeps narration audio', () => {
    const p = buildShotPrompt(board, board.shots[1]!);
    expect(p).toContain('Laras holds Kapas');
    expect(p).toContain('"Namanya Kapas."');
  });
});

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-consist-'));
  const flow = new FlowStore(join(dataDir, 'flow'));
  const service = new StoryService({
    dataDir, flow,
    probe: async () => ({ durationSec: 6, hasAudio: true }),
    imageSize: async () => ({ width: 768, height: 1376 }),
    assemble: async dir => writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(4096, 1))
  });
  return { dataDir, flow, service };
}

async function finish(t: ReturnType<typeof setup>, kind: FlowJob['kind'], meta: (j: FlowJob) => Record<string, string> = j => ({ mediaId: `m-${j.id}`, caption: `cap ${j.id}` })) {
  const dir = join(t.dataDir, 'flow', 'clips');
  mkdirSync(dir, { recursive: true });
  for (const job of (await t.flow.listJobs()).filter(j => j.kind === kind && j.status === 'queued')) {
    const file = join(dir, `${job.id}.${kind === 'video' ? 'mp4' : 'png'}`);
    writeFileSync(file, Buffer.alloc(20_000, 3));
    await t.flow.completeJob(job.id, { filePath: file, bytes: 20_000, result: meta(job) });
  }
}

describe('StoryService consistent pipeline', () => {
  it('prepare → character sheets → keyframes → review, all in one Flow group, no credits', async () => {
    const t = setup();
    const story = await t.service.create(board);
    await t.service.prepare(story.id);
    let jobs = await t.flow.listJobs();
    expect(jobs.map(j => j.kind)).toEqual(['character', 'character']);
    expect(jobs.every(j => j.group === story.id)).toBe(true);
    expect((await t.service.get(story.id))!.status).toBe('casting');

    await finish(t, 'character', j => ({ mediaId: `sheet-${j.id}`, flowCharacterId: `fc-${j.id}` }));
    await t.service.reconcile(story.id);
    jobs = await t.flow.listJobs();
    const frames = jobs.filter(j => j.kind === 'image');
    expect(frames).toHaveLength(3);
    expect(frames.every(j => j.group === story.id)).toBe(true);
    const hadiah = frames.find(j => j.prompt.includes('Laras holds Kapas'))!;
    expect(hadiah.characters!.map(c => c.name).sort()).toEqual(['Kapas', 'Laras']);
    expect(frames.find(j => j.prompt.includes('misty valley'))!.characters ?? []).toEqual([]);
    const rec = (await t.service.get(story.id))!;
    expect(rec.status).toBe('framing');
    expect(rec.cast.every(c => c.status === 'done' && c.flowCharacterId)).toBe(true);
    expect(existsSync(t.service.castPath(story.id, 'LARAS'))).toBe(true);

    await finish(t, 'image');
    await t.service.reconcile(story.id);
    const review = (await t.service.get(story.id))!;
    expect(review.status).toBe('review');
    expect(review.shots.every(s => s.frame?.status === 'done' && s.frame.mediaId)).toBe(true);
    expect(existsSync(t.service.framePath(story.id, '01-hadiah'))).toBe(true);
    expect((await t.flow.listJobs()).some(j => j.kind === 'video')).toBe(false);
  });

  it('a landscape keyframe fails QC and is redrawn automatically', async () => {
    const t = setup();
    let calls = 0;
    (t.service as unknown as { deps: { imageSize: () => Promise<{ width: number; height: number }> } }).deps.imageSize = async () => (++calls === 1 ? { width: 1376, height: 768 } : { width: 768, height: 1376 });
    const story = await t.service.create({ ...board, shots: [board.shots[1]!] });
    await t.service.prepare(story.id);
    await finish(t, 'character');
    await t.service.reconcile(story.id);
    await finish(t, 'image');
    await t.service.reconcile(story.id);
    const s = (await t.service.get(story.id))!.shots[0]!;
    expect(s.frame).toMatchObject({ status: 'queued', attempts: 1 });
    expect(s.frame!.lastError).toMatch(/9:16|portrait/i);
  });

  it('review: redraw one frame (optionally with a new prompt) without touching the others', async () => {
    const t = setup();
    const story = await t.service.create(board);
    await t.service.prepare(story.id);
    await finish(t, 'character'); await t.service.reconcile(story.id);
    await finish(t, 'image'); await t.service.reconcile(story.id);
    await t.service.redrawFrame(story.id, '01-hadiah', 'Medium shot, the camera stays still. LARAS hugs KAPAS tightly on a porch.');
    const rec = (await t.service.get(story.id))!;
    expect(rec.status).toBe('framing');
    expect(rec.shots.find(s => s.id === '01-hadiah')!.frame!.status).toBe('queued');
    expect(rec.shots.filter(s => s.frame?.status === 'done')).toHaveLength(2);
    const redraw = (await t.flow.listJobs()).find(j => j.kind === 'image' && j.status === 'queued' && j.technique?.endsWith('frame:01-hadiah'))!;
    expect(redraw.prompt).toContain('Laras hugs Kapas tightly');
    expect((await t.service.readStoryboard(story.id)).shots[1]!.prompt).toContain('LARAS hugs KAPAS tightly');
    await finish(t, 'image'); await t.service.reconcile(story.id);
    expect((await t.service.get(story.id))!.status).toBe('review');
  });

  it('render from review animates each approved keyframe (startFrame) with the characters attached, then assembles', async () => {
    const t = setup();
    const story = await t.service.create(board);
    await expect(t.service.render(story.id)).rejects.toThrow(/keyframe|review/i);
    await t.service.prepare(story.id);
    await finish(t, 'character'); await t.service.reconcile(story.id);
    await finish(t, 'image', j => ({ mediaId: `frame-${j.id}`, caption: `Frame ${j.id}` })); await t.service.reconcile(story.id);
    await t.service.render(story.id);
    const videos = (await t.flow.listJobs()).filter(j => j.kind === 'video');
    expect(videos).toHaveLength(3);
    const frames = (await t.service.get(story.id))!.shots;
    for (const v of videos) {
      expect(v.group).toBe(story.id);
      const shot = frames.find(s => v.technique?.endsWith(s.id))!;
      expect(v.startFrame).toEqual({ mediaId: shot.frame!.mediaId, caption: shot.frame!.caption });
    }
    expect(videos.find(v => v.technique!.endsWith('01-hadiah'))!.characters!.map(c => c.name).sort()).toEqual(['Kapas', 'Laras']);
    await finish(t, 'video'); await t.service.reconcile(story.id);
    expect((await t.service.get(story.id))!.status).toBe('done');
  });

  it('a failed character sheet is retried, and after 3 takes the story fails with the reason', async () => {
    const t = setup();
    const story = await t.service.create({ ...board, shots: [board.shots[2]!] });
    await t.service.prepare(story.id);
    for (let i = 0; i < 3; i++) {
      const job = (await t.flow.listJobs()).find(j => j.kind === 'character' && j.status === 'queued')!;
      for (let k = 0; k < 3; k++) { await t.flow.claimJob('mac').catch(() => undefined); await t.flow.failJob(job.id, 'Flow: policy violation'); }
      await t.service.reconcile(story.id);
    }
    const rec = (await t.service.get(story.id))!;
    expect(rec.status).toBe('failed');
    expect(rec.error).toMatch(/Kapas.*policy violation/);
  });
});
