/**
 * Axcel engine (provider: 'axcel') — server side.
 *
 * Axcel (`axcel.cloud`, plan Gold) has no public API. The only way in is the web app's own
 * `/api/*` behind a session cookie + Cloudflare Turnstile, so the actual calls are made by
 * `bridge/axcel.mjs`, which runs on the Mac next to the logged-in Chrome and exposes a local HTTP
 * API. This module is the server half: config (url + token, 0600), a thin client, and a worker that
 * renders queued jobs and completes them through the same store method the Flow bridge uses.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sniffMediaType } from '../lib/media-type.js';
import { readPrivateJsonFile, writePrivateJsonFile } from '../lib/private-json-file.js';
import type { FlowJob, FlowStore } from '../flow/store.js';
import type { FetchLike } from './client.js';

/** Axcel's own model names (the catalog endpoint's `model` field, not OpenRouter slugs). */
export const AXCEL_MODELS = ['Seedance 2.0', 'Seedance 2.5', 'Veo 3.1 Fast', 'Nano Banana Pro', 'Seedream 5.0 Pro'] as const;
export type AxcelModel = (typeof AXCEL_MODELS)[number];
export const isAxcelModel = (value: unknown): value is AxcelModel => typeof value === 'string' && (AXCEL_MODELS as readonly string[]).includes(value);

export type AxcelModelInfo = {
  id: string;
  name: string;
  kind: 'image' | 'video';
  inputs: string[];
  durations?: number[];
  resolutions?: number[];
  ratios: string[];
  audio: boolean;
};

export type AxcelHealth = {
  ok: boolean;
  akun: string | null;
  plan: string | null;
  planAktif: boolean;
  refMedia: boolean;
  tokenUmurMs: number;
};

export type AxcelView = {
  configured: boolean;
  url: string;
  tokenHint?: string;
  /** Live status from the bridge; absent until probed. */
  health?: AxcelHealth | null;
  error?: string;
};

export type AxcelStored = { url?: string; token?: string };

export class AxcelInputError extends Error {}

const DEFAULT_URL = 'http://127.0.0.1:8899';

/** `<dataDir>/providers/axcel.json` (0600); env `AXCEL_BRIDGE_URL`/`AXCEL_BRIDGE_TOKEN` win. */
export class AxcelConfigStore {
  readonly path: string;
  constructor(private readonly dataDir: string, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.path = join(dataDir, 'providers', 'axcel.json');
  }

