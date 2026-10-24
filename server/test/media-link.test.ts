import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlowStore, type FlowJob } from '../src/flow/store.js';
import { linkOrCopy } from '../src/media/link.js';
import { CoverService } from '../src/stories/covers.js';
import { StoryService } from '../src/stories/service.js';
import type { Storyboard } from '../src/stories/storyboard.js';

const sameFile = (a: string, b: string) => {
  const x = statSync(a); const y = statSync(b);
  return x.dev === y.dev && x.ino === y.ino;
};

function tmp() {
  return mkdtempSync(join(tmpdir(), 'nc-link-'));
}

describe('linkOrCopy', () => {
  it('hard-links: same inode, one copy on disk', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.mp4'), Buffer.alloc(5000, 1));
    await linkOrCopy(join(dir, 'a.mp4'), join(dir, 'b.mp4'));
    expect(sameFile(join(dir, 'a.mp4'), join(dir, 'b.mp4'))).toBe(true);
    expect(statSync(join(dir, 'a.mp4')).nlink).toBe(2);
  });

  it('replaces an existing target atomically and leaves no temp files', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'new.png'), Buffer.alloc(3000, 2));
    writeFileSync(join(dir, 'frame.png'), Buffer.alloc(100, 9));
    await linkOrCopy(join(dir, 'new.png'), join(dir, 'frame.png'));
    expect(sameFile(join(dir, 'new.png'), join(dir, 'frame.png'))).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(['frame.png', 'new.png']);
  });

  it('linking a file onto itself (already linked) is a no-op without leftovers', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.mp4'), Buffer.alloc(5000, 1));
    await linkOrCopy(join(dir, 'a.mp4'), join(dir, 'b.mp4'));
    await linkOrCopy(join(dir, 'a.mp4'), join(dir, 'b.mp4'));
    expect(readdirSync(dir).sort()).toEqual(['a.mp4', 'b.mp4']);
    expect(statSync(join(dir, 'a.mp4')).nlink).toBe(2);
  });

  it('falls back to a copy when link throws EXDEV (another device)', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.mp4'), Buffer.alloc(5000, 4));
    const exdev = async () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); };
    await linkOrCopy(join(dir, 'a.mp4'), join(dir, 'b.mp4'), { link: exdev });
    expect(sameFile(join(dir, 'a.mp4'), join(dir, 'b.mp4'))).toBe(false);
    expect(readFileSync(join(dir, 'b.mp4')).equals(readFileSync(join(dir, 'a.mp4')))).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(['a.mp4', 'b.mp4']);
  });

  it('other errors are not swallowed (missing source)', async () => {
    const dir = tmp();
    await expect(linkOrCopy(join(dir, 'missing.mp4'), join(dir, 'b.mp4'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(readdirSync(dir)).toEqual([]);
  });
});

const board: Storyboard = {
  title: 'Selendang Merah',
  mode: 'konsisten',
  characters: { LARAS: 'a girl with two black braids' },
  audio: 'Audio: voice-over: "{line}"',
  shots: [
    { id: '00-intro', silent: true, prompt: 'Extreme wide shot, the camera pushes in slowly. A misty valley.' },
    { id: '01-hadiah', prompt: 'Medium shot, the camera stays still. LARAS on a porch.', narration: 'Namanya Laras.' }
  ]
};

function setupService() {
  const dataDir = tmp();
  const flow = new FlowStore(join(dataDir, 'flow'));
  const service = new StoryService({
    dataDir, flow,
    probe: async () => ({ durationSec: 6, hasAudio: true }),
    imageSize: async () => ({ width: 768, height: 1376 }),
    assemble: async dir => writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(4096, 1))
  });
  return { dataDir, flow, service };
}

async function finish(t: ReturnType<typeof setupService>, kind: FlowJob['kind']) {
  const dir = join(t.dataDir, 'flow', 'clips');
  mkdirSync(dir, { recursive: true });
  for (const job of (await t.flow.listJobs()).filter(j => j.kind === kind && j.status === 'queued')) {
    const file = join(dir, `${job.id}.${kind === 'video' ? 'mp4' : 'png'}`);
    writeFileSync(file, Buffer.alloc(20_000, 3));
    await t.flow.completeJob(job.id, { filePath: file, bytes: 20_000, result: { mediaId: `m-${job.id}`, caption: 'c', flowCharacterId: `fc-${job.id}` } });
  }
}

describe('collect links job results into the story (one copy on disk)', () => {
  it('cast sheets, keyframes and clips are hard links to flow/clips/<job>', async () => {
    const t = setupService();
    const story = await t.service.create(board);
    await t.service.prepare(story.id);
    await finish(t, 'character');
    await t.service.reconcile(story.id);
    await finish(t, 'image');
    await t.service.reconcile(story.id);
    await t.service.render(story.id);
    await finish(t, 'video');
    await t.service.reconcile(story.id);

    const rec = (await t.service.get(story.id))!;
    const clip = (jobId: string | undefined, ext: string) => join(t.dataDir, 'flow', 'clips', `${jobId}.${ext}`);
    expect(sameFile(t.service.castPath(story.id, 'LARAS'), clip(rec.cast![0]!.jobId, 'png'))).toBe(true);
    for (const shot of rec.shots) {
      expect(sameFile(t.service.framePath(story.id, shot.id), clip(shot.frame!.jobId, 'png'))).toBe(true);
      expect(sameFile(t.service.shotPath(story.id, shot.id), clip(shot.jobId, 'mp4'))).toBe(true);
    }
  });

  it('a reused clip (shot.reuse) is linked too', async () => {
    const t = setupService();
    const quick: Storyboard = { ...board, mode: 'cepat' };
    const first = await t.service.create(quick);
    await t.service.render(first.id);
    await finish(t, 'video');
    await t.service.reconcile(first.id);
    const jobId = (await t.service.get(first.id))!.shots[1]!.jobId!;
    const second = await t.service.create({ ...quick, shots: [quick.shots[0]!, { ...quick.shots[1]!, reuse: { jobId } }] });
    await t.service.render(second.id);
    await finish(t, 'video');
    await t.service.reconcile(second.id);
    expect(sameFile(t.service.shotPath(second.id, '01-hadiah'), join(t.dataDir, 'flow', 'clips', `${jobId}.mp4`))).toBe(true);
  });
});

describe('template covers', () => {
  it('a finished cover is a hard link to its job clip', async () => {
    const dataDir = tmp();
    const flow = new FlowStore(join(dataDir, 'flow'));
    const covers = new CoverService({ dataDir, flow });
    await covers.queue('drama-hewan');
    const job = (await flow.listJobs())[0]!;
    mkdirSync(join(dataDir, 'flow', 'clips'), { recursive: true });
    const file = join(dataDir, 'flow', 'clips', `${job.id}.png`);
    writeFileSync(file, Buffer.alloc(20_000, 5));
    await flow.completeJob(job.id, { filePath: file, bytes: 20_000 });
    const served = await covers.file('drama-hewan');
    expect(served).toBe(join(dataDir, 'covers', 'drama-hewan.img'));
    expect(sameFile(served!, file)).toBe(true);
  });
});
