import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClipContext, ClipProvider } from './pool.js';
import { FreeGenerateError, type FetchLike, type FreeClipRequest, type FreeClipResult } from './types.js';

const BASE = 'https://gen.pollinations.ai';
const POLL_MS = 5_000;
const MAX_POLLS = 120;
const DEFAULT_TIMEOUT_MS = 25_000;

export type PollinationsOptions = {
  timeoutMs?: number;
  /** Caller abort (text drafts): stops the request. */
  signal?: AbortSignal;
};

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    return await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new FreeGenerateError('TIMEOUT', `Pollinations request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export type PollinationsEnv = {
  apiKey?: string;
  model?: string;
};

export function pollinationsEnv(env: NodeJS.ProcessEnv = process.env): PollinationsEnv {
  return {
    apiKey: env.OPENCREATOR_POLLINATIONS_API_KEY?.trim() || undefined,
    model: env.OPENCREATOR_POLLINATIONS_VIDEO_MODEL?.trim() || undefined
  };
}

export type PollinationsClipInput = FreeClipRequest & {
  apiKey?: string;
  model?: string;
};

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function dims(aspect: '9:16' | '16:9'): { width: number; height: number } {
  return aspect === '16:9' ? { width: 1280, height: 720 } : { width: 720, height: 1280 };
}

async function readJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function pollinationsVideo(
  fetchImpl: FetchLike,
  input: PollinationsClipInput,
  outDir: string,
  now: () => number = Date.now,
  opts: PollinationsOptions = {}
): Promise<{ filePath: string; bytes: number }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const prompt = input.prompt.trim();
  if (!prompt) throw new FreeGenerateError('INVALID_INPUT', 'Prompt is required');
  const { width, height } = dims(input.aspect ?? '9:16');
  const params = new URLSearchParams({
    model: input.model ?? 'google/veo-3.1-fast',
    width: String(width),
    height: String(height),
    duration: String(Math.min(Math.max(Math.round(input.durationSec ?? 5), 1), 10)),
    ...(input.apiKey ? { key: input.apiKey } : {})
  });
  const submit = await fetchWithTimeout(fetchImpl, `${BASE}/video/${encodeURIComponent(prompt)}?${params.toString()}`, {
    headers: { ...authHeaders(input.apiKey), Prefer: 'respond-async' }
  }, timeoutMs);
  if (submit.status === 401) {
    throw new FreeGenerateError('NEEDS_KEY', 'Pollinations needs an API key (enter.pollinations.ai) — set OPENCREATOR_POLLINATIONS_API_KEY');
  }
  let jobId: string | undefined;
  if (submit.status === 202) {
    const payload = (await readJsonSafe(submit)) as { id?: string } | undefined;
    jobId = payload?.id ?? new URL(submit.headers.get('location') ?? '', BASE).pathname.split('/').pop();
  }
  if (!jobId) {
    // Cached/sync path: body may already be the mp4.
    const contentType = submit.headers.get('content-type') ?? '';
    if (submit.ok && contentType.includes('video/')) {
      return saveMp4(new Uint8Array(await submit.arrayBuffer()), outDir, now);
    }
    const payload = await readJsonSafe(submit);
    throw new FreeGenerateError(
      'GENERATE_FAILED',
      `Pollinations submit failed (HTTP ${submit.status}): ${JSON.stringify(payload).slice(0, 200)}`
    );
  }
  let lastState = 'queued';
  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    const check = await fetchWithTimeout(fetchImpl, `${BASE}/v1/jobs/${jobId}`, { headers: authHeaders(input.apiKey) }, timeoutMs);
    const state = (await readJsonSafe(check)) as {
      status?: string; state?: string; result_url?: string; download_url?: string; url?: string;
      error?: { message?: string };
    } | undefined;
    lastState = String(state?.status ?? state?.state ?? 'unknown').toLowerCase();
    if (lastState === 'succeeded' || lastState === 'succeed' || lastState === 'completed' || lastState === 'complete') {
      const fileUrl = state?.result_url ?? state?.download_url ?? state?.url;
      const bytes = fileUrl
        ? new Uint8Array(await (await fetchWithTimeout(fetchImpl, fileUrl, { headers: authHeaders(input.apiKey) }, timeoutMs)).arrayBuffer())
        : await downloadResult(fetchImpl, jobId, input.apiKey, timeoutMs);
      return saveMp4(bytes, outDir, now);
    }
    if (lastState === 'failed' || lastState === 'error' || lastState === 'cancelled') {
      throw new FreeGenerateError('GENERATE_FAILED', `Pollinations job failed: ${(state?.error?.message ?? lastState).slice(0, 200)}`);
    }
  }
  throw new FreeGenerateError('GENERATE_TIMEOUT', `Pollinations job still ${lastState} after ${Math.round((MAX_POLLS * POLL_MS) / 60000)} min`);
}

async function downloadResult(fetchImpl: FetchLike, jobId: string, apiKey?: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<Uint8Array> {
  const response = await fetchWithTimeout(fetchImpl, `${BASE}/v1/jobs/${jobId}/result`, { headers: authHeaders(apiKey) }, timeoutMs);
  if (!response.ok) throw new FreeGenerateError('GENERATE_FAILED', `Pollinations result fetch failed (HTTP ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function saveMp4(bytes: Uint8Array, outDir: string, now: () => number): Promise<{ filePath: string; bytes: number }> {
  if (bytes.byteLength < 1024) throw new FreeGenerateError('GENERATE_FAILED', 'Pollinations returned empty video');
  await mkdir(outDir, { recursive: true });
  const filePath = join(outDir, `pollinations-${now()}-${Math.floor(Math.random() * 1e6)}.mp4`);
  await writeFile(filePath, bytes);
  return { filePath, bytes: bytes.byteLength };
}

export async function pollinationsImage(
  fetchImpl: FetchLike,
  input: { prompt: string; width?: number; height?: number; model?: string; seed?: number; apiKey?: string },
  outDir: string,
  now: () => number = Date.now,
  opts: PollinationsOptions = {}
): Promise<{ filePath: string; bytes: number }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const prompt = input.prompt.trim();
  if (!prompt) throw new FreeGenerateError('INVALID_INPUT', 'Prompt is required');
  const params = new URLSearchParams({
    model: input.model ?? 'black-forest-labs/flux.1-schnell',
    width: String(input.width ?? 768),
    height: String(input.height ?? 1344),
    ...(input.seed !== undefined ? { seed: String(input.seed) } : {}),
    ...(input.apiKey ? { key: input.apiKey } : {})
  });
  const response = await fetchWithTimeout(fetchImpl, `${BASE}/image/${encodeURIComponent(prompt)}?${params.toString()}`, {
    headers: authHeaders(input.apiKey)
  }, timeoutMs);
  if (response.status === 401) {
    throw new FreeGenerateError('NEEDS_KEY', 'Pollinations needs an API key — set OPENCREATOR_POLLINATIONS_API_KEY');
  }
  if (!response.ok) throw new FreeGenerateError('GENERATE_FAILED', `Pollinations image failed (HTTP ${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1024) throw new FreeGenerateError('GENERATE_FAILED', 'Pollinations returned empty image');
  await mkdir(outDir, { recursive: true });
  const filePath = join(outDir, `pollinations-${now()}-${Math.floor(Math.random() * 1e6)}.jpg`);
  await writeFile(filePath, bytes);
  return { filePath, bytes: bytes.byteLength };
}

export type PollinationsTextInput = {
  prompt: string;
  model?: string;
  system?: string;
  apiKey?: string;
  maxTokens?: number;
};

export async function pollinationsText(
  fetchImpl: FetchLike,
  input: PollinationsTextInput,
  _outDir: string,
  opts: PollinationsOptions = {}
): Promise<{ text: string; model: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const prompt = input.prompt.trim();
  if (!prompt) throw new FreeGenerateError('INVALID_INPUT', 'Prompt is required');
  const model = input.model?.trim() || 'openai-fast';
  const response = await fetchWithTimeout(fetchImpl, `${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(input.apiKey) },
    body: JSON.stringify({
      model,
      messages: [
        ...(input.system?.trim() ? [{ role: 'system', content: input.system.trim() }] : []),
        { role: 'user', content: prompt }
      ],
      max_tokens: input.maxTokens ?? 2000
    })
  }, timeoutMs, opts.signal);
  if (response.status === 401) {
    throw new FreeGenerateError('NEEDS_KEY', 'Pollinations needs an API key — set OPENCREATOR_POLLINATIONS_API_KEY');
  }
  if (!response.ok) throw new FreeGenerateError('GENERATE_FAILED', `Pollinations text failed (HTTP ${response.status})`);
  const payload = (await readJsonSafe(response)) as { choices?: Array<{ message?: { content?: string } }> } | undefined;
  const text = payload?.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text) throw new FreeGenerateError('GENERATE_FAILED', 'Pollinations returned empty text');
  return { text, model };
}

