import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlowStore } from '../src/flow/store.js';
import { StoryService, type StoryDeps } from '../src/stories/service.js';
import { validateStoryboard, type Storyboard } from '../src/stories/storyboard.js';

const board: Storyboard = {
  title: 'Selendang Merah',
  characters: { RABBIT: 'a cream rabbit with a red knitted scarf' },
  audio: 'Audio: voice-over: "{line}"',
  shots: [
    { id: '01-a', prompt: 'Medium shot, RABBIT on a porch.', narration: 'Namanya Kapas.' },
    { id: '02-b', prompt: 'Wide shot, RABBIT in the rain.', narration: 'Ia menunggu dalam hujan.' }
  ]
};
const OR_VIDEO = { provider: 'openrouter' as const, model: 'google/veo-3.1-fast' };
const OR_IMAGE = { provider: 'openrouter' as const, model: 'google/gemini-2.5-flash-image' };

describe('Storyboard.engine validation', () => {
  it('accepts no engine, flow engines and openrouter engines with a model', () => {
    expect(validateStoryboard(board)).toEqual([]);
    expect(validateStoryboard({ ...board, engine: { image: { provider: 'flow' }, video: { provider: 'flow' } } })).toEqual([]);
    expect(validateStoryboard({ ...board, engine: { image: OR_IMAGE, video: OR_VIDEO } })).toEqual([]);
  });

  it('rejects unknown providers, missing/bad models and non-object engines', () => {
    const errors = (engine: unknown) => validateStoryboard({ ...board, engine } as unknown as Storyboard);
    expect(errors('openrouter').join()).toMatch(/engine/);
    expect(errors({ video: { provider: 'sora' } }).join()).toMatch(/engine\.video/);
    expect(errors({ video: { provider: 'openrouter' } }).join()).toMatch(/engine\.video.*model/);
    expect(errors({ image: { provider: 'openrouter', model: 'not a model' } }).join()).toMatch(/engine\.image.*model/);
  });
});

const AX_VIDEO = { provider: 'axcel' as const, model: 'Seedance 2.0' };

describe('stories with an Axcel engine', () => {
  it('validation: axcel with a known model, for clips and stills; an unknown model is refused', () => {
    expect(validateStoryboard({ ...board, engine: { video: AX_VIDEO, image: { provider: 'axcel', model: 'Nano Banana Pro' } } } as Storyboard)).toEqual([]);
    expect(validateStoryboard({ ...board, engine: { video: { provider: 'axcel', model: 'Sora 9' } } } as unknown as Storyboard).join()).toMatch(/engine\.video.*Seedance 2\.0/);
    expect(validateStoryboard({ ...board, engine: { video: { provider: 'axcel' } } } as unknown as Storyboard).join()).toMatch(/engine\.video/);
  });

  it('render: clips go to the Axcel worker with the model, at 720p and a length the model supports', async () => {
    const t = setup();
    const story = await t.service.create({ ...board, mode: 'cepat', engine: { video: AX_VIDEO } });
    await t.service.render(story.id);
    const jobs = await t.flow.listJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs.every(j => j.provider === 'axcel' && j.model === 'Seedance 2.0' && j.durationSec === 5 && j.resolution === 720)).toBe(true);
    // The Flow bridge never sees them.
    expect(await t.flow.claimJob('mac')).toBeUndefined();

    const veo = await t.service.create({ ...board, mode: 'cepat', engine: { video: { provider: 'axcel', model: 'Veo 3.1 Fast' } } });
    await t.service.render(veo.id);
    expect((await t.flow.listJobs()).filter(j => j.technique?.includes(veo.id)).every(j => j.durationSec === 8)).toBe(true);
  });

  it('an Axcel video engine skips the Flow credit check (the plan pays, no Flow credits are spent)', async () => {
    const t = setup();
    const acc = await t.flow.addAccount({ label: 'A', email: 'a@b.c' });
    await t.flow.heartbeat('mac', [{ id: acc.id, credits: 0 }]);
    const story = await t.service.create({ ...board, mode: 'cepat', engine: { video: AX_VIDEO } });
    const record = await t.service.render(story.id);
    expect(await t.flow.listJobs()).toHaveLength(2);
    expect(record.events.at(-1)?.message).toBe('2 shot masuk antrean Axcel (Seedance 2.0)');
  });

  it('konsisten + axcel video engine: the approved keyframe file is the start frame', async () => {
    const t = setup();
    const story = await t.service.create({ ...board, mode: 'konsisten', engine: { video: AX_VIDEO } });
    const finish = async (kind: 'character' | 'image') => {
      const clips = join(t.dataDir, 'flow', 'clips');
      mkdirSync(clips, { recursive: true });
      for (const job of (await t.flow.listJobs()).filter(j => j.kind === kind && j.status === 'queued')) {
        const file = join(clips, `${job.id}.png`);
        writeFileSync(file, Buffer.alloc(20_000, 2));
        await t.flow.completeJob(job.id, { filePath: file, result: { mediaId: `m-${job.id}`, caption: 'c' } });
      }
    };
    await t.service.prepare(story.id);
    await finish('character');
    await t.service.reconcile(story.id);
    await finish('image');
    await t.service.reconcile(story.id);
    await t.service.render(story.id);
    const clips = (await t.flow.listJobs()).filter(j => j.kind === 'video');
    expect(clips.every(j => j.provider === 'axcel')).toBe(true);
    expect(clips.map(j => j.startImage).sort()).toEqual(['01-a', '02-b'].map(id => t.service.framePath(story.id, id)).sort());
    expect(clips.every(j => j.startFrame === undefined)).toBe(true);
  });

  it('konsisten + axcel image engine: sheets and keyframes go to Axcel with the cast sheets as references', async () => {
    const t = setup();
    const story = await t.service.create({ ...board, mode: 'konsisten', engine: { image: { provider: 'axcel', model: 'Nano Banana Pro' } } } as Storyboard);
    await t.service.prepare(story.id);
    const [sheet] = await t.flow.listJobs();
    expect(sheet).toMatchObject({ kind: 'character', provider: 'axcel', model: 'Nano Banana Pro' });
    const clips = join(t.dataDir, 'flow', 'clips');
    mkdirSync(clips, { recursive: true });
    writeFileSync(join(clips, `${sheet!.id}.png`), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20_000, 1)]));
    await t.flow.completeJob(sheet!.id, { filePath: join(clips, `${sheet!.id}.png`), provider: 'axcel' });
    await t.service.reconcile(story.id);
    const frames = (await t.flow.listJobs()).filter(j => j.kind === 'image');
    expect(frames).toHaveLength(2);
    expect(frames.every(j => j.provider === 'axcel' && j.model === 'Nano Banana Pro')).toBe(true);
    expect(frames[0]!.references).toEqual([t.service.castPath(story.id, 'RABBIT')]);
  });
});