  private async read(): Promise<AxcelStored> {
    try {
      const raw = (await readPrivateJsonFile(this.path)) as AxcelStored | undefined;
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  async settings(): Promise<{ url: string; token?: string }> {
    const stored = await this.read();
    const url = (this.env.AXCEL_BRIDGE_URL || stored.url || DEFAULT_URL).replace(/\/$/, '');
    const token = this.env.AXCEL_BRIDGE_TOKEN || stored.token;
    return { url, token: typeof token === 'string' && token.length >= 16 ? token : undefined };
  }

  async view(health?: AxcelHealth | null, error?: string): Promise<AxcelView> {
    const { url, token } = await this.settings();
    return {
      configured: !!token,
      url,
      ...(token ? { tokenHint: `••••${token.slice(-4)}` } : {}),
      ...(health !== undefined ? { health: health ?? null } : {}),
      ...(error ? { error } : {})
    };
  }

  async update(patch: { url?: string | null; token?: string | null }): Promise<AxcelView> {
    if (patch.url !== undefined && patch.url !== null) {
      const url = patch.url.trim().replace(/\/$/, '');
      if (!/^http:\/\/127\.0\.0\.1(:\d{2,5})?$/.test(url)) throw new AxcelInputError('url harus http://127.0.0.1[:port]');
    }
    if (patch.token !== undefined && patch.token !== null) {
      const token = patch.token.trim();
      if (token.length < 16 || token.length > 200 || /\s/.test(token)) throw new AxcelInputError('token bridge tidak valid');
    }
    const stored = await this.read();
    const next: AxcelStored = { ...stored };
    if (patch.url === null) delete next.url;
    else if (typeof patch.url === 'string') next.url = patch.url.trim().replace(/\/$/, '');
    if (patch.token === null) delete next.token;
    else if (typeof patch.token === 'string') next.token = patch.token.trim();
    await writePrivateJsonFile(this.path, next);
    return this.view();
  }
}

export class AxcelError extends Error {
  constructor(message: string, readonly status: number, readonly final: boolean) {
    super(message);
  }
}

type BridgeReply<T> = { status: number; data: T };

async function bridgeRequest<T>(fetchImpl: FetchLike, base: { url: string; token: string }, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = init.timeoutMs ? setTimeout(() => controller.abort(), init.timeoutMs) : undefined;
  let response: Response;
  try {
    response = await fetchImpl(`${base.url}${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: {
        Authorization: `Bearer ${base.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {})
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal
    });
  } catch (error) {
    const aborted = controller.signal.aborted;
    throw new AxcelError(aborted ? 'Axcel bridge tidak menjawab (timeout)' : `Axcel bridge tidak bisa dihubungi di ${base.url}`, 0, false);
  } finally {
    if (timer) clearTimeout(timer);
  }
  let payload: unknown;
  try { payload = await response.json(); } catch { payload = undefined; }
  if (!response.ok) {
    const data = payload as { error?: unknown; final?: unknown } | undefined;
    const message = typeof data?.error === 'string' ? data.error : `Axcel bridge membalas ${response.status}`;
    throw new AxcelError(message, response.status, data?.final === true);
  }
  return payload as T;
}

export class AxcelClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly settings: { url: string; token: string }
  ) {}

  /** The bridge answers `/health` by calling Axcel, which can take a minute on a slow day. */
  health(timeoutMs = 200_000): Promise<AxcelHealth> {
    return bridgeRequest<AxcelHealth>(this.fetchImpl, this.settings, '/health', { timeoutMs });
  }

  /** The bridge's `/catalog` passthrough mapped to what the pickers need. */
  async models(): Promise<AxcelModelInfo[]> {
    const raw = await bridgeRequest<{ models?: Array<Record<string, unknown>> }>(this.fetchImpl, this.settings, '/catalog', { timeoutMs: 60_000 });
    return (raw.models ?? []).flatMap(m => {
      const id = typeof m.model === 'string' ? m.model : undefined;
      const kind = m.type === 'image' ? 'image' : 'video';
      if (!id) return [];
      const inputs = Array.isArray(m.inputs) ? m.inputs.filter((x): x is string => typeof x === 'string') : [];
      return [{
        id,
        name: id,
        kind,
        inputs,
        ...(Array.isArray(m.durations) ? { durations: m.durations.filter((d): d is number => typeof d === 'number') } : {}),
        ...(Array.isArray(m.res) ? { resolutions: m.res.filter((r): r is number => typeof r === 'number') } : {}),
        ratios: Array.isArray(m.ratios) ? m.ratios.filter((r): r is string => typeof r === 'string') : [],
        audio: m.audio === true
      }];
    });
  }

  generate(body: Record<string, unknown>): Promise<{ jobId: string }> {
    return bridgeRequest<{ jobId: string }>(this.fetchImpl, this.settings, '/generate', { body, timeoutMs: 180_000 });
  }

  /** One status poll (short). Long blocking waits break Node's fetch timeouts. */
  job(jobId: string): Promise<{ jobId?: string; status?: string; progress?: number; resultUrl?: string | null; error?: unknown }> {
    return bridgeRequest(this.fetchImpl, this.settings, `/jobs/${encodeURIComponent(jobId)}`, { timeoutMs: 180_000 });
  }

  /**
   * Download a finished result and hand it to the server. The bridge stores it locally and, when it
   * knows the server (`AXCEL_SERVER_URL` + token), uploads it into the queue itself — which is what
   * makes this work with the server on the VPS and Chrome on the Mac.
   */
  collect(jobId: string, kind: 'video' | 'image', serverJobId?: string, resultUrl?: string | null): Promise<{ path?: string; bytes?: number; uploaded?: boolean; error?: unknown }> {
    return bridgeRequest(this.fetchImpl, this.settings, '/collect', {
      body: { jobId, kind, ...(serverJobId ? { serverJobId } : {}), ...(resultUrl ? { resultUrl } : {}) },
      timeoutMs: 290_000
    });
  }

  async upload(bytes: Buffer, name: string, type: string): Promise<{ assetId: string }> {
    const response = await this.fetchImpl(`${this.settings.url}/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.settings.token}`,
        'Content-Type': type,
        'x-nama': encodeURIComponent(name)
      },
      body: new Uint8Array(bytes)
    });
    const payload = (await response.json().catch(() => undefined)) as { assetId?: unknown; error?: unknown } | undefined;
    if (!response.ok) throw new AxcelError(typeof payload?.error === 'string' ? payload.error : `upload gagal (${response.status})`, response.status, response.status === 413);
    if (typeof payload?.assetId !== 'string' || !payload.assetId) throw new AxcelError('upload Axcel tanpa assetId', 200, false);
    return { assetId: payload.assetId };
  }
}

/** Preferred resolution for video renders (Axcel bills per second; 480 is the cheap one). */
export const DEFAULT_RESOLUTION = 480;

export type AxcelWorkerDeps = {
  store: FlowStore;
  client: () => Promise<AxcelClient | undefined>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Re-queue a job that Axcel refused for good on Google Flow (free, Mac/VPS bridge). Default: on. */
  failoverToFlow?: boolean;
};

const AXCEL_POLL_MS = 10_000;
const AXCEL_TIMEOUT_MS = 20 * 60_000;

/**
 * Claims `provider: 'axcel'` jobs and renders them through the bridge. One job at a time (Turnstile
 * solves are serialised anyway) and never blocks the request path.
 */
