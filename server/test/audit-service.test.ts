import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditParseError, type AuditExpectation, type AuditResult } from '../src/audit/vision.js';
import { FlowStore, type FlowJob } from '../src/flow/store.js';
import { StoryService, type StoryDeps } from '../src/stories/service.js';
import { type Storyboard } from '../src/stories/storyboard.js';

const konsisten: Storyboard = {
  title: 'Selendang Merah',
  mode: 'konsisten',
  style: 'Style: storybook watercolor.',
  characters: { LARAS: 'a seven-year-old girl with two black braids and a mustard dress', KAPAS: { name: 'Kapas', look: 'a cream rabbit with a red knitted scarf' } },
  audio: 'Audio: voice-over: "{line}"',
  audioSilent: 'Audio: wind.',
  shots: [
    { id: '00-intro', silent: true, prompt: 'Extreme wide shot, the camera pushes in slowly. A misty valley at sunrise.' },
    { id: '01-hadiah', prompt: 'Medium shot, the camera stays still. LARAS holds KAPAS on a porch.', narration: 'Namanya Kapas.' }
  ]
};

/** One shot with cast: the audit tests need a single take so the score queue is unambiguous. */
const satu: Storyboard = { ...konsisten, shots: [konsisten.shots[1]!] };

const cepat: Storyboard = { ...konsisten, mode: 'cepat', shots: [{ id: '01-hadiah', prompt: 'Medium shot, the camera stays still. LARAS holds KAPAS on a porch.', narration: 'Namanya Kapas.' }] };

type AuditInput = { images: string[]; expectation: AuditExpectation; model: string };

const GATE_REPAIR = 'The wooden gate is missing: add a weathered wooden gate across the lower third.';

function auditStub(scores: number[]) {
  const calls: AuditInput[] = [];
  const deps = {
    model: async () => 'google/gemini-2.5-flash',
    run: async (input: AuditInput): Promise<AuditResult> => {
      calls.push(input);
      const score = scores.shift() ?? 90;
      const low = score < 70;
      return {
        score,
        dimensions: { sceneMatch: score, actionMatch: score, moodMatch: score, composition: score },
        issues: low ? ['the wooden gate is missing'] : [],
        reasoning: 'satu kalimat',
        repair: low ? GATE_REPAIR : '',
        costUsd: 0.0012
      };
    },
    frames: async (_clip: string, dir: string, shotId: string) => {
      const files = [1, 2, 3].map(i => join(dir, `audit-${shotId}-${i}.png`));
      for (const file of files) writeFileSync(file, Buffer.alloc(2048, 5));
      return files;
    }
  };
  return { deps, calls };
}

type SetupOptions = { audit?: StoryDeps['audit']; fakeAudit?: ReturnType<typeof auditStub> };

function setup(options: SetupOptions = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-audit-svc-'));
  const flow = new FlowStore(join(dataDir, 'flow'));
  const service = new StoryService({
    dataDir, flow,
    probe: async () => ({ durationSec: 6, hasAudio: true }),
    imageSize: async () => ({ width: 768, height: 1376 }),
    assemble: async dir => writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(4096, 1)),
    ...(options.audit ? { audit: options.audit } : {})
  });
  return { dataDir, flow, service };
}

async function finish(t: { dataDir: string; flow: FlowStore }, kind: FlowJob['kind'], meta: (j: FlowJob) => Record<string, string> = j => ({ mediaId: `m-${j.id}`, caption: `cap ${j.id}` })) {
  const dir = join(t.dataDir, 'flow', 'clips');
  mkdirSync(dir, { recursive: true });
  for (const job of (await t.flow.listJobs()).filter(j => j.kind === kind && j.status === 'queued')) {
    const file = join(dir, `${job.id}.${kind === 'video' ? 'mp4' : 'png'}`);
    writeFileSync(file, Buffer.alloc(20_000, 3));
    await t.flow.completeJob(job.id, { filePath: file, bytes: 20_000, result: meta(job) });
  }
}

