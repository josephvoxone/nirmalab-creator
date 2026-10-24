/**
 * OpenRouter model catalogs (public, no key) → ModelInfo, cached 1 h on disk
 * at `<dataDir>/providers/models.json`. A stale cache is served when OpenRouter is down.
 */
import { join } from 'node:path';
import { readPrivateJsonFile, writePrivateJsonFile } from '../lib/private-json-file.js';
import type { EngineKind } from './config.js';

export const OPENROUTER_API = 'https://openrouter.ai/api/v1';
export const TARGET_CLIP_SEC = 6;
const CACHE_MS = 3_600_000;

export type ModelInfo = {
  id: string;
  name: string;
  aspects: string[];
  durations?: number[];
  /** Output resolutions (video), e.g. ['720p', '1080p']. */
  resolutions?: string[];
  audio?: boolean;
  firstFrame?: boolean;
  references?: boolean;
  /** Video: one clip at the duration closest to 6 s, 720p, with audio when the model makes audio. */
  usdPerClip?: number | null;
  usdPerImage?: number | null;
  priceLabel: string;
};
export type ModelCatalog = { image: ModelInfo[]; video: ModelInfo[] };

type Raw = Record<string, unknown>;
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** The supported duration closest to 6 s (ties: the longer one, so narration fits); 6 when unknown. */
export function closestDuration(durations: number[] | undefined, target = TARGET_CLIP_SEC): number {
  const valid = (durations ?? []).filter(d => Number.isFinite(d) && d > 0);
  if (!valid.length) return target;
  return valid.reduce((best, d) => {
    const diff = Math.abs(d - target) - Math.abs(best - target);
    return diff < 0 || (diff === 0 && d > best) ? d : best;
  });
}

export const usdLabel = (usd: number) => `$${usd.toFixed(2).replace('.', ',')}`;

/** USD per output second from the pricing SKUs OpenRouter publishes; undefined when billed otherwise. */
function usdPerSecond(skus: Raw, audio: boolean): number | undefined {
  const usd = (key: string) => num(skus[key]);
  const cents = (key: string) => { const c = num(skus[key]); return c === undefined ? undefined : c / 100; };
  return (audio ? usd('duration_seconds_with_audio_720p') ?? usd('duration_seconds_with_audio') : undefined)
    ?? usd('duration_seconds_720p')
    ?? usd('duration_seconds')
    ?? usd('image_to_video_duration_seconds_720p')
    ?? usd('text_to_video_duration_seconds_720p')
    ?? cents('cents_per_video_output_second_720p')
    ?? cents('cents_per_second_output_720p')
    ?? cents('cents_per_second_output');
}

export function mapVideoModel(raw: Raw): ModelInfo {
  const durations = Array.isArray(raw.supported_durations)
    ? [...new Set(raw.supported_durations.map(num).filter((d): d is number => d !== undefined))].sort((a, b) => a - b)
    : undefined;
  const audio = raw.generate_audio === true;
  const skus = raw.pricing_skus && typeof raw.pricing_skus === 'object' ? raw.pricing_skus as Raw : {};
  const seconds = closestDuration(durations);
  const rate = usdPerSecond(skus, audio);
  let usdPerClip: number | null = null;
  if (rate !== undefined) {
    const minimum = num(skus.minimum_cents_per_generation);
    usdPerClip = Math.round(Math.max(rate * seconds, minimum === undefined ? 0 : minimum / 100) * 10_000) / 10_000;
  }
  const tokens = Object.keys(skus).some(k => k.startsWith('video_tokens'));
  const resolutions = list(raw.supported_resolutions);
  return {
    id: String(raw.id),
    name: typeof raw.name === 'string' ? raw.name : String(raw.id),
    aspects: list(raw.supported_aspect_ratios),
    ...(durations?.length ? { durations } : {}),
    ...(resolutions.length ? { resolutions } : {}),
    audio,
    firstFrame: list(raw.supported_frame_images).includes('first_frame'),
    usdPerClip,
    priceLabel: usdPerClip !== null ? `±${usdLabel(usdPerClip)} / klip ${seconds} dtk` : tokens ? 'harga per token' : 'harga tidak diketahui'
  };
}

export function mapImageModel(raw: Raw): ModelInfo {
  const params = raw.supported_parameters && typeof raw.supported_parameters === 'object' ? raw.supported_parameters as Raw : {};
  const aspect = params.aspect_ratio as { values?: unknown } | undefined;
  const refs = params.input_references as { max?: unknown } | undefined;
  return {
    id: String(raw.id),
    name: typeof raw.name === 'string' ? raw.name : String(raw.id),
    aspects: list(aspect?.values),
    references: (num(refs?.max) ?? 0) > 0,
    usdPerImage: null,
    priceLabel: 'harga per gambar: lihat OpenRouter'
  };
}

type Cache = ModelCatalog & { fetchedAtMs: number };
export type CatalogOptions = { fetch?: typeof fetch; now?: () => number };

export class OpenRouterCatalog {
  private readonly path: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private inflight?: Promise<ModelCatalog>;

  constructor(dataDir: string, options: CatalogOptions = {}) {
    this.path = join(dataDir, 'providers', 'models.json');
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async readCache(): Promise<Cache | undefined> {
    try {
      const raw = (await readPrivateJsonFile(this.path)) as Cache | undefined;
      return raw && Array.isArray(raw.image) && Array.isArray(raw.video) && typeof raw.fetchedAtMs === 'number' ? raw : undefined;
    } catch {
      return undefined;
    }
  }

  private async download(path: string): Promise<Raw[]> {
    const res = await this.fetchImpl(`${OPENROUTER_API}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Katalog model OpenRouter gagal dimuat (HTTP ${res.status})`);
    const body = (await res.json()) as { data?: unknown };
    return Array.isArray(body.data) ? body.data.filter((m): m is Raw => !!m && typeof m === 'object' && typeof (m as Raw).id === 'string') : [];
  }

  async models(): Promise<ModelCatalog> {
    const cache = await this.readCache();
    if (cache && this.now() - cache.fetchedAtMs < CACHE_MS) return { image: cache.image, video: cache.video };
    this.inflight ??= (async () => {
      try {
        const [image, video] = await Promise.all([this.download('/images/models'), this.download('/videos/models')]);
        const fresh: Cache = { fetchedAtMs: this.now(), image: image.map(mapImageModel), video: video.map(mapVideoModel) };
        await writePrivateJsonFile(this.path, fresh);
        return { image: fresh.image, video: fresh.video };
      } catch (error) {
        if (cache) return { image: cache.image, video: cache.video };
        throw error instanceof Error && /OpenRouter/.test(error.message) ? error : new Error('Katalog model OpenRouter tidak bisa dimuat');
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  async find(kind: EngineKind, id: string): Promise<ModelInfo | undefined> {
    return (await this.models())[kind].find(m => m.id === id);
  }
}
