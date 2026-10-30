import { del, post, requestJson, type FetchLike } from './http.js';

export type PoolProviderId = 'elevenlabs' | 'gemini';
export const MAX_POOL_KEYS = 10;
export type KeyState = 'ready' | 'busy' | 'cooldown' | 'invalid';
/** What the server returns for a key: never the secret, only the last 4 characters. */
export type PoolKeyView = {
  id: string; label: string; keyHint: string; source: 'store' | 'env'; state: KeyState;
  inFlight: number; uses: number; failures: number; cooldownUntilMs?: number; reason?: string; lastUsedAtMs?: number; limited?: string[];
};
export type KeyPools = {
  elevenlabs: { keys: PoolKeyView[]; max: number };
  gemini: { keys: PoolKeyView[]; max: number; primary: 'opencode-go' | 'gemini'; geminiModel?: string };
};
export type AddedKey = { key: PoolKeyView; verified: boolean; limited?: boolean; detail?: string };
export type KeyTest = { ok: true; tier?: string; used?: number; limit?: number; left?: number; limited?: boolean; models?: string[] } | { ok: false; reason: string; rejected: boolean };
export type TextRouting = { primary: 'opencode-go' | 'gemini'; geminiModel?: string };

export function keyPoolApi(fetchImpl: FetchLike) {
  const base = '/api/providers/keypool';
  return {
    get: () => requestJson<KeyPools>(fetchImpl, base),
    add: (provider: PoolProviderId, key: string, label: string) => requestJson<AddedKey>(fetchImpl, `${base}/${provider}`, post(label ? { key, label } : { key })),
    remove: (provider: PoolProviderId, id: string) => requestJson<{ ok: boolean }>(fetchImpl, `${base}/${provider}/${encodeURIComponent(id)}`, del()),
    test: (provider: PoolProviderId, id: string) => requestJson<KeyTest>(fetchImpl, `${base}/${provider}/${encodeURIComponent(id)}/test`, post({})),
    setRouting: (patch: { primary?: TextRouting['primary']; geminiModel?: string | null }) =>
      requestJson<TextRouting>(fetchImpl, '/api/providers/text-routing', { method: 'PUT', body: JSON.stringify(patch) })
  };
}

export const STATE_LABEL: Record<KeyState, string> = { ready: 'Siap', busy: 'Dipakai', cooldown: 'Istirahat', invalid: 'Ditolak' };

export function stateDetail(k: PoolKeyView, now = Date.now()): string {
  if (k.state === 'invalid') return 'Ditolak provider — periksa key-nya.';
  if (k.state === 'cooldown') {
    const s = Math.max(1, Math.ceil(((k.cooldownUntilMs ?? now) - now) / 1000));
    return `${k.reason ?? 'Dibatasi'} · lanjut ±${s >= 90 ? `${Math.round(s / 60)} mnt` : `${s} dtk`}`;
  }
  if (k.limited?.length) return `Batas pemakaian untuk ${k.limited.join(', ')}`;
  return `${k.uses.toLocaleString('id-ID')}× dipakai${k.failures ? ` · ${k.failures} gagal` : ''}`;
}

export function creditsText(t: Extract<KeyTest, { ok: true }>): string {
  if (t.models) return `Terhubung · ${t.models.length} model tersedia`;
  if (t.limited) return 'Key valid (izin terbatas: sisa kredit tidak terbaca)';
  return `Terhubung · ${t.tier ?? '?'} · sisa ${(t.left ?? 0).toLocaleString('id-ID')} dari ${(t.limit ?? 0).toLocaleString('id-ID')} karakter`;
}