/** prepare → sheets → keyframes, without audit interfering with the setup. */
async function framesReady(t: ReturnType<typeof setup>, board: Storyboard) {
  const story = await t.service.create(board);
  await t.service.prepare(story.id);
  await finish(t, 'character');
  await t.service.reconcile(story.id);
  await finish(t, 'image');
  await t.service.reconcile(story.id);
  return story.id;
}

const shotOf = async (t: ReturnType<typeof setup>, id: string, shotId: string) => (await t.service.get(id))!.shots.find(s => s.id === shotId)!;

describe('konsisten: the keyframe is audited before any clip is animated', () => {
  it('a passing keyframe stores score, dimensions, model, time and cost', async () => {
    const fake = auditStub([88]);
    const t = setup({ audit: fake.deps });
    const id = await framesReady(t, satu);
    const shot = await shotOf(t, id, '01-hadiah');
    expect(shot.audit).toMatchObject({ score: 88, model: 'google/gemini-2.5-flash', costUsd: 0.0012, target: 'frame' });
    expect(shot.audit!.dimensions.sceneMatch).toBe(88);
    expect(shot.audit!.atMs).toBeGreaterThan(0);
    expect(shot.needsReview).toBeUndefined();
    // the take plus the two cast sheets, never more than three images
    const call = fake.calls.find(c => c.images[0]!.endsWith('frame-01-hadiah.png'))!;
    expect(call.images.length).toBeLessThanOrEqual(3);
    expect(call.images[0]).toMatch(/frame-01-hadiah\.png$/);
    expect(call.images.slice(1).every(f => /cast-[A-Z]+\.png$/.test(f))).toBe(true);
    expect(call.expectation.action).toContain('Laras holds Kapas');
    expect(call.expectation.dialogue).toBe('Namanya Kapas.');
    expect(call.model).toBe('google/gemini-2.5-flash');
  });

  it('below the gate the frame is drawn once more with the repair in the prompt, then needs a human', async () => {
    const fake = auditStub([55, 58]);
    const t = setup({ audit: fake.deps });
    const id = await framesReady(t, satu);
    // first audit failed: one redraw queued, with the repair appended
    const afterFirst = await shotOf(t, id, '01-hadiah');
    expect(afterFirst.frame!.status).toBe('queued');
    expect(afterFirst.audit!.score).toBe(55);
    const redraw = (await t.flow.listJobs()).filter(j => j.kind === 'image' && j.technique!.endsWith('frame:01-hadiah'));
    expect(redraw.some(j => j.prompt.includes(GATE_REPAIR))).toBe(true);
    expect(redraw).toHaveLength(2);
    expect((await t.service.get(id))!.status).toBe('framing');

    await finish(t, 'image');
    await t.service.reconcile(id);
    const afterSecond = await shotOf(t, id, '01-hadiah');
    expect(afterSecond.needsReview).toBe(true);
    expect(afterSecond.audit!.score).toBe(58);
    // 2 takes total: the first keyframe and one repair, no third
    const takes = (await t.flow.listJobs()).filter(j => j.kind === 'image' && j.technique!.endsWith('frame:01-hadiah'));
    expect(takes).toHaveLength(2);
    expect((await t.service.get(id))!.status).toBe('review');
  });

  it('a repair that passes clears the flag and stops the loop', async () => {
    const fake = auditStub([55, 82]);
    const t = setup({ audit: fake.deps });
    const id = await framesReady(t, satu);
    await finish(t, 'image');
    await t.service.reconcile(id);
    const shot = await shotOf(t, id, '01-hadiah');
    expect(shot.audit!.score).toBe(82);
    expect(shot.needsReview).toBeUndefined();
    expect((await t.flow.listJobs()).filter(j => j.kind === 'image' && j.technique!.endsWith('frame:01-hadiah'))).toHaveLength(2);
  });

  it('an unreadable audit reply flags the shot instead of passing it', async () => {
    const fake = auditStub([]);
    const t = setup({ audit: { ...fake.deps, run: async () => { throw new AuditParseError('tidak ada JSON'); } } });
    const id = await framesReady(t, satu);
    const shot = await shotOf(t, id, '01-hadiah');
    expect(shot.needsReview).toBe(true);
    expect(shot.audit!.score).toBe(0);
    expect(shot.audit!.issues[0]).toMatch(/tidak bisa dibaca/i);
  });

  it('a provider failure is logged but never blocks the story', async () => {
    const fake = auditStub([]);
    const t = setup({ audit: { ...fake.deps, run: async () => { throw new Error('OpenRouter tidak bisa dihubungi'); } } });
    const id = await framesReady(t, satu);
    const rec = (await t.service.get(id))!;
    expect(rec.shots.every(s => !s.audit && !s.needsReview)).toBe(true);
    expect(rec.events.some(e => /Audit gagal/.test(e.message))).toBe(true);
    expect(rec.status).toBe('review');
  });

  it('without an audit dependency nothing is audited or flagged (inert when unconfigured)', async () => {
    const t = setup();
    const id = await framesReady(t, satu);
    const rec = (await t.service.get(id))!;
    expect(rec.shots.every(s => !s.audit && !s.needsReview)).toBe(true);
    expect(rec.gate).toBeUndefined();
  });
});