export async function pollinationsModels(
  fetchImpl: FetchLike,
  opts: PollinationsOptions = {}
): Promise<string[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const response = await fetchWithTimeout(fetchImpl, `${BASE}/v1/models`, {}, timeoutMs);
  if (!response.ok) throw new FreeGenerateError('GENERATE_FAILED', `Pollinations models failed (HTTP ${response.status})`);
  const payload = (await readJsonSafe(response)) as { data?: Array<{ id?: string }> } | undefined;
  const models = (payload?.data ?? []).map(m => m.id).filter((id): id is string => !!id);
  if (models.length === 0) throw new FreeGenerateError('GENERATE_FAILED', 'Pollinations returned no models');
  return models;
}

export function createPollinationsProvider(env: NodeJS.ProcessEnv = process.env): ClipProvider {
  const { apiKey, model } = pollinationsEnv(env);
  return {
    name: 'pollinations',
    async generate(request: FreeClipRequest, ctx: ClipContext): Promise<FreeClipResult> {
      const outDir = join(ctx.outDir, 'pollinations');
      const out = await pollinationsVideo(fetch, {
        prompt: request.prompt,
        aspect: request.aspect,
        durationSec: request.durationSec,
        apiKey,
        model
      }, outDir);
      return { ok: true, filePath: out.filePath, provider: 'pollinations' };
    }
  };
}
