import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlowStore } from '../src/flow/store.js';
import { StoryService, type ClipProbe } from '../src/stories/service.js';
import type { Storyboard } from '../src/stories/storyboard.js';

const board: Storyboard = {
  title: 'Selendang Merah',
  characters: { RABBIT: 'a cream rabbit with a red knitted scarf' },
  audio: 'Audio: voice-over: "{line}"',
  audioSilent: 'Audio: wind, no voice.',
  shots: [
    { id: '00-intro', silent: true, prompt: 'Extreme wide shot of a valley at sunrise.' },
    { id: '01-hadiah', prompt: 'Medium shot, RABBIT on a porch.', narration: 'Namanya Kapas.' },
    { id: '02-hujan', prompt: 'Wide shot, RABBIT in the rain.', narration: 'Ia menunggu dalam hujan.' }
  ]
};

const goodClip: ClipProbe = { durationSec: 6, hasAudio: true };

function setup(opts: { probe?: (file: string) => Promise<ClipProbe>; assemble?: (dir: string) => Promise<void> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-stories-'));
  const flow = new FlowStore(dataDir);
  const assembled: string[] = [];
  const deps = {
    dataDir,
    flow,
    probe: opts.probe ?? (async () => goodClip),
    assemble: opts.assemble ?? (async (dir: string) => {
      assembled.push(dir);
      writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(4096, 1));
    })
  };
  return { dataDir, flow, assembled, deps, service: new StoryService(deps) };
}

