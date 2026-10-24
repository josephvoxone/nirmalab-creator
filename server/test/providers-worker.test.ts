import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlowStore } from '../src/flow/store.js';
import { OpenRouterConfigStore } from '../src/providers/config.js';
import { OpenRouterWorker } from '../src/providers/worker.js';

const KEY = 'sk-or-v1-worker-0123456789abcdef5678';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4000, 9)]);
const MP4 = Buffer.alloc(6000, 5);

type Call = { method: string; url: string; auth: string | null; body?: Record<string, unknown> };
type Handler = (call: Call) => Response | Promise<Response>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const VIDEO_MODELS = { data: [{
  id: 'google/veo-3.1-fast', name: 'Veo 3.1 Fast', supported_aspect_ratios: ['16:9', '9:16'], supported_durations: [5, 8, 10],
  supported_resolutions: ['480p', '720p'], supported_frame_images: ['first_frame'], generate_audio: true,
  pricing_skus: { duration_seconds_with_audio_720p: '0.10' }
}, {
  id: 'runway/gen-4.5', name: 'Runway', supported_aspect_ratios: ['9:16'], supported_durations: [10], supported_resolutions: ['1080p'],
  supported_frame_images: null, generate_audio: false, pricing_skus: { cents_per_second_output: '12' }
}] };
const IMAGE_MODELS = { data: [
  { id: 'google/gemini-2.5-flash-image', name: 'Nano Banana', supported_parameters: { aspect_ratio: { values: ['9:16'] }, input_references: { max: 3 } } },
  { id: 'meta/muse-image', name: 'Muse', supported_parameters: {} }
] };

async function setup(routes: Handler, opts: { key?: boolean; sleep?: (ms: number) => Promise<void> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-worker-'));
  const store = new FlowStore(join(dataDir, 'flow'));
  if (opts.key !== false) await new OpenRouterConfigStore(dataDir).update({ apiKey: KEY });
  const calls: Call[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      method: init?.method ?? 'GET', url, auth: new Headers(init?.headers).get('authorization'),
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as Record<string, unknown> } : {})
    };
    if (url.endsWith('/videos/models')) return json(VIDEO_MODELS);
    if (url.endsWith('/images/models')) return json(IMAGE_MODELS);
    calls.push(call);
    return routes(call);
  }) as unknown as typeof fetch;
  let clock = 1_000_000;
  const worker = new OpenRouterWorker({
    dataDir, store, fetch: fetchImpl,
    sleep: opts.sleep ?? (async ms => { clock += ms; }),
    now: () => clock
  });
  return { dataDir, store, calls, worker };
}

const writeImage = (dataDir: string, name: string) => {
  const dir = join(dataDir, 'stories', 'story_0123456789abcdef');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, PNG);
  return file;
};
const dataUrl = `data:image/png;base64,${PNG.toString('base64')}`;