describe('audio: narration or ambient only', () => {
  it('audio "ambient": every shot is silent (no voice), narration is optional, and the clip prompt changes but no keyframe does', async () => {
    const { shotPromptFor, hashFor, frameHashFor } = await import('../src/stories/storyboard.js');
    const voiced = { ...board, audioSilent: 'Audio: ambient sound only, no voice, no music.' };
    const ambient = { ...voiced, audioMode: 'ambient' as const };
    for (const shot of board.shots) {
      expect(shotPromptFor(voiced, shot)).toContain('voice-over');
      expect(shotPromptFor(ambient, shot)).not.toContain('voice-over');
      expect(shotPromptFor(ambient, shot)).toContain('ambient sound only');
      expect(hashFor(ambient, shot)).not.toBe(hashFor(voiced, shot));
      expect(frameHashFor(ambient, shot)).toBe(frameHashFor(voiced, shot));
    }
    const unspoken = { ...ambient, shots: board.shots.map(s => ({ ...s, narration: '' })) };
    expect(validateStoryboard(unspoken)).toEqual([]);
    expect(validateStoryboard({ ...unspoken, audioMode: undefined }).join()).toMatch(/narration is empty/);
    expect(validateStoryboard({ ...board, audioMode: 'loud' } as unknown as Storyboard).join()).toMatch(/audioMode/);
  });

  it('QC: a clip with no audio track passes in an ambient story, and is rejected in a narrated one', async () => {
    const run = async (audioMode?: 'ambient') => {
      const dataDir = mkdtempSync(join(tmpdir(), 'nc-pstories-'));
      const flow = new FlowStore(join(dataDir, 'flow'));
      const service = new StoryService({ dataDir, flow, probe: async () => ({ durationSec: 5, hasAudio: false }), assemble: async () => undefined });
      const story = await service.create({ ...board, mode: 'cepat', ...(audioMode ? { audioMode } : {}) });
      await service.render(story.id);
      const clips = join(dataDir, 'flow', 'clips');
      mkdirSync(clips, { recursive: true });
      for (const job of await flow.listJobs()) {
        const file = join(clips, `${job.id}.mp4`);
        writeFileSync(file, Buffer.alloc(8192, 1));
        await flow.completeJob(job.id, { filePath: file });
      }
      return (await service.reconcile(story.id))!.shots.map(s => s.status);
    };
    expect(await run('ambient')).toEqual(['done', 'done']);
    expect(await run()).not.toContain('done');
  });
});

function setup(openRouter?: StoryDeps['openRouter']) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-pstories-'));
  const flow = new FlowStore(join(dataDir, 'flow'));
  const service = new StoryService({
    dataDir, flow,
    probe: async () => ({ durationSec: 6, hasAudio: true }),
    assemble: async dir => writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(4096, 1)),
    ...(openRouter ? { openRouter } : {})
  });
  return { dataDir, flow, service };
}

const pricing = (usdPerClip: number | null, remainingUsd: number | null): StoryDeps['openRouter'] => ({
  usdPerClip: async () => usdPerClip,
  balance: async () => (remainingUsd === null ? null : { usedUsd: 1, limitUsd: 10, remainingUsd })
});

