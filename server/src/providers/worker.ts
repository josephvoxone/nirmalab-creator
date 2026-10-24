/**
 * OpenRouter worker: renders `provider: 'openrouter'` jobs inside the server process (no Mac).
 * At most 2 jobs in flight; only runs while a key is configured. Results land in
 * `<dataDir>/flow/clips/<jobId>.<mp4|png>` and complete through the same store method the bridge
 * uses, so stories and Studio collect them unchanged. A submitted video's generation id is stored
 * on the job, so a restart resumes polling instead of paying twice.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FlowJob, FlowStore } from '../flow/store.js';
import { sniffMediaType } from '../lib/media-type.js';
import { OpenRouterCatalog, closestDuration, type ModelInfo } from './catalog.js';
import { OpenRouterError, openRouterJson, openRouterRequest, type FetchLike } from './client.js';
import { OpenRouterConfigStore } from './config.js';

const MAX_IN_FLIGHT = 2;
const POLL_MS = 10_000;
const POLL_TIMEOUT_MS = 15 * 60_000;
const MIN_BYTES = 1024;

export type OpenRouterWorkerDeps = {
  dataDir: string;
  store: FlowStore;
  fetch?: FetchLike;
  catalog?: OpenRouterCatalog;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

type VideoStatus = { id?: string; status?: string; error?: unknown; usage?: { cost?: unknown } };

const cost = (usage: { cost?: unknown } | undefined) => (typeof usage?.cost === 'number' && Number.isFinite(usage.cost) ? { costUsd: usage.cost } : {});

export class OpenRouterWorker {
  private readonly active = new Map<string, Promise<void>>();
  private readonly config: OpenRouterConfigStore;
  private readonly catalog: OpenRouterCatalog;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly clipsDir: string;
  private ticking = false;

  constructor(private readonly deps: OpenRouterWorkerDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.config = new OpenRouterConfigStore(deps.dataDir);
    this.catalog = deps.catalog ?? new OpenRouterCatalog(deps.dataDir, { fetch: this.fetchImpl });
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
    this.clipsDir = join(deps.dataDir, 'flow', 'clips');
  }

  /** Start work up to the in-flight limit (adopting running jobs left by a previous process). Never waits for jobs. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const key = await this.config.apiKey();
      if (!key) return;
      for (const job of await this.deps.store.runningJobs('openrouter')) {
        if (this.active.size >= MAX_IN_FLIGHT) return;
        if (!this.active.has(job.id)) this.launch(job, key);
      }
      while (this.active.size < MAX_IN_FLIGHT) {
        const job = await this.deps.store.claimJob('openrouter', { provider: 'openrouter' });
        if (!job) return;
        this.launch(job, key);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Resolves when every job in flight has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active.values()]);
  }

  /** Tick every `intervalMs`; returns a stop function. */
  start(intervalMs: number): () => void {
    const timer = setInterval(() => {
      void this.tick().catch(error => console.error('[openrouter] tick:', error instanceof Error ? error.message : String(error)));
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private launch(job: FlowJob, key: string): void {
    const run = this.process(job, key).finally(() => { this.active.delete(job.id); });
    this.active.set(job.id, run);
  }

  private async process(job: FlowJob, key: string): Promise<void> {
    try {
      if (job.kind === 'video') await this.video(job, key);
      else await this.image(job, key);
    } catch (error) {
      const final = error instanceof OpenRouterError ? error.final : false;
      const message = error instanceof OpenRouterError ? error.message
        : `OpenRouter gagal: ${error instanceof Error ? error.message : String(error)}`;
      await this.deps.store.failJob(job.id, message, { final }).catch(() => undefined);
    }
  }

  private async model(kind: 'image' | 'video', id: string): Promise<ModelInfo | undefined> {
    try {
      return await this.catalog.find(kind, id);
    } catch {
      return undefined;
    }
  }

  private async dataUrl(file: string | undefined): Promise<string | undefined> {
    if (!file || !existsSync(file)) return undefined;
    const type = sniffMediaType(file);
    if (!type.startsWith('image/')) return undefined;
    return `data:${type};base64,${(await readFile(file)).toString('base64')}`;
  }

  private async save(job: FlowJob, bytes: Buffer, result: { costUsd?: number }): Promise<void> {
    if (bytes.byteLength < MIN_BYTES) throw new OpenRouterError('Hasil OpenRouter kosong/rusak', 200, false);
    await mkdir(this.clipsDir, { recursive: true, mode: 0o700 });
    const filePath = join(this.clipsDir, `${job.id}.${job.kind === 'video' ? 'mp4' : 'png'}`);
    await writeFile(filePath, bytes, { mode: 0o600 });
    await this.deps.store.completeJob(job.id, { filePath, bytes: bytes.byteLength, provider: 'openrouter', ...(Object.keys(result).length ? { result } : {}) });
  }

  private async image(job: FlowJob, key: string): Promise<void> {
    const info = await this.model('image', job.model!);
    const refs = info?.references === false ? [] : (await Promise.all((job.references ?? []).map(f => this.dataUrl(f)))).filter((u): u is string => !!u);
    const body = await openRouterJson<{ data?: Array<{ b64_json?: unknown }>; usage?: { cost?: unknown } }>(this.fetchImpl, key, '/images', {
      body: {
        model: job.model, prompt: job.prompt, aspect_ratio: job.aspect, n: 1,
        ...(refs.length ? { input_references: refs.map(url => ({ type: 'image_url', image_url: { url } })) } : {})
      },
      timeoutMs: 300_000
    });
    const b64 = body.data?.[0]?.b64_json;
    if (typeof b64 !== 'string' || !b64) throw new OpenRouterError('Balasan OpenRouter tanpa gambar', 200, false);
    await this.save(job, Buffer.from(b64, 'base64'), cost(body.usage));
  }

  private async video(job: FlowJob, key: string): Promise<void> {
    let remoteId = job.remoteId;
    if (!remoteId) {
      const info = await this.model('video', job.model!);
      const frame = info?.firstFrame === false ? undefined : await this.dataUrl(job.startImage);
      const submitted = await openRouterJson<VideoStatus>(this.fetchImpl, key, '/videos', {
        body: {
          model: job.model, prompt: job.prompt, aspect_ratio: job.aspect,
          duration: closestDuration(info?.durations),
          ...(info?.resolutions?.includes('720p') ? { resolution: '720p' } : {}),
          ...(info?.audio ? { generate_audio: true } : {}),
          ...(frame ? { frame_images: [{ type: 'image_url', image_url: { url: frame }, frame_type: 'first_frame' }] } : {})
        }
      });
      if (typeof submitted.id !== 'string' || !submitted.id) throw new OpenRouterError('Balasan OpenRouter tanpa id video', 200, false);
      remoteId = submitted.id;
      await this.deps.store.setRemoteId(job.id, remoteId);
    }
    const path = `/videos/${encodeURIComponent(remoteId)}`;
    const started = this.now();
    let done: VideoStatus | undefined;
    while (!done) {
      if (this.now() - started >= POLL_TIMEOUT_MS) throw new OpenRouterError('Video OpenRouter tidak selesai dalam 15 menit', 0, true);
      await this.sleep(POLL_MS);
      let status: VideoStatus;
      try {
        status = await openRouterJson<VideoStatus>(this.fetchImpl, key, path, { timeoutMs: 30_000 });
      } catch (error) {
        if (error instanceof OpenRouterError && error.final) throw error;
        continue; // transient (network, 5xx): keep polling until the deadline
      }
      if (status.status === 'completed') done = status;
      else if (status.status === 'failed' || status.status === 'cancelled' || status.status === 'expired') {
        const reason = typeof status.error === 'string' ? status.error
          : typeof (status.error as { message?: unknown } | undefined)?.message === 'string' ? (status.error as { message: string }).message : '';
        throw new OpenRouterError(`Video OpenRouter gagal (${status.status})${reason ? `: ${reason.slice(0, 300)}` : ''}`, 200, true);
      }
    }
    const res = await openRouterRequest(this.fetchImpl, key, `${path}/content?index=0`, { timeoutMs: 300_000 });
    await this.save(job, Buffer.from(await res.arrayBuffer()), cost(done.usage));
  }
}