describe('OpenRouterWorker', () => {
  it('does nothing without a key', async () => {
    const t = await setup(() => json({}), { key: false });
    const job = await t.store.createJob({ prompt: 'p', kind: 'image', provider: 'openrouter', model: 'google/gemini-2.5-flash-image' });
    await t.worker.tick();
    await t.worker.idle();
    expect(t.calls).toHaveLength(0);
    expect((await t.store.getJob(job.id))?.status).toBe('queued');
  });

  it('image: POST /images with the cast sheets as input_references, writes the PNG, completes with costUsd', async () => {
    const t = await setup(call => {
      expect(call).toMatchObject({ method: 'POST', url: 'https://openrouter.ai/api/v1/images', auth: `Bearer ${KEY}` });
      return json({ data: [{ b64_json: PNG.toString('base64'), media_type: 'image/png' }], usage: { cost: 0.039 } });
    });
    const sheet = writeImage(t.dataDir, 'cast-RABBIT.png');
    const job = await t.store.createJob({ prompt: 'Keyframe of Rabbit', kind: 'image', aspect: '9:16', provider: 'openrouter', model: 'google/gemini-2.5-flash-image', references: [sheet] });
    await t.worker.tick();
    await t.worker.idle();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.body).toEqual({
      model: 'google/gemini-2.5-flash-image', prompt: 'Keyframe of Rabbit', aspect_ratio: '9:16', n: 1,
      input_references: [{ type: 'image_url', image_url: { url: dataUrl } }]
    });
    const done = await t.store.getJob(job.id);
    expect(done).toMatchObject({ status: 'done', provider: 'openrouter', result: { costUsd: 0.039 } });
    expect(done?.resultPath).toBe(join(t.dataDir, 'flow', 'clips', `${job.id}.png`));
    expect(readFileSync(done!.resultPath!).equals(PNG)).toBe(true);
  });

  it('image: leaves input_references out when the model does not accept them', async () => {
    const t = await setup(() => json({ data: [{ b64_json: PNG.toString('base64') }] }));
    const sheet = writeImage(t.dataDir, 'cast-RABBIT.png');
    await t.store.createJob({ prompt: 'p', kind: 'character', aspect: '16:9', provider: 'openrouter', model: 'meta/muse-image', references: [sheet] });
    await t.worker.tick();
    await t.worker.idle();
    expect(t.calls[0]!.body).toEqual({ model: 'meta/muse-image', prompt: 'p', aspect_ratio: '16:9', n: 1 });
  });

  it('video: submits first_frame + closest duration + 720p + audio, polls until completed, downloads the clip', async () => {
    const statuses = ['pending', 'in_progress', 'completed'];
    const t = await setup(call => {
      if (call.method === 'POST' && call.url === 'https://openrouter.ai/api/v1/videos') return json({ id: 'gen-abc', polling_url: 'https://openrouter.ai/api/v1/videos/gen-abc', status: 'pending' }, 202);
      if (call.url === 'https://openrouter.ai/api/v1/videos/gen-abc') {
        const status = statuses.shift()!;
        return json({ id: 'gen-abc', status, ...(status === 'completed' ? { usage: { cost: 0.5 } } : {}) });
      }
      if (call.url === 'https://openrouter.ai/api/v1/videos/gen-abc/content?index=0') return new Response(MP4, { status: 200, headers: { 'content-type': 'video/mp4' } });
      return json({ error: { message: `unexpected ${call.url}` } }, 404);
    });
    const frame = writeImage(t.dataDir, 'frame-01-a.png');
    const job = await t.store.createJob({ prompt: 'Rabbit runs', kind: 'video', aspect: '9:16', durationSec: 6, provider: 'openrouter', model: 'google/veo-3.1-fast', startImage: frame });
    await t.worker.tick();
    await t.worker.idle();
    expect(t.calls[0]!.body).toEqual({
      model: 'google/veo-3.1-fast', prompt: 'Rabbit runs', aspect_ratio: '9:16', duration: 5, resolution: '720p', generate_audio: true,
      frame_images: [{ type: 'image_url', image_url: { url: dataUrl }, frame_type: 'first_frame' }]
    });
    expect(t.calls.filter(c => c.url.endsWith('/videos/gen-abc'))).toHaveLength(3);
    expect(t.calls.every(c => c.auth === `Bearer ${KEY}`)).toBe(true);
    const done = await t.store.getJob(job.id);
    expect(done).toMatchObject({ status: 'done', provider: 'openrouter', remoteId: 'gen-abc', result: { costUsd: 0.5 } });
    expect(done?.resultPath).toBe(join(t.dataDir, 'flow', 'clips', `${job.id}.mp4`));
    expect(readFileSync(done!.resultPath!).equals(MP4)).toBe(true);
  });

  it('video: no frame_images / resolution / generate_audio when the model lacks them', async () => {
    const t = await setup(call => (call.method === 'POST'
      ? json({ id: 'gen-r', status: 'pending' })
      : call.url.includes('/content') ? new Response(MP4) : json({ id: 'gen-r', status: 'completed' })));
    const frame = writeImage(t.dataDir, 'frame-01-a.png');
    await t.store.createJob({ prompt: 'p', kind: 'video', aspect: '9:16', provider: 'openrouter', model: 'runway/gen-4.5', startImage: frame });
    await t.worker.tick();
    await t.worker.idle();
    expect(t.calls[0]!.body).toEqual({ model: 'runway/gen-4.5', prompt: 'p', aspect_ratio: '9:16', duration: 10 });
  });

  it.each([
    [401, 'API key OpenRouter ditolak'],
    [402, 'Saldo OpenRouter habis']
  ])('HTTP %i fails the job at once with "%s"', async (status, message) => {
    const t = await setup(() => json({ error: { message: 'nope' } }, status));
    const job = await t.store.createJob({ prompt: 'p', kind: 'image', provider: 'openrouter', model: 'google/gemini-2.5-flash-image' });
    await t.worker.tick();
    await t.worker.idle();
    expect(await t.store.getJob(job.id)).toMatchObject({ status: 'failed', error: message });
    expect(t.calls).toHaveLength(1);
  });

  it('a failed generation fails the job with the reason', async () => {
    const t = await setup(call => (call.method === 'POST' ? json({ id: 'gen-x', status: 'pending' }) : json({ id: 'gen-x', status: 'failed', error: 'content policy' })));
    const job = await t.store.createJob({ prompt: 'p', kind: 'video', provider: 'openrouter', model: 'google/veo-3.1-fast' });
    await t.worker.tick();
    await t.worker.idle();
    const failed = await t.store.getJob(job.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe('Video OpenRouter gagal (failed): content policy');
  });

  it('gives up polling after 15 minutes', async () => {
    const t = await setup(call => (call.method === 'POST' ? json({ id: 'gen-slow', status: 'pending' }) : json({ id: 'gen-slow', status: 'in_progress' })));
    const job = await t.store.createJob({ prompt: 'p', kind: 'video', provider: 'openrouter', model: 'google/veo-3.1-fast' });
    await t.worker.tick();
    await t.worker.idle();
    expect(await t.store.getJob(job.id)).toMatchObject({ status: 'failed', error: 'Video OpenRouter tidak selesai dalam 15 menit' });
    // every 10 s for 15 min
    expect(t.calls.filter(c => c.method === 'GET').length).toBe(90);
  });

  it('runs at most 2 jobs at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const t = await setup(call => (call.method === 'POST' ? json({ id: `gen-${Math.random()}`, status: 'pending' }) : call.url.includes('/content') ? new Response(MP4) : json({ status: 'completed' })),
      { sleep: () => gate });
    for (let i = 0; i < 3; i += 1) await t.store.createJob({ prompt: `p${i}`, kind: 'video', provider: 'openrouter', model: 'google/veo-3.1-fast' });
    await t.worker.tick();
    await new Promise(r => setTimeout(r, 50));
    await t.worker.tick();
    await new Promise(r => setTimeout(r, 50));
    const jobs = await t.store.listJobs();
    expect(jobs.filter(j => j.status === 'running')).toHaveLength(2);
    expect(jobs.filter(j => j.status === 'queued')).toHaveLength(1);
    release();
    await t.worker.idle();
    await t.worker.tick();
    await t.worker.idle();
    expect((await t.store.listJobs()).every(j => j.status === 'done')).toBe(true);
  });

  it('resumes a submitted video after a restart instead of paying for it twice', async () => {
    const t = await setup(call => (call.url.includes('/content') ? new Response(MP4) : json({ id: 'gen-old', status: 'completed' })));
    const job = await t.store.createJob({ prompt: 'p', kind: 'video', provider: 'openrouter', model: 'google/veo-3.1-fast' });
    await t.store.claimJob('openrouter', { provider: 'openrouter' });
    await t.store.setRemoteId(job.id, 'gen-old');
    await t.worker.tick();
    await t.worker.idle();
    expect(t.calls.some(c => c.method === 'POST')).toBe(false);
    expect((await t.store.getJob(job.id))?.status).toBe('done');
    expect(existsSync(join(t.dataDir, 'flow', 'clips', `${job.id}.mp4`))).toBe(true);
  });
});
