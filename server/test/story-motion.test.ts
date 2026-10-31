import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bibleBoard, finishQueued, renderedStory, serviceSetup } from './bible-board.js';
import { createMotionQc } from '../src/media/motion-qc.js';
import { StoryService, type MotionVerdict, type ShotState, type StoryDeps } from '../src/stories/service.js';
import { hashFor, type Storyboard } from '../src/stories/storyboard.js';

type CheckInput = Parameters<NonNullable<StoryDeps['motion']>['check']>[0];

const verdict = (status: MotionVerdict['status'], extra: Partial<MotionVerdict> = {}): MotionVerdict => ({
  status, score: status === 'fail' ? 38 : status === 'warn' ? 72 : 100,
  reasons: status === 'ok' ? [] : ['Gambar berganti/melebur sendiri di detik 1.7 (adegan atau karakter digambar ulang di tengah klip)'], ...extra
});

/** A scripted motion check: one verdict per shot id (default ok), every call recorded. */
function motionStub(by: Record<string, MotionVerdict | 'throw' | 'none'> = {}) {
  const calls: CheckInput[] = [];
  const deps: NonNullable<StoryDeps['motion']> = {
    check: async input => {
      calls.push(input);
      const id = /([0-9]{2}-[a-z]+)\.mp4$/.exec(input.file)?.[1] ?? '';
      const v = by[id] ?? verdict('ok');
      if (v === 'throw') throw new Error('python tidak ditemukan');
      return v === 'none' ? undefined : v;
    }
  };
  return { deps, calls };
}

const cepat = (): Storyboard => ({ ...bibleBoard(), mode: 'cepat' });
const states = async (t: { service: StoryService }, id: string) => Object.fromEntries((await t.service.get(id))!.shots.map(s => [s.id, s]));
const videoJobs = async (t: ReturnType<typeof serviceSetup>) => (await t.flow.listJobs()).filter(j => j.kind === 'video');