/** What the bridge does: claim the job, write the clip, mark it done. */
async function bridgeFinishes(dataDir: string, flow: FlowStore, jobId: string, bytes = 8192) {
  const dir = join(dataDir, 'flow', 'clips');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${jobId}.mp4`);
  writeFileSync(file, Buffer.alloc(bytes, 7));
  await flow.completeJob(jobId, { filePath: file, bytes });
}

async function finishAllQueued(t: ReturnType<typeof setup>, id: string) {
  const story = await t.service.get(id);
  for (const shot of story!.shots) if (shot.status === 'queued' && shot.jobId) await bridgeFinishes(t.dataDir, t.flow, shot.jobId);
}

describe('StoryService', () => {
  it('rejects an invalid storyboard with the validation errors', async () => {
    const t = setup();
    await expect(t.service.create({ ...board, shots: [] })).rejects.toThrow(/no shots/);
  });

  it('render queues exactly one Flow job per shot with the built prompt, idempotently', async () => {
    const t = setup();
    const story = await t.service.create(board);
    await t.service.render(story.id);
    await t.service.render(story.id);
    const jobs = await t.flow.listJobs();
    expect(jobs).toHaveLength(3);
    expect(jobs.every(j => j.durationSec === 6 && j.aspect === '9:16')).toBe(true);
    expect(jobs.map(j => j.technique).sort()).toEqual([`story:${story.id}/00-intro`, `story:${story.id}/01-hadiah`, `story:${story.id}/02-hujan`]);
    const hadiah = jobs.find(j => j.technique?.endsWith('01-hadiah'))!;
    expect(hadiah.prompt).toContain('a cream rabbit with a red knitted scarf');
    expect(hadiah.prompt).toContain('"Namanya Kapas."');
    expect((await t.service.get(story.id))!.status).toBe('rendering');
  });

  it('collects finished clips, assembles once, and ends done with the final video', async () => {
    const t = setup();
    const story = await t.service.create(board);
    await t.service.render(story.id);
    await finishAllQueued(t, story.id);
    await t.service.reconcile(story.id);
    await t.service.reconcile(story.id);
    const done = (await t.service.get(story.id))!;
    expect(done.status).toBe('done');
    expect(done.shots.every(s => s.status === 'done')).toBe(true);
    expect(t.assembled).toHaveLength(1);
    expect(existsSync(t.service.videoPath(story.id))).toBe(true);
    for (const s of board.shots) expect(existsSync(join(t.service.storyDir(story.id), `${s.id}.mp4`))).toBe(true);
  });

  it('a clip failing QC (no voice) is re-rendered, and after 3 bad takes the story fails with the reason', async () => {
    const t = setup({ probe: async file => (file.includes('01-hadiah') ? { durationSec: 6, hasAudio: false } : goodClip) });
    const story = await t.service.create(board);
    await t.service.render(story.id);
    for (let take = 1; take <= 3; take++) {
      await finishAllQueued(t, story.id);
      await t.service.reconcile(story.id);
    }
    const failed = (await t.service.get(story.id))!;
    const shot = failed.shots.find(s => s.id === '01-hadiah')!;
    expect(shot.attempts).toBe(3);
    expect(shot.status).toBe('failed');
    expect(shot.error).toMatch(/no audio/);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/01-hadiah/);
    expect(t.assembled).toHaveLength(0);
    expect((await t.flow.listJobs()).filter(j => j.technique?.endsWith('01-hadiah'))).toHaveLength(3);
  });

  it('a clip that is too short also fails QC', async () => {
    const t = setup({ probe: async () => ({ durationSec: 1.2, hasAudio: true }) });
    const story = await t.service.create({ ...board, shots: [board.shots[1]!] });
    await t.service.render(story.id);
    await finishAllQueued(t, story.id);
    await t.service.reconcile(story.id);
    const s = (await t.service.get(story.id))!.shots[0]!;
    expect(s.attempts).toBe(1);
    expect(s.status).toBe('queued');
    expect(s.lastError).toMatch(/too short/);
  });

  it('a Flow job that exhausts its own retries is requeued as a new take', async () => {
    const t = setup();
    await t.flow.addAccount({ label: 'A', email: 'a@x' }); // failJob only moves a running job: claimJob needs an account
    const story = await t.service.create({ ...board, shots: [board.shots[1]!] });
    await t.service.render(story.id);
    const first = (await t.service.get(story.id))!.shots[0]!.jobId!;
    for (let i = 0; i < 3; i++) { await t.flow.claimJob('mac'); await t.flow.failJob(first, 'Flow clip failed'); }
    expect((await t.flow.getJob(first))!.status).toBe('failed');
    await t.service.reconcile(story.id);
    const s = (await t.service.get(story.id))!.shots[0]!;
    expect(s.status).toBe('queued');
    expect(s.jobId).not.toBe(first);
    expect(s.attempts).toBe(1);
  });

  it('retry resets failed shots and renders them again', async () => {
    const t = setup({ probe: async () => ({ durationSec: 6, hasAudio: false }) });
    const story = await t.service.create({ ...board, shots: [board.shots[1]!] });
    await t.service.render(story.id);
    for (let i = 0; i < 3; i++) { await finishAllQueued(t, story.id); await t.service.reconcile(story.id); }
    expect((await t.service.get(story.id))!.status).toBe('failed');
    await t.service.retry(story.id);
    const again = (await t.service.get(story.id))!;
    expect(again.status).toBe('rendering');
    // S4: one new take, and the attempts are kept (the 3 failed takes stay on record, so the next failure ends it) — not zeroed.
    expect(again.shots[0]).toMatchObject({ status: 'queued', attempts: 3 });
  });

  it('assembly failure marks the story failed; retry assembles again without re-rendering', async () => {
    let fail = true;
    const t = setup({
      assemble: async dir => {
        if (fail) throw new Error('ffmpeg exited 8');
        writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(4096, 1));
      }
    });
    const story = await t.service.create(board);
    await t.service.render(story.id);
    await finishAllQueued(t, story.id);
    await t.service.reconcile(story.id);
    const broken = (await t.service.get(story.id))!;
    expect(broken.status).toBe('failed');
    expect(broken.error).toMatch(/ffmpeg exited 8/);
    fail = false;
    const jobsBefore = (await t.flow.listJobs()).length;
    await t.service.retry(story.id);
    await t.service.reconcile(story.id);
    expect((await t.service.get(story.id))!.status).toBe('done');
    expect((await t.flow.listJobs()).length).toBe(jobsBefore);
  });

  it('reuses an existing Flow clip without spending a render', async () => {
    const t = setup();
    const old = await t.flow.createJob({ prompt: 'castle', durationSec: 6 });
    await t.flow.claimJob('mac');
    await bridgeFinishes(t.dataDir, t.flow, old.id);
    const story = await t.service.create({ ...board, shots: [board.shots[1]!, { id: '02-istana', prompt: '', reuse: { jobId: old.id, start: 1.6 } }] });
    await t.service.render(story.id);
    expect((await t.flow.listJobs()).length).toBe(2);
    await finishAllQueued(t, story.id);
    await t.service.reconcile(story.id);
    const done = (await t.service.get(story.id))!;
    expect(done.status).toBe('done');
    const plan = JSON.parse(readFileSync(join(t.service.storyDir(story.id), 'assemble.json'), 'utf8'));
    expect(plan.shots.find((s: { id: string }) => s.id === '02-istana').reuse).toEqual({ file: join(t.service.storyDir(story.id), '02-istana.mp4'), start: 1.6 });
  });

  it('refuses to render when known Flow credits cannot cover the new shots', async () => {
    const t = setup();
    const acc = await t.flow.addAccount({ label: 'a', email: 'a@x.io' });
    await t.flow.heartbeat('mac', [{ id: acc.id, credits: 13 }]);
    const story = await t.service.create(board);
    await expect(t.service.render(story.id)).rejects.toThrow(/credits/);
    expect(await t.flow.listJobs()).toHaveLength(0);
    await t.service.render(story.id, { force: true });
    expect(await t.flow.listJobs()).toHaveLength(3);
  });

  it('state survives a restart: a new service instance continues the same story', async () => {
    const t = setup();
    const story = await t.service.create(board);
    await t.service.render(story.id);
    await finishAllQueued(t, story.id);
    const restarted = new StoryService(t.deps);
    expect(await restarted.activeIds()).toEqual([story.id]);
    await restarted.reconcile(story.id);
    expect((await restarted.get(story.id))!.status).toBe('done');
  });

  it('concurrent reconciles never assemble twice', async () => {
    const t = setup();
    const story = await t.service.create(board);
    await t.service.render(story.id);
    await finishAllQueued(t, story.id);
    await Promise.all([t.service.reconcile(story.id), t.service.reconcile(story.id), t.service.reconcile(story.id)]);
    expect(t.assembled).toHaveLength(1);
  });

  it('editing the storyboard re-renders only shots whose prompt changed', async () => {
    const t = setup();
    const story = await t.service.create(board);
    await t.service.render(story.id);
    await finishAllQueued(t, story.id);
    await t.service.reconcile(story.id);
    const edited = { ...board, shots: board.shots.map(s => (s.id === '02-hujan' ? { ...s, narration: 'Ia menunggu, sendirian.' } : s)) };
    await t.service.updateStoryboard(story.id, edited);
    await t.service.render(story.id);
    const s = (await t.service.get(story.id))!.shots;
    expect(s.find(x => x.id === '02-hujan')!.status).toBe('queued');
    expect(s.filter(x => x.status === 'done').map(x => x.id)).toEqual(['00-intro', '01-hadiah']);
    expect((await t.flow.listJobs()).length).toBe(4);
  });
});