describe('cepat: three frames of the clip are audited', () => {
  async function rendered(t: ReturnType<typeof setup>, board: Storyboard = cepat) {
    const story = await t.service.create(board);
    await t.service.render(story.id);
    await finish(t, 'video');
    await t.service.reconcile(story.id);
    return story.id;
  }

  it('samples the clip and stores a clip audit with the sampled frames', async () => {
    const fake = auditStub([85]);
    const t = setup({ audit: fake.deps });
    const id = await rendered(t);
    const shot = await shotOf(t, id, '01-hadiah');
    expect(shot.audit).toMatchObject({ score: 85, target: 'clip' });
    const call = fake.calls[0]!;
    expect(call.images.filter(f => /audit-01-hadiah-\d\.png$/.test(f))).toHaveLength(3);
    expect(call.images.length).toBeLessThanOrEqual(3);
    expect((await t.service.get(id))!.status).toBe('done');
  });

  it('below the gate nothing is spent without the per-project switch: the shot needs review', async () => {
    const fake = auditStub([61]);
    const t = setup({ audit: fake.deps });
    const id = await rendered(t);
    const shot = await shotOf(t, id, '01-hadiah');
    expect(shot.needsReview).toBe(true);
    expect((await t.flow.listJobs()).filter(j => j.kind === 'video')).toHaveLength(1);
    expect((await t.service.get(id))!.status).not.toBe('done');
  });

  it('with autoRepairClip the clip is re-rendered once with the repair, then needs review', async () => {
    const fake = auditStub([61, 61]);
    const t = setup({ audit: fake.deps });
    const id = await rendered(t, { ...cepat, autoRepairClip: true });
    const queued = (await t.flow.listJobs()).filter(j => j.kind === 'video' && j.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.prompt).toContain(GATE_REPAIR);
    await finish(t, 'video');
    await t.service.reconcile(id);
    const shot = await shotOf(t, id, '01-hadiah');
    expect(shot.needsReview).toBe(true);
    expect((await t.flow.listJobs()).filter(j => j.kind === 'video')).toHaveLength(2);
  });

  it('a repair never crosses the account daily credit cap', async () => {
    const fake = auditStub([61]);
    const t = setup({ audit: fake.deps });
    const account = await t.flow.addAccount({ label: 'mac', email: 'm@x.io' });
    await t.flow.updateAccount(account.id, { dailyCreditCap: 5 });
    await t.flow.heartbeat('mac', [{ id: account.id, credits: 500 }]);
    // the cap is 5 credits; a clip repair costs 10 — it would cross the cap
    const id = await rendered(t, { ...cepat, autoRepairClip: true });
    const shot = await shotOf(t, id, '01-hadiah');
    expect(shot.needsReview).toBe(true);
    expect((await t.flow.listJobs()).filter(j => j.kind === 'video')).toHaveLength(1);
  });
});