describe('collect: a finished clip is checked for motion (all modes)', () => {
  it('stores the verdict on the shot: status, score, reasons, time — and the clip stays done', async () => {
    const m = motionStub({ '01-laras': verdict('warn', { suggest: { trimOut: 4.1 } }) });
    const t = serviceSetup({ motion: m.deps });
    const rec = await renderedStory(t, cepat());
    const s = (await states(t, rec.id))['01-laras']!;
    expect(s.status).toBe('done');
    expect(s.motion).toMatchObject({ status: 'warn', score: 72, suggest: { trimOut: 4.1 } });
    expect(s.motion!.reasons[0]).toMatch(/melebur/);
    expect(s.motion!.at).toBeGreaterThan(0);
    expect((await states(t, rec.id))['02-kapas']!.motion).toMatchObject({ status: 'ok', reasons: [] });
  });

  it('a fail flags the shot for review and the gate refuses to assemble — through the existing gate', async () => {
    const t = serviceSetup({ motion: motionStub({ '02-kapas': verdict('fail') }).deps });
    const rec = await renderedStory(t, cepat());
    const s = (await states(t, rec.id))['02-kapas']!;
    expect(s.needsReview).toBe(true);
    expect(t.service.gateBlockers(await t.service.get(rec.id) as never).map(b => b.id)).toEqual(['02-kapas']);
    expect((await t.service.get(rec.id))!.status).toBe('review');
    await expect(t.service.assemble(rec.id)).rejects.toThrow(/02-kapas/);
    // a human signs it off: the gate opens
    await t.service.approveShot(rec.id, '02-kapas', { by: 'u_admin' });
    expect((await states(t, rec.id))['02-kapas']!.needsReview).toBeUndefined();
    expect(t.service.gateBlockers((await t.service.get(rec.id))!)).toEqual([]);
    await t.service.assemble(rec.id);
    expect((await t.service.get(rec.id))!.status).toBe('done');
  });

  it('a fail NEVER spends: no job is queued, no render is started (nothing paid happens by itself)', async () => {
    const t = serviceSetup({ motion: motionStub({ '01-laras': verdict('fail'), '02-kapas': verdict('fail') }).deps });
    const rec = await renderedStory(t, cepat());
    expect(await videoJobs(t)).toHaveLength(2);                      // the two first takes, no third
    await t.service.reconcile(rec.id);
    await t.service.reconcileAll();
    expect(await videoJobs(t)).toHaveLength(2);
    const s = await states(t, rec.id);
    expect(s['01-laras']!.attempts).toBe(0);
    expect(s['01-laras']!.status).toBe('done');
  });

  it('a warn is shown but does not gate', async () => {
    const t = serviceSetup({ motion: motionStub({ '01-laras': verdict('warn'), '02-kapas': verdict('warn') }).deps });
    const rec = await renderedStory(t, cepat());
    const s = await states(t, rec.id);
    expect(s['01-laras']!.needsReview).toBeUndefined();
    expect(t.service.gateBlockers((await t.service.get(rec.id))!)).toEqual([]);
    expect((await t.service.get(rec.id))!.status).toBe('done');
  });

  it('a check that throws, or answers nothing, never blocks the clip: it stays done, one event line, no verdict', async () => {
    for (const how of ['throw', 'none'] as const) {
      const t = serviceSetup({ motion: motionStub({ '01-laras': how }).deps });
      const rec = await renderedStory(t, cepat());
      const s = await states(t, rec.id);
      expect(s['01-laras']!.status).toBe('done');
      expect(s['01-laras']!.motion).toBeUndefined();
      expect(s['01-laras']!.needsReview).toBeUndefined();
      const lines = (await t.service.get(rec.id))!.events.filter(e => /Cek gerak 01-laras/.test(e.message));
      expect(lines).toHaveLength(1);
      expect(s['02-kapas']!.motion?.status).toBe('ok');             // the other clip is still checked
      expect((await t.service.get(rec.id))!.status).toBe('done');
    }
  });

  it('no motion dependency = nothing changes (inert)', async () => {
    const t = serviceSetup();
    const rec = await renderedStory(t, cepat());
    expect(rec.shots.every(s => !s.motion && !s.needsReview)).toBe(true);
  });

  it('passes the camera move, the look family, the shot zoom and the file; cepat has no keyframe', async () => {
    const m = motionStub();
    const t = serviceSetup({ motion: m.deps });
    const board = cepat();
    board.shots[0] = { ...board.shots[0]!, zoom: 1.2 };
    const rec = await renderedStory(t, board);
    const a = m.calls.find(c => c.file.endsWith('01-laras.mp4'))!;
    const b = m.calls.find(c => c.file.endsWith('02-kapas.mp4'))!;
    expect(a).toMatchObject({ file: t.service.shotPath(rec.id, '01-laras'), move: 'static', look: 'film-real', zoom: 1.2 });
    expect(b).toMatchObject({ move: 'push-in', look: 'film-real' });
    expect(a.keyframe).toBeUndefined();
    expect(b.zoom).toBeUndefined();
  });

  it('konsisten: the shot keyframe is handed over', async () => {
    const m = motionStub();
    const t = serviceSetup({ motion: m.deps });
    const board: Storyboard = { ...bibleBoard(), mode: 'konsisten' };
    const story = await t.service.create(board);
    await t.service.prepare(story.id);
    await finishQueued(t, 'character'); await t.service.reconcile(story.id);
    await finishQueued(t, 'image'); await t.service.reconcile(story.id);
    await t.service.render(story.id, { force: true });
    await finishQueued(t, 'video'); await t.service.reconcile(story.id);
    expect(m.calls).toHaveLength(2);
    expect(existsSync(t.service.framePath(story.id, '01-laras'))).toBe(true);
    expect(m.calls.find(c => c.file.endsWith('01-laras.mp4'))!.keyframe).toBe(t.service.framePath(story.id, '01-laras'));
  });

  it('a clip rejected by the basic QC is never motion-checked', async () => {
    const m = motionStub();
    const t = serviceSetup({ motion: m.deps, probe: async () => ({ durationSec: 1, hasAudio: true }) });
    const story = await t.service.create(cepat());
    await t.service.render(story.id, { force: true });
    await finishQueued(t, 'video'); await t.service.reconcile(story.id);
    expect(m.calls).toHaveLength(0);
  });

  it('does not touch the clip identity: jobId and promptHash are the render’s own', async () => {
    const t0 = serviceSetup();
    const plain = await renderedStory(t0, cepat());
    const t = serviceSetup({ motion: motionStub({ '01-laras': verdict('fail') }).deps });
    const rec = await renderedStory(t, cepat());
    const board = await t.service.readStoryboard(rec.id);
    for (const s of rec.shots) {
      expect(s.promptHash).toBe(hashFor(board, board.shots.find(x => x.id === s.id)!));
      expect(s.promptHash).toBe(plain.shots.find(x => x.id === s.id)!.promptHash);
      expect(s.jobId).toBeTruthy();
    }
  });
});

