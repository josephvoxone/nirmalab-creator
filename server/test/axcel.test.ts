/**
 * Axcel engine (server half): config store, bridge client and the worker that renders
 * `provider: 'axcel'` jobs. No network: the bridge is faked with a fetch stub.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AxcelClient, AxcelConfigStore, AxcelError, AxcelWorker, AXCEL_MODELS, isAxcelModel } from '../src/providers/axcel.js';
import type { FlowJob, FlowStore } from '../src/flow/store.js';

const job = (patch: Partial<FlowJob> = {}): FlowJob => ({
  id: 'job_axcel_1',
  kind: 'video',
  prompt: 'nelayan menarik jaring saat fajar',
  aspect: '9:16',
  durationSec: 5,
  status: 'queued',
  attempts: 0,
  maxAttempts: 2,
  createdAtMs: Date.now(),
  provider: 'axcel',
  model: 'Seedance 2.0',
  ...patch
});

/** A FlowStore stand-in that records what the worker did. */
function fakeStore(jobs: FlowJob[]) {
  const state = { jobs: [...jobs], completed: [] as Array<{ id: string; filePath: string; bytes?: number; provider?: string }>, failed: [] as Array<{ id: string; error: string; final?: boolean }>, fallback: undefined as undefined | Record<string, unknown> };
  const store = {
    runningJobs: async (provider: string) => state.jobs.filter(j => j.status === 'running' && j.provider === provider),
    claimJob: async (_bridge: string, options: { provider?: string } = {}) => {
      const next = state.jobs.find(j => j.status === 'queued' && j.provider === options.provider);
      if (!next) return undefined;
      next.status = 'running';
      return next;
    },
    completeJob: async (id: string, result: { filePath: string; bytes?: number; provider?: string }) => {
      state.completed.push({ id, ...result });
      const found = state.jobs.find(j => j.id === id);
      if (found) found.status = 'done';
      return found;
    },
    createJob: async (input: { prompt: string; kind?: string; aspect?: string; durationSec?: number; provider?: string }) => {
      const created = job({ id: 'job_flow_fallback', provider: undefined, model: undefined, kind: input.kind as FlowJob['kind'] ?? 'video', prompt: input.prompt, status: 'queued' });
      state.jobs.push(created);
      state.fallback = { ...input, id: created.id };
      return created;
    },
    failJob: async (id: string, error: string, options: { final?: boolean } = {}) => {
      state.failed.push({ id, error, final: options.final });
      const found = state.jobs.find(j => j.id === id);
      if (found) found.status = options.final ? 'failed' : 'queued';
      return found;
    }
  };
  return { state, store: store as unknown as FlowStore };
}

/** Smallest PNG that sniffs as image/png (magic bytes are all sniffMediaType reads). */
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

describe('model names', () => {
  it('only accepts names Axcel itself uses', () => {
    expect(AXCEL_MODELS).toContain('Seedance 2.0');
    expect(isAxcelModel('Seedance 2.0')).toBe(true);
    expect(isAxcelModel('bytedance/seedance-2.0')).toBe(false);
    expect(isAxcelModel('')).toBe(false);
  });
});