describe('gate and human sign-off', () => {
  it('lists shots under the gate and shots flagged for review', () => {
    const t = setup();
    const blockers = t.service.gateBlockers({
      shots: [
        { id: 'a', status: 'done', attempts: 0, audit: { score: 62, dimensions: { sceneMatch: 62, actionMatch: 62, moodMatch: 62, composition: 62 }, issues: [], repair: 'x', model: 'm', atMs: 1, costUsd: 0 } },
        { id: 'b', status: 'done', attempts: 0, needsReview: true, audit: { score: 88, dimensions: { sceneMatch: 88, actionMatch: 88, moodMatch: 88, composition: 88 }, issues: [], repair: '', model: 'm', atMs: 1, costUsd: 0 } },
        { id: 'c', status: 'done', attempts: 0, audit: { score: 70, dimensions: { sceneMatch: 70, actionMatch: 70, moodMatch: 70, composition: 70 }, issues: [], repair: '', model: 'm', atMs: 1, costUsd: 0 } },
        { id: 'd', status: 'done', attempts: 0 }
      ]
    } as never);
    expect(blockers.map(b => b.id)).toEqual(['a', 'b']);
    expect(blockers[0]).toMatchObject({ score: 62, needsReview: false });
    expect(blockers[1]).toMatchObject({ needsReview: true });
  });

  it('assemble refuses with the shots named, approve clears the flag and records the approver', async () => {
    const fake = auditStub([61]);
    const t = setup({ audit: fake.deps });
    const story = await t.service.create(cepat);
    await t.service.render(story.id);
    await finish(t, 'video');
    await t.service.reconcile(story.id);
    await expect(t.service.assemble(story.id)).rejects.toMatchObject({ code: 'INVALID', message: expect.stringContaining('01-hadiah') });
    const blocked = (await t.service.get(story.id))!;
    expect(blocked.gate?.shots.map(s => s.id)).toEqual(['01-hadiah']);
    expect(blocked.gate?.message).toMatch(/perlu dicek/i);

    const approved = await t.service.approveShot(story.id, '01-hadiah', { by: 'u_admin' });
    expect(approved.shots[0]!.needsReview).toBeUndefined();
    expect(approved.shots[0]!.approvedBy).toBe('u_admin');
    expect(approved.shots[0]!.approvedAtMs).toBeGreaterThan(0);
    expect(approved.gate).toBeUndefined();
    expect((await t.service.assemble(story.id)).status).toBe('done');
  });

  it('a manual repair re-queues the clip with the repair even without the switch', async () => {
    const fake = auditStub([61, 91]);
    const t = setup({ audit: fake.deps });
    const story = await t.service.create(cepat);
    await t.service.render(story.id);
    await finish(t, 'video');
    await t.service.reconcile(story.id);
    const repaired = await t.service.repairShot(story.id, '01-hadiah', { by: 'u_admin' });
    expect(repaired.status).toBe('rendering');
    expect(repaired.shots[0]!.needsReview).toBeUndefined();
    const queued = (await t.flow.listJobs()).filter(j => j.kind === 'video' && j.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.prompt).toContain(GATE_REPAIR);
    await finish(t, 'video');
    await t.service.reconcile(story.id);
    expect((await t.service.get(story.id))!.shots[0]!.audit!.score).toBe(91);
  });

  it('a manual repair without an audit instruction is refused', async () => {
    const fake = auditStub([90]);
    const t = setup({ audit: fake.deps });
    const story = await t.service.create(cepat);
    await t.service.render(story.id);
    await finish(t, 'video');
    await t.service.reconcile(story.id);
    await expect(t.service.repairShot(story.id, '01-hadiah')).rejects.toMatchObject({ code: 'INVALID' });
    await expect(t.service.repairShot(story.id, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