describe('a new take is checked again; the old verdict never sticks to it', () => {
  async function edited(t: ReturnType<typeof serviceSetup>, id: string) {
    const board = await t.service.readStoryboard(id);
    board.shots[1] = { ...board.shots[1]!, prompt: board.shots[1]!.prompt + ' A gull crosses the sky.', intent: { ...board.shots[1]!.intent!, action: 'lifts the woven basket while a gull crosses the sky' } };
    await t.service.updateStoryboard(id, board);
    await t.service.render(id, { force: true });
    await finishQueued(t, 'video');
    await t.service.reconcile(id);
  }

  it('a flagged shot re-rendered: the new take gets its own verdict, the flag follows it', async () => {
    let n = 0;
    const calls: string[] = [];
    const t = serviceSetup({ motion: { check: async input => { calls.push(input.file); return n++ === 1 ? verdict('fail') : verdict('ok'); } } });
    const rec = await renderedStory(t, cepat());
    expect((await states(t, rec.id))['02-kapas']!.needsReview).toBe(true);
    const first = (await states(t, rec.id))['02-kapas']!.jobId;
    await edited(t, rec.id);
    const s = (await states(t, rec.id))['02-kapas']!;
    expect(s.jobId).not.toBe(first);
    expect(s.motion?.status).toBe('ok');
    expect(s.needsReview).toBeUndefined();                       // the flag was the old take's
    expect(calls).toHaveLength(3);
  });

  it('an approved shot whose new take fails is flagged again (the old sign-off was for the old take)', async () => {
    const t = serviceSetup({ motion: motionStub({ '02-kapas': verdict('fail') }).deps });
    const rec = await renderedStory(t, cepat());
    await t.service.approveShot(rec.id, '02-kapas', { by: 'u_admin' });
    await edited(t, rec.id);
    expect((await states(t, rec.id))['02-kapas']!.needsReview).toBe(true);
    expect(t.service.gateBlockers((await t.service.get(rec.id))!).map(b => b.id)).toEqual(['02-kapas']);
  });

  it('while a shot is re-queued its old verdict is dropped, not shown on the empty slot', async () => {
    const t = serviceSetup({ motion: motionStub({ '02-kapas': verdict('fail') }).deps });
    const rec = await renderedStory(t, cepat());
    const board = await t.service.readStoryboard(rec.id);
    board.shots[1] = { ...board.shots[1]!, intent: { ...board.shots[1]!.intent!, action: 'lifts the woven basket while a gull crosses the sky' } };
    await t.service.updateStoryboard(rec.id, board);
    await t.service.render(rec.id, { force: true });
    const s = (await states(t, rec.id))['02-kapas']!;
    expect(s.status).toBe('queued');
    expect(s.motion).toBeUndefined();
    expect(s.needsReview).toBeUndefined();
  });
});

describe('a clip re-queued in place (human-clicked audit repair) loses its old verdict', () => {
  it('repairShot re-queues the SAME shot state: the old motion verdict and its flag are dropped with the old take', async () => {
    const audit = {
      model: async () => 'google/gemini-2.5-flash',
      run: async () => ({ score: 61, dimensions: { sceneMatch: 61, actionMatch: 61, moodMatch: 61, composition: 61 }, issues: ['x'], reasoning: 'y', repair: 'Add a wooden gate.', costUsd: 0 }),
      frames: async () => []
    };
    const t = serviceSetup({ motion: motionStub({ '01-laras': verdict('fail') }).deps, audit: { ...audit, frames: async (_c: string, dir: string, id: string) => { const f = join(dir, `audit-${id}-1.png`); writeFileSync(f, Buffer.alloc(2048, 5)); return [f]; } } });
    const rec = await renderedStory(t, { ...cepat(), shots: [cepat().shots[0]!], scenes: undefined, bible: undefined });
    const before = (await states(t, rec.id))['01-laras']!;
    expect(before.motion?.status).toBe('fail');
    await t.service.repairShot(rec.id, '01-laras', { by: 'u_admin' });
    const after = (await states(t, rec.id))['01-laras']!;
    expect(after.status).toBe('queued');
    expect(after.jobId).not.toBe(before.jobId);
    expect(after.motion).toBeUndefined();
    expect(after.motionJobId).toBeUndefined();
    expect(after.motionReview).toBeUndefined();
    expect(after.needsReview).toBeUndefined();
  });
});