describe('AxcelConfigStore', () => {
  it('stores url + token privately and only shows the hint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'axcel-cfg-'));
    const store = new AxcelConfigStore(dir, {});
    expect(await store.view()).toMatchObject({ configured: false, url: 'http://127.0.0.1:8899' });

    const view = await store.update({ url: 'http://127.0.0.1:9123', token: 'a'.repeat(32) });
    expect(view.configured).toBe(true);
    expect(view.tokenHint).toBe('••••aaaa');
    expect(JSON.stringify(view)).not.toContain('a'.repeat(32));

    const mode = (await stat(join(dir, 'providers', 'axcel.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(await readFile(join(dir, 'providers', 'axcel.json'), 'utf8'))).toMatchObject({ url: 'http://127.0.0.1:9123' });
  });

  it('refuses a non-loopback url and a blank token', async () => {
    const store = new AxcelConfigStore(await mkdtemp(join(tmpdir(), 'axcel-cfg-')), {});
    await expect(store.update({ url: 'https://axcel.cloud' })).rejects.toThrow(/127\.0\.0\.1/);
    await expect(store.update({ token: 'short' })).rejects.toThrow(/token/);
  });

  it('lets the env override the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'axcel-cfg-'));
    await new AxcelConfigStore(dir, {}).update({ token: 'b'.repeat(32) });
    const store = new AxcelConfigStore(dir, { AXCEL_BRIDGE_TOKEN: 'c'.repeat(40), AXCEL_BRIDGE_URL: 'http://127.0.0.1:7000' });
    expect(await store.settings()).toEqual({ url: 'http://127.0.0.1:7000', token: 'c'.repeat(40) });
  });
});

describe('AxcelClient', () => {
  it('sends the bridge token and maps the catalog', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return json({ models: [
        { model: 'Seedance 2.0', type: 'video', inputs: ['text', 'start'], durations: [5, 8], res: [480, 720], ratios: ['9:16'], audio: true },
        { model: 'Nano Banana Pro', type: 'image', inputs: ['text', 'refimg'], durations: null, res: null, ratios: ['1:1'], audio: null }
      ] });
    }) as unknown as typeof fetch;
    const client = new AxcelClient(fetchImpl, { url: 'http://127.0.0.1:8899', token: 'x'.repeat(20) });
    const models = await client.models();
    expect(calls[0].init?.headers).toMatchObject({ Authorization: `Bearer ${'x'.repeat(20)}` });
    expect(models[0]).toMatchObject({ id: 'Seedance 2.0', kind: 'video', audio: true, durations: [5, 8], resolutions: [480, 720] });
    expect(models[1]).toMatchObject({ id: 'Nano Banana Pro', kind: 'image', audio: false });
  });

  it('turns a bridge 502 into an AxcelError that says whether a retry can help', async () => {
    const fetchImpl = (async () => json({ error: 'Sesi Axcel berakhir', final: true }, 502)) as unknown as typeof fetch;
    const client = new AxcelClient(fetchImpl, { url: 'http://127.0.0.1:8899', token: 'x'.repeat(20) });
    await expect(client.health()).rejects.toMatchObject({ message: 'Sesi Axcel berakhir', final: true });
  });
});