describe('stories with an OpenRouter engine', () => {
  it('engine absent: render queues flow jobs exactly as before', async () => {
    const t = setup(pricing(0.6, 0));
    const story = await t.service.create(board);
    await t.service.render(story.id);
    const jobs = await t.flow.listJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs.every(j => j.provider === undefined && j.model === undefined)).toBe(true);
  });

  it('engine.video openrouter: clips are queued for the OpenRouter worker with the model', async () => {
    const t = setup(pricing(0.6, 5));
    const story = await t.service.create({ ...board, mode: 'cepat', engine: { video: OR_VIDEO } });
    await t.service.render(story.id);
    const jobs = await t.flow.listJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs.every(j => j.kind === 'video' && j.provider === 'openrouter' && j.model === 'google/veo-3.1-fast')).toBe(true);
    expect(await t.flow.claimJob('mac')).toBeUndefined();
  });

  it('budget: 2 clips × $0,60 against a $1,00 balance → BUDGET with the USD message; force overrides', async () => {
    const t = setup(pricing(0.6, 1));
    const story = await t.service.create({ ...board, mode: 'cepat', engine: { video: OR_VIDEO } });
    await expect(t.service.render(story.id)).rejects.toMatchObject({ code: 'BUDGET', message: 'Butuh ±$1,20, saldo OpenRouter $1,00' });
    expect(await t.flow.listJobs()).toHaveLength(0);
    await t.service.render(story.id, { force: true });
    expect(await t.flow.listJobs()).toHaveLength(2);
  });

  it('budget: enough balance, unknown price or unknown balance → renders', async () => {
    for (const deps of [pricing(0.6, 1.2), pricing(null, 0), pricing(0.6, null)]) {
      const t = setup(deps);
      const story = await t.service.create({ ...board, mode: 'cepat', engine: { video: OR_VIDEO } });
      await t.service.render(story.id);
      expect(await t.flow.listJobs()).toHaveLength(2);
    }
  });

  it('an OpenRouter video engine skips the Flow credit check (no Flow credits are spent)', async () => {
    const t = setup(pricing(0.6, 5));
    const acc = await t.flow.addAccount({ label: 'A', email: 'a@b.c' });
    await t.flow.heartbeat('mac', [{ id: acc.id, credits: 0 }]);
    const story = await t.service.create({ ...board, mode: 'cepat', engine: { video: OR_VIDEO } });
    await t.service.render(story.id);
    expect(await t.flow.listJobs()).toHaveLength(2);
  });

  it('konsisten + openrouter image engine: sheets and keyframes go to OpenRouter, keyframes carry the cast sheets', async () => {
    const t = setup(pricing(0.6, 5));
    const story = await t.service.create({ ...board, mode: 'konsisten', engine: { image: OR_IMAGE, video: OR_VIDEO } });
    await t.service.prepare(story.id);
    const [sheet] = await t.flow.listJobs();
    expect(sheet).toMatchObject({ kind: 'character', provider: 'openrouter', model: 'google/gemini-2.5-flash-image' });

    // the worker finishes the sheet
    const clips = join(t.dataDir, 'flow', 'clips');
    mkdirSync(clips, { recursive: true });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20_000, 1)]);
    writeFileSync(join(clips, `${sheet!.id}.png`), png);
    await t.flow.completeJob(sheet!.id, { filePath: join(clips, `${sheet!.id}.png`), provider: 'openrouter' });
    await t.service.reconcile(story.id);

    const frames = (await t.flow.listJobs()).filter(j => j.kind === 'image');
    expect(frames).toHaveLength(2);
    expect(frames.every(j => j.provider === 'openrouter' && j.model === 'google/gemini-2.5-flash-image')).toBe(true);
    expect(frames[0]!.references).toEqual([t.service.castPath(story.id, 'RABBIT')]);
  });

  it('konsisten + openrouter video engine: the approved keyframe file is the first frame', async () => {
    const t = setup(pricing(0.6, 5));
    const story = await t.service.create({ ...board, mode: 'konsisten', engine: { video: OR_VIDEO } });
    // flow image engine (default): finish sheet + frames the way the bridge does
    const finish = async (kind: 'character' | 'image') => {
      const clips = join(t.dataDir, 'flow', 'clips');
      mkdirSync(clips, { recursive: true });
      for (const job of (await t.flow.listJobs()).filter(j => j.kind === kind && j.status === 'queued')) {
        expect(job.provider).toBeUndefined();
        const file = join(clips, `${job.id}.png`);
        writeFileSync(file, Buffer.alloc(20_000, 2));
        await t.flow.completeJob(job.id, { filePath: file, result: { mediaId: `m-${job.id}`, caption: 'c' } });
      }
    };
    await t.service.prepare(story.id);
    await finish('character');
    await t.service.reconcile(story.id);
    await finish('image');
    await t.service.reconcile(story.id);
    await t.service.render(story.id);
    const clips = (await t.flow.listJobs()).filter(j => j.kind === 'video');
    expect(clips).toHaveLength(2);
    expect(clips.every(j => j.provider === 'openrouter')).toBe(true);
    expect(clips.map(j => j.startImage).sort()).toEqual(['01-a', '02-b'].map(id => t.service.framePath(story.id, id)).sort());
    expect(clips.every(j => j.startFrame === undefined)).toBe(true);
  });
});