describe('undo: a verdict always travels with its own take', () => {
  it('restoring an older take brings back ITS verdict (and flag), not the newer take’s; the other shot is untouched', async () => {
    let n = 0;
    const t = serviceSetup({ motion: { check: async input => (input.file.endsWith('02-kapas.mp4') ? (n++ === 0 ? verdict('fail') : verdict('ok')) : verdict('ok')) } });
    const done = await renderedStory(t, cepat());
    const old = done.shots[1]!;
    expect(old).toMatchObject({ needsReview: true, motion: { status: 'fail' }, motionJobId: old.jobId });
    const taken = await t.service.snapshots.take(done.id, 'ubah shot 2');
    const board = await t.service.readStoryboard(done.id);
    board.shots[1] = { ...board.shots[1]!, intent: { ...board.shots[1]!.intent!, action: 'lifts the woven basket while a gull crosses the sky' } };
    const edited = await t.service.updateStoryboard(done.id, board, { rev: taken.rev });
    await t.service.snapshots.commit(taken.undoId, edited.rev);
    await t.service.render(done.id, { force: true });
    await finishQueued(t, 'video');
    await t.service.reconcile(done.id);
    const newer = (await states(t, done.id))['02-kapas']!;
    expect(newer.jobId).not.toBe(old.jobId);
    expect(newer).toMatchObject({ motion: { status: 'ok' }, motionJobId: newer.jobId });
    expect(newer.needsReview).toBeUndefined();

    expect((await t.service.restoreSnapshot(done.id, taken.undoId, (await t.service.get(done.id))!.rev)).result).toBe('ok');
    const back = (await states(t, done.id))['02-kapas']!;
    expect(back.jobId).toBe(old.jobId);
    expect(back).toMatchObject({ motion: { status: 'fail' }, motionJobId: old.jobId, needsReview: true });
    expect((await states(t, done.id))['01-laras']!.motion?.status).toBe('ok');
  });
});

describe('gateBlockers: a human approval only covers the verdict it saw', () => {
  const base = { id: 's', status: 'done', attempts: 0 } as ShotState;
  const svc = () => serviceSetup().service;
  it('approved after the audit, then a failing motion verdict arrives: blocked again', () => {
    const shot = { ...base, needsReview: true, audit: { score: 90, atMs: 10 }, approvedAtMs: 20, motion: { status: 'fail', score: 40, reasons: ['x'], at: 30 } } as ShotState;
    expect(svc().gateBlockers({ shots: [shot] }).map(b => b.id)).toEqual(['s']);
  });
  it('approved after the failing motion verdict: open', () => {
    const shot = { ...base, needsReview: true, audit: { score: 90, atMs: 10 }, approvedAtMs: 40, motion: { status: 'fail', score: 40, reasons: ['x'], at: 30 } } as ShotState;
    expect(svc().gateBlockers({ shots: [shot] })).toEqual([]);
  });
  it('an ok/warn motion verdict arriving after an approval does not undo it', () => {
    const shot = { ...base, needsReview: true, audit: { score: 90, atMs: 10 }, approvedAtMs: 20, motion: { status: 'warn', score: 70, reasons: ['x'], at: 30 } } as ShotState;
    expect(svc().gateBlockers({ shots: [shot] })).toEqual([]);
  });
});

