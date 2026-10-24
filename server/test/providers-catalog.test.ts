import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OpenRouterCatalog, closestDuration, mapImageModel, mapVideoModel } from '../src/providers/catalog.js';

const video = (id: string, extra: Record<string, unknown>) => ({
  id, name: id, supported_aspect_ratios: ['16:9', '9:16'], supported_durations: [4, 6, 8], supported_resolutions: ['720p', '1080p'],
  supported_frame_images: ['first_frame', 'last_frame'], generate_audio: true, ...extra
});

describe('closestDuration', () => {
  it('picks the supported duration closest to 6 (ties: the longer one), 6 when unknown', () => {
    expect(closestDuration([4, 6, 8])).toBe(6);
    expect(closestDuration([5, 10])).toBe(5);
    expect(closestDuration([8, 4])).toBe(8);
    expect(closestDuration([10, 15])).toBe(10);
    expect(closestDuration(undefined)).toBe(6);
    expect(closestDuration([])).toBe(6);
  });
});

describe('mapVideoModel', () => {
  it('prices a clip from duration_seconds_with_audio_720p (USD per second) at the closest duration', () => {
    const m = mapVideoModel(video('google/veo-3.1-fast', { pricing_skus: {
      duration_seconds_with_audio: '0.12', duration_seconds_with_audio_720p: '0.10', duration_seconds_without_audio_720p: '0.08'
    } }));
    expect(m).toMatchObject({ id: 'google/veo-3.1-fast', aspects: ['16:9', '9:16'], durations: [4, 6, 8], audio: true, firstFrame: true });
    expect(m.usdPerClip).toBeCloseTo(0.6, 6);
    expect(m.priceLabel).toBe('±$0,60 / klip 6 dtk');
  });

  it('falls back to duration_seconds_with_audio, duration_seconds_720p and duration_seconds', () => {
    expect(mapVideoModel(video('google/veo-3.1', { pricing_skus: { duration_seconds_with_audio: '0.40', duration_seconds_without_audio: '0.20' } })).usdPerClip).toBeCloseTo(2.4, 6);
    expect(mapVideoModel(video('alibaba/wan-3.0', { supported_durations: [2, 3, 4, 5, 6, 7], pricing_skus: { duration_seconds_480p: '0.05', duration_seconds_720p: '0.1' } })).usdPerClip).toBeCloseTo(0.6, 6);
    const hailuo = mapVideoModel(video('minimax/hailuo-2.3', { supported_durations: [6, 10], generate_audio: false, pricing_skus: { duration_seconds: '0.0817' } }));
    expect(hailuo.usdPerClip).toBeCloseTo(0.4902, 6);
    expect(hailuo.audio).toBe(false);
  });

  it('converts cents per second (720p first, then generic) to USD', () => {
    expect(mapVideoModel(video('x-ai/grok-imagine-video', { supported_durations: [1, 2, 3, 4, 5, 6], pricing_skus: {
      cents_per_image_input: '0.2', cents_per_video_output_second_480p: '5', cents_per_video_output_second_720p: '7'
    } })).usdPerClip).toBeCloseTo(0.42, 6);
    const runway = mapVideoModel(video('runway/gen-4.5', { supported_durations: [2, 5, 10], generate_audio: false, pricing_skus: { cents_per_second_output: '12' } }));
    expect(runway.usdPerClip).toBeCloseTo(0.6, 6);
    expect(runway.priceLabel).toBe('±$0,60 / klip 5 dtk');
  });

  it('cannot price token-billed models: usdPerClip null with "harga per token"', () => {
    const m = mapVideoModel(video('bytedance/seedance-2.0', { pricing_skus: { video_tokens: '0.000007', video_tokens_without_audio: '0.000007' } }));
    expect(m.usdPerClip).toBeNull();
    expect(m.priceLabel).toBe('harga per token');
  });

  it('reads capability flags: no first frame, audio null, missing lists', () => {
    const m = mapVideoModel({ id: 'a/b', name: 'A B', generate_audio: null, supported_frame_images: null, pricing_skus: {} });
    expect(m).toMatchObject({ id: 'a/b', name: 'A B', aspects: [], audio: false, firstFrame: false, usdPerClip: null });
    expect(m.durations).toBeUndefined();
  });
});