export class AxcelWorker {
  private readonly active = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private ticking = false;

  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: AxcelWorkerDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const client = await this.deps.client();
      if (!client) return;
      for (const job of await this.deps.store.runningJobs('axcel')) {
        if (job.bridgeId === 'axcel-local' && !this.active.has(job.id)) this.launch(job, client);
      }
      if (this.active.size) return;
      const job = await this.deps.store.claimJob('axcel-local', { provider: 'axcel' });
      if (job) this.launch(job, client);
    } finally {
      this.ticking = false;
    }
  }

  async idle(): Promise<void> {
    while (this.active.size) await Promise.all([...this.active.values()]);
  }

  start(intervalMs: number): () => void {
    const timer = setInterval(() => {
      void this.tick().catch(error => console.error('[axcel] tick:', error instanceof Error ? error.message : String(error)));
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private launch(job: FlowJob, client: AxcelClient): void {
    const run = this.process(job, client).finally(() => this.active.delete(job.id));
    this.active.set(job.id, run);
  }

  private async process(job: FlowJob, client: AxcelClient): Promise<void> {
    try {
      const rendered = await this.render(job, client);
      if (rendered) await this.deps.store.completeJob(job.id, { filePath: rendered.path, bytes: rendered.bytes, provider: 'axcel' });
    } catch (error) {
      const final = error instanceof AxcelError ? error.final : false;
      const message = error instanceof AxcelError ? `Axcel: ${error.message}` : `Axcel gagal: ${error instanceof Error ? error.message : String(error)}`;
      // Failover: an engine the user picked must not silently lose the work. When Axcel refuses for
      // good (quota, gate, moderation) the same prompt is queued again on Google Flow, which the
      // bridge renders unchanged — the app then shows one failed Axcel job and one live Flow job.
      const failover = final && this.deps.failoverToFlow !== false ? await this.requeueOnFlow(job, message) : undefined;
      await this.deps.store.failJob(job.id, failover ? `${message} — dialihkan ke Google Flow (${failover})` : message, { final }).catch(() => undefined);
    }
  }

  /** Copy of the job on provider `flow` (the free engine takes the same prompt/aspect/duration). */
  private async requeueOnFlow(job: FlowJob, reason: string): Promise<string | undefined> {
    try {
      const created = await this.deps.store.createJob({
        prompt: job.prompt,
        kind: job.kind === 'character' ? 'character' : job.kind,
        aspect: job.aspect,
        durationSec: job.durationSec,
        ...(job.technique ? { technique: job.technique } : {}),
        ...(job.group ? { group: job.group } : {}),
        ...(job.startFrame ? { startFrame: job.startFrame } : {}),
        ...(job.createdBy ? { createdBy: job.createdBy } : {})
      });
      console.warn(`[axcel] ${job.id} gagal final (${reason.slice(0, 120)}) → Flow ${created.id}`);
      return created.id;
    } catch (error) {
      console.error('[axcel] failover ke Flow gagal:', error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  /** Upload the keyframe/reference images the job needs, then submit and wait for the render. */
  private async render(job: FlowJob, client: AxcelClient): Promise<{ path: string; bytes: number } | undefined> {
    const inputs: Record<string, string[]> = {};
    const uploads: Array<Promise<void>> = [];
    const add = async (slot: string, file: string | undefined) => {
      if (!file) return;
      const bytes = await readFile(file);
      const { assetId } = await client.upload(bytes, file.split('/').pop() ?? 'upload', sniffMediaType(file));
      (inputs[slot] ??= []).push(assetId);
    };
    if (job.kind === 'video' && job.startImage) uploads.push(add('start', job.startImage));
    if (job.kind === 'image') for (const ref of job.references ?? []) uploads.push(add('refimg', ref));
    await Promise.all(uploads);

    const model = job.model ?? 'Seedance 2.0';
    const submitted = await client.generate({
      model,
      prompt: job.prompt,
      ...(job.kind === 'video' ? { duration: job.durationSec, resolution: DEFAULT_RESOLUTION, audio: true } : {}),
      ratio: job.aspect,
      inputs,
      idempotencyKey: job.id
    });
    // Poll with short requests (a single long request hits Node's fetch timeouts), then collect.
    const startedAt = this.now();
    let status = await client.job(submitted.jobId);
    while (status.status !== 'done') {
      if (['error', 'gagal', 'failed', 'canceled', 'cancelled'].includes(String(status.status))) {
        throw new AxcelError(typeof status.error === 'string' ? status.error : `Axcel gagal (${status.status})`, 200, false);
      }
      if (this.now() - startedAt > AXCEL_TIMEOUT_MS) throw new AxcelError('Axcel tidak selesai dalam 20 menit', 0, true);
      await this.sleep(AXCEL_POLL_MS);
      status = await client.job(submitted.jobId);
    }
    const result = await client.collect(submitted.jobId, job.kind === 'video' ? 'video' : 'image', job.id, status.resultUrl);
    if (typeof result.error === 'string' && result.error) throw new AxcelError(result.error, 200, false);
    if (result.uploaded) return undefined; // the bridge already completed the job through /complete
    if (!result.path || !result.bytes) throw new AxcelError('Axcel tidak menghasilkan berkas', 200, false);
    return { path: result.path, bytes: result.bytes };
  }
}
