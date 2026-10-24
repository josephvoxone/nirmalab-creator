/** Client + pure helpers for the engine providers (contract: docs/providers-and-media.md §1). */
import { ApiError, type FetchLike } from '../../lib/api.js';

export type ProviderId = 'flow' | 'openrouter';
export type Engine = { provider: 'flow' } | { provider: 'openrouter'; model: string };
export type EngineSet = { image?: Engine; video?: Engine };
export type MediaKind = 'image' | 'video';

export type ModelInfo = {
  id: string; name: string; aspects: string[]; durations?: number[]; audio?: boolean; firstFrame?: boolean;
  references?: boolean; usdPerClip?: number | null; usdPerImage?: number | null; priceLabel: string;
};
export type Models = { image: ModelInfo[]; video: ModelInfo[] };
export type OpenRouterState = { configured: boolean; keyHint?: string; defaults: { image?: string; video?: string } };
export type Providers = { flow: { accounts: number; credits: number | null; online: boolean }; openrouter: OpenRouterState };
export type Balance = { usedUsd: number; limitUsd: number | null; remainingUsd: number | null };
export type OpenRouterPatch = { apiKey?: string | null; defaults?: { image?: string | null; video?: string | null } };

export const FLOW: Engine = { provider: 'flow' };

/** Like lib/api requestJson, but also reads `{ error: "text" }` (the provider routes may answer that way). */
async function request<T>(fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<T> {
  const response = await fetchImpl(url, {
    credentials: 'same-origin',
    ...init,
    headers: { Accept: 'application/json', ...(typeof init?.body === 'string' ? { 'Content-Type': 'application/json' } : {}) }
  });
  let payload: unknown;
  try { payload = await response.json(); } catch { payload = undefined; }
  if (!response.ok) {
    const err = (payload as { error?: unknown } | undefined)?.error;
    const message = typeof err === 'string' ? err : (err as { message?: string } | undefined)?.message;
    throw new ApiError(response.status, message ?? `Permintaan gagal (${response.status})`, (err as { code?: string } | undefined)?.code);
  }
  return payload as T;
}

export function providersApi(fetchImpl: FetchLike) {
  return {
    get: () => request<Providers>(fetchImpl, '/api/providers'),
    save: (patch: OpenRouterPatch) => request<OpenRouterState>(fetchImpl, '/api/providers/openrouter', { method: 'PUT', body: JSON.stringify(patch) }),
    test: () => request<{ ok: true; balance: Balance }>(fetchImpl, '/api/providers/openrouter/test', { method: 'POST', body: '{}' }),
    models: () => request<Models>(fetchImpl, '/api/providers/openrouter/models')
  };
}

/** "$0,30" — Indonesian decimals, two places (four under one cent so tiny prices are not "$0,00"). */
export function fmtUsd(n: number): string {
  const digits = n > 0 && n < 0.01 ? 4 : 2;
  return `$${n.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}

/** Cheapest first; models without a known price go last, then by name. */
export function sortVideoModels(list: ModelInfo[]): ModelInfo[] {
  const price = (m: ModelInfo) => (typeof m.usdPerClip === 'number' ? m.usdPerClip : Number.POSITIVE_INFINITY);
  return [...list].sort((a, b) => price(a) - price(b) || a.name.localeCompare(b.name));
}

/** Both a keyframe start (konsisten mode) and native audio (narration). */
export const fitsStory = (m: ModelInfo) => !!m.firstFrame && !!m.audio;

/** "Tersimpan ••••abcd" from a hint that may or may not carry the dots already. */
export function savedKeyText(hint?: string): string {
  const tail = (hint ?? '').replace(/[•*.\s]/g, '').slice(-4);
  return `Tersimpan ••••${tail}`;
}

/** Short price for a picker: "±$0,30/klip", "±$0,04/gambar", else the server's label. */
export function shortPrice(kind: MediaKind, m?: ModelInfo): string {
  if (!m) return 'harga belum diketahui';
  const n = kind === 'video' ? m.usdPerClip : m.usdPerImage;
  if (typeof n === 'number') return `±${fmtUsd(n)}/${kind === 'video' ? 'klip' : 'gambar'}`;
  return m.priceLabel || 'harga belum diketahui';
}

export const isOpenRouter = (e?: Engine): e is { provider: 'openrouter'; model: string } => e?.provider === 'openrouter';