describe('mapImageModel', () => {
  it('reads aspects and whether input_references are accepted', () => {
    const m = mapImageModel({ id: 'google/gemini-2.5-flash-image', name: 'Nano Banana', supported_parameters: {
      aspect_ratio: { type: 'enum', values: ['1:1', '9:16', '16:9'] }, input_references: { type: 'range', min: 0, max: 3 }
    } });
    expect(m).toMatchObject({ id: 'google/gemini-2.5-flash-image', name: 'Nano Banana', aspects: ['1:1', '9:16', '16:9'], references: true, usdPerImage: null });
    expect(typeof m.priceLabel).toBe('string');
    expect(mapImageModel({ id: 'meta/muse-image', name: 'Muse', supported_parameters: {} }).references).toBe(false);
  });
});

describe('video catalog: only models that generate a clip', () => {
  it('drops edit/upscale/avatar models (no supported durations) and keeps generators', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-cat-gen-'));
    const fetchImpl = (async (url: string) => {
      const body = String(url).endsWith('/videos/models')
        ? { data: [
            video('google/veo-3.1-lite', { supported_durations: [4, 6, 8] }),
            video('black-forest-labs/flux-video-edit', { supported_durations: null }),
            video('black-forest-labs/flux-video-upscale', { supported_durations: null }),
            video('runway/aleph-2', { supported_durations: null }),
            video('heygen/avatar-iv', { supported_durations: null })
          ] }
        : { data: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    expect((await new OpenRouterCatalog(dataDir, { fetch: fetchImpl }).models()).video.map(m => m.id)).toEqual(['google/veo-3.1-lite']);
  });
});

describe('OpenRouterCatalog', () => {
  it('fetches both public catalogs once and caches them on disk for an hour', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-cat-'));
    const calls: string[] = [];
    let now = 1_000_000;
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      const body = String(url).endsWith('/videos/models')
        ? { data: [video('google/veo-3.1-fast', { pricing_skus: { duration_seconds_with_audio_720p: '0.10' } })] }
        : { data: [{ id: 'openai/gpt-image-1', name: 'GPT Image', supported_parameters: { input_references: { max: 16 } } }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const catalog = new OpenRouterCatalog(dataDir, { fetch: fetchImpl, now: () => now });
    const first = await catalog.models();
    expect(first.video.map(m => m.id)).toEqual(['google/veo-3.1-fast']);
    expect(first.image.map(m => m.id)).toEqual(['openai/gpt-image-1']);
    expect(calls.sort()).toEqual(['https://openrouter.ai/api/v1/images/models', 'https://openrouter.ai/api/v1/videos/models']);
    expect(existsSync(join(dataDir, 'providers', 'models.json'))).toBe(true);

    now += 59 * 60_000;
    await new OpenRouterCatalog(dataDir, { fetch: fetchImpl, now: () => now }).models();
    expect(calls).toHaveLength(2);

    now += 2 * 60_000;
    await catalog.models();
    expect(calls).toHaveLength(4);
    expect(JSON.parse(readFileSync(join(dataDir, 'providers', 'models.json'), 'utf8')).fetchedAtMs).toBe(now);
  });

  it('serves a stale cache when OpenRouter is down, throws without any cache', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-cat-'));
    const down = (async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch;
    await expect(new OpenRouterCatalog(dataDir, { fetch: down }).models()).rejects.toThrow(/OpenRouter/);
    const ok = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    let now = 0;
    await new OpenRouterCatalog(dataDir, { fetch: ok, now: () => now }).models();
    now = 10 * 3_600_000;
    expect(await new OpenRouterCatalog(dataDir, { fetch: down, now: () => now }).models()).toEqual({ image: [], video: [] });
  });

  it('finds one model by kind and id', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-cat-'));
    const fetchImpl = (async (url: string) => new Response(JSON.stringify(String(url).includes('videos')
      ? { data: [video('google/veo-3.1-fast', { pricing_skus: { duration_seconds_with_audio_720p: '0.10' } })] } : { data: [] }), { status: 200 })) as unknown as typeof fetch;
    const catalog = new OpenRouterCatalog(dataDir, { fetch: fetchImpl });
    expect((await catalog.find('video', 'google/veo-3.1-fast'))?.usdPerClip).toBeCloseTo(0.6, 6);
    expect(await catalog.find('video', 'nope/nope')).toBeUndefined();
  });
});