describe('AxcelWorker', () => {
  it('submits a video job, waits for the file and completes it', async () => {
    const { state, store } = fakeStore([job()]);
    const generate = vi.fn(async () => ({ jobId: 'job_remote_1' }));
    const jobStatus = vi.fn()
      .mockResolvedValueOnce({ status: 'running', progress: 40 })
      .mockResolvedValue({ status: 'done', progress: 100, resultUrl: '/api/media/job_remote_1.mp4?k=1' });
    const collect = vi.fn(async () => ({ path: '/tmp/clips/job_axcel_1.mp4', bytes: 4096 }));
    const client = { generate, job: jobStatus, collect, upload: vi.fn(async () => ({ assetId: 'ast_1' })) } as unknown as AxcelClient;

    const worker = new AxcelWorker({ store, client: async () => client, sleep: async () => undefined });
    await worker.tick();
    await worker.idle();

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'Seedance 2.0', prompt: 'nelayan menarik jaring saat fajar', ratio: '9:16', duration: 5, resolution: 480, audio: true, idempotencyKey: 'job_axcel_1', inputs: {}
    }));
    expect(collect).toHaveBeenCalledWith('job_remote_1', 'video', 'job_axcel_1', '/api/media/job_remote_1.mp4?k=1');
    expect(state.completed).toEqual([{ id: 'job_axcel_1', filePath: '/tmp/clips/job_axcel_1.mp4', bytes: 4096, provider: 'axcel' }]);
  });

  it('uploads the keyframe for an image-to-video job', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'axcel-job-'));
    const frame = join(dir, 'frame.png');
    await writeFile(frame, Buffer.from(PNG_BYTES));
    const { store } = fakeStore([job({ startImage: frame })]);
    const upload = vi.fn(async () => ({ assetId: 'ast_frame' }));
    const client = { generate: vi.fn(async () => ({ jobId: 'j2' })), job: vi.fn(async () => ({ status: 'done' })), collect: vi.fn(async () => ({ path: '/tmp/x.mp4', bytes: 2048 })), upload } as unknown as AxcelClient;
    const worker = new AxcelWorker({ store, client: async () => client, sleep: async () => undefined });
    await worker.tick();
    await worker.idle();
    expect(upload).toHaveBeenCalled();
    expect((client.generate as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls[0][0].inputs).toEqual({ start: ['ast_frame'] });
  });

  it('does not complete twice when the bridge uploaded the file to the server itself', async () => {
    const { state, store } = fakeStore([job({ kind: 'image', model: 'Nano Banana Pro' })]);
    const client = {
      generate: vi.fn(async () => ({ jobId: 'j-remote' })),
      job: vi.fn(async () => ({ status: 'done', resultUrl: '/api/media/j.png?k=1' })),
      collect: vi.fn(async () => ({ uploaded: true, bytes: 999 })),
      upload: vi.fn()
    } as unknown as AxcelClient;
    const worker = new AxcelWorker({ store, client: async () => client, sleep: async () => undefined });
    await worker.tick();
    await worker.idle();
    expect(state.completed).toEqual([]);
    expect(client.collect).toHaveBeenCalledWith('j-remote', 'image', 'job_axcel_1', '/api/media/j.png?k=1');
  });

  it('fails over to Google Flow on the last attempt even when the engine said "retry"', async () => {
    const { state, store } = fakeStore([job({ kind: 'image', model: 'Nano Banana Pro', maxAttempts: 1 })]);
    const client = {
      generate: vi.fn(async () => { throw new AxcelError('Turnstile generate gagal', 502, false); }),
      job: vi.fn(), collect: vi.fn(), upload: vi.fn()
    } as unknown as AxcelClient;
    const worker = new AxcelWorker({ store, client: async () => client, sleep: async () => undefined });
    await worker.tick();
    await worker.idle();
    expect(state.fallback).toMatchObject({ prompt: 'nelayan menarik jaring saat fajar' });
    expect(state.failed[0].error).toContain('dialihkan ke Google Flow');
  });

  it('marks a refused job final instead of retrying it', async () => {
    const { state, store } = fakeStore([job({ kind: 'image', model: 'Nano Banana Pro' })]);
    const client = {
      generate: vi.fn(async () => { throw new AxcelError('TURNSTILE: Verifikasi keamanan gagal', 502, true); }),
      upload: vi.fn(), job: vi.fn(), collect: vi.fn()
    } as unknown as AxcelClient;
    const worker = new AxcelWorker({ store, client: async () => client, sleep: async () => undefined });
    await worker.tick();
    await worker.idle();
    expect(state.failed[0]).toMatchObject({ id: 'job_axcel_1', final: true });
    expect(state.failed[0].error).toContain('dialihkan ke Google Flow');
    // failover: the same prompt is queued on the free engine
    expect(state.fallback).toMatchObject({ prompt: 'nelayan menarik jaring saat fajar', kind: 'image', aspect: '9:16', durationSec: 5 });
  });

  it('turns an Axcel-side failure into a failed job', async () => {
    const { state, store } = fakeStore([job()]);
    const client = {
      generate: vi.fn(async () => ({ jobId: 'j3' })),
      job: vi.fn(async () => ({ status: 'error', error: 'kuota harian habis' })),
      collect: vi.fn(), upload: vi.fn()
    } as unknown as AxcelClient;
    const worker = new AxcelWorker({ store, client: async () => client, sleep: async () => undefined });
    await worker.tick();
    await worker.idle();
    expect(state.failed[0]).toMatchObject({ error: 'Axcel: kuota harian habis' });
  });

  it('can run without the Flow failover when the caller opts out', async () => {
    const { state, store } = fakeStore([job()]);
    const client = {
      generate: vi.fn(async () => { throw new AxcelError('ditolak', 422, true); }),
      job: vi.fn(), collect: vi.fn(), upload: vi.fn()
    } as unknown as AxcelClient;
    const worker = new AxcelWorker({ store, client: async () => client, sleep: async () => undefined, failoverToFlow: false });
    await worker.tick();
    await worker.idle();
    expect(state.fallback).toBeUndefined();
    expect(state.failed[0].error).toBe('Axcel: ditolak');
  });

  it('does nothing without a configured bridge', async () => {
    const { store } = fakeStore([job()]);
    const worker = new AxcelWorker({ store, client: async () => undefined });
    await worker.tick();
    expect(await store.runningJobs('axcel')).toEqual([]);
  });
});