describe('backfill: free check of the clips already done', () => {
  /** A story with finished clips made BEFORE motion checking existed. */
  async function legacy(t: ReturnType<typeof serviceSetup>) {
    return renderedStory(t, cepat());
  }
  const withMotion = (m: ReturnType<typeof motionStub>) => ({ motion: m.deps });

  it('checks every done clip that has no verdict, and does not gate or touch the revision', async () => {
    const plain = serviceSetup();
    const rec = await legacy(plain);
    // same data dir, now with motion
    const m = motionStub({ '01-laras': verdict('fail'), '02-kapas': verdict('warn') });
    const t = new StoryService({ dataDir: plain.dataDir, flow: plain.flow, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined, ...withMotion(m) });
    const out = await t.checkMotions(rec.id);
    expect(out).toMatchObject({ checked: 2, skipped: 0, unavailable: 0 });
    const after = (await t.get(rec.id))!;
    expect(after.rev).toBe(rec.rev);
    expect(after.shots.map(s => s.motion?.status)).toEqual(['fail', 'warn']);
    expect(after.shots.every(s => !s.needsReview)).toBe(true);            // a finished project is not suddenly gated
    expect(after.status).toBe(rec.status);
    expect((await videoJobs(plain))).toHaveLength(2);
  });

  it('is idempotent: a second run checks nothing and writes nothing', async () => {
    const m = motionStub();
    const t = serviceSetup({ motion: m.deps });
    const rec = await legacy(t);               // collect already stored the verdicts
    expect(m.calls).toHaveLength(2);
    const before = readFileSync(join(t.dataDir, 'stories', rec.id, 'story.json'), 'utf8');
    const out = await t.service.checkMotions(rec.id);
    expect(out).toMatchObject({ checked: 0, skipped: 2 });
    expect(m.calls).toHaveLength(2);
    expect(readFileSync(join(t.dataDir, 'stories', rec.id, 'story.json'), 'utf8')).toBe(before);
  });

  it('two requests at once share one run (one check per clip)', async () => {
    const plain = serviceSetup();
    const rec = await legacy(plain);
    const m = motionStub();
    const t = new StoryService({ dataDir: plain.dataDir, flow: plain.flow, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined, ...withMotion(m) });
    const [a, b] = await Promise.all([t.checkMotions(rec.id), t.checkMotions(rec.id)]);
    expect(m.calls).toHaveLength(2);
    expect(a).toEqual(b);
  });

  it('does not hold the story lock while it checks (the page keeps working)', async () => {
    const plain = serviceSetup();
    const rec = await legacy(plain);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let started!: () => void;
    const running = new Promise<void>(r => { started = r; });
    const t = new StoryService({ dataDir: plain.dataDir, flow: plain.flow, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined,
      motion: { check: async () => { started(); await gate; return verdict('ok'); } } });
    const run = t.checkMotions(rec.id);
    await running;
    await t.approveShot(rec.id, '01-laras', { by: 'u' });         // takes the story lock: must not wait for the check
    release();
    await run;
    expect((await t.get(rec.id))!.shots[0]!.approvedBy).toBe('u');       // the approval was not lost to the backfill's write
    expect((await t.get(rec.id))!.shots[0]!.motion?.status).toBe('ok');
  });

  it('a verdict is only stored for the take it was made for: a clip replaced during the check gets none', async () => {
    const plain = serviceSetup();
    const rec = await legacy(plain);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let started!: () => void;
    const running = new Promise<void>(r => { started = r; });
    const t = new StoryService({ dataDir: plain.dataDir, flow: plain.flow, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined,
      motion: { check: async () => { started(); await gate; return verdict('fail'); } } });
    const run = t.checkMotions(rec.id);
    await running;
    const board = await t.readStoryboard(rec.id);
    board.shots[1] = { ...board.shots[1]!, intent: { ...board.shots[1]!.intent!, action: 'lifts the woven basket while a gull crosses the sky' } };
    await t.updateStoryboard(rec.id, board);                      // shot 02 becomes a pending slot while its old clip is being checked
    release();
    await run;
    const after = (await t.get(rec.id))!.shots;
    expect(after[1]!.status).toBe('pending');
    expect(after[1]!.motion).toBeUndefined();
    expect(after[1]!.needsReview).toBeUndefined();
  });

  it('a clip whose check is unavailable is counted, left without a verdict and retried next time', async () => {
    const plain = serviceSetup();
    const rec = await legacy(plain);
    const m = motionStub({ '01-laras': 'none' });
    const t = new StoryService({ dataDir: plain.dataDir, flow: plain.flow, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async () => undefined, ...withMotion(m) });
    expect(await t.checkMotions(rec.id)).toMatchObject({ checked: 1, unavailable: 1 });
    expect((await t.get(rec.id))!.shots[0]!.motion).toBeUndefined();
    expect(await t.checkMotions(rec.id)).toMatchObject({ checked: 0, unavailable: 1, skipped: 1 });
  });

  it('skips shots that are not done and clips whose file is gone; unknown story is NOT_FOUND', async () => {
    const m = motionStub();
    const t = serviceSetup({ motion: m.deps });
    const story = await t.service.create(cepat());       // nothing rendered
    expect(await t.service.checkMotions(story.id)).toMatchObject({ checked: 0 });
    await expect(t.service.checkMotions('story_0000000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(m.calls).toHaveLength(0);
  });

  it('without a motion dependency it says so instead of pretending', async () => {
    const t = serviceSetup();
    const rec = await legacy(t);
    await expect(t.service.checkMotions(rec.id)).rejects.toMatchObject({ code: 'INVALID' });
  });
});


const python = process.env.STORY_PYTHON ?? 'python3';
const hasTools = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync(python, ['-c', 'import numpy']).status === 0;

describe.skipIf(!hasTools)('the whole chain with real clips: collect → clipqc.py (real python, real ffmpeg) → verdict → gate', () => {
  it('a clip that cross-dissolves into another picture is flagged and blocks the cut; nothing is queued; a human can sign it off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nc-motion-e2e-'));
    const size = 'mandelbrot=s=180x320:r=24';
    const dissolve = join(dir, 'dissolve.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', size, '-f', 'lavfi', '-i', 'life=s=180x320:r=24:mold=10:life_color=#00ff00:death_color=#aa0000:ratio=0.2',
      '-filter_complex', '[0:v]trim=duration=5,setpts=PTS-STARTPTS[a];[1:v]trim=duration=5,setpts=PTS-STARTPTS[b];[a][b]xfade=transition=fade:duration=0.8:offset=2.5,format=yuv420p[v]',
      '-map', '[v]', '-t', '6', '-c:v', 'libx264', dissolve]);
    const steady = join(dir, 'steady.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=180x320:r=24:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', steady]);

    const t = serviceSetup({ motion: createMotionQc({ python }) });
    const story = await t.service.create(cepat());
    await t.service.render(story.id, { force: true });
    const clips = join(t.dataDir, 'flow', 'clips');
    mkdirSync(clips, { recursive: true });
    const jobs = (await t.flow.listJobs()).filter(j => j.kind === 'video' && j.status === 'queued');
    for (const job of jobs) {
      const file = join(clips, `${job.id}.mp4`);
      copyFileSync(job.technique?.endsWith('01-laras') ? dissolve : steady, file);
      await t.flow.completeJob(job.id, { filePath: file, bytes: 20_000, result: { mediaId: `m-${job.id}` } });
    }
    await t.service.reconcile(story.id);
    const after = await states(t, story.id);
    expect(after['01-laras']!.status).toBe('done');
    expect(after['01-laras']!.motion).toMatchObject({ status: 'fail' });
    expect(after['01-laras']!.motion!.reasons.join(' ')).toMatch(/berganti\/melebur sendiri di detik 2\.[6-9]/);
    expect(after['01-laras']!.needsReview).toBe(true);
    expect(after['02-kapas']!.motion?.status).toBeDefined();
    expect(after['02-kapas']!.motion!.status).not.toBe('fail');
    await expect(t.service.assemble(story.id)).rejects.toThrow(/01-laras/);
    expect(await videoJobs(t)).toHaveLength(2);                         // still the two first takes: no automatic re-render
    await t.service.approveShot(story.id, '01-laras', { by: 'u_admin' });
    await t.service.assemble(story.id);
    expect((await t.service.get(story.id))!.status).toBe('done');
  }, 60_000);   // two ffmpeg encodes + two python analyses: ~2 s alone, slower on a busy machine
});
