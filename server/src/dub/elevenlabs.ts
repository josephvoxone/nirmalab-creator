/**
 * ElevenLabs text-to-speech through a pool of API keys (`ProviderKeys`).
 *
 * Endpoints (checked against the API reference): `POST /v1/text-to-speech/{voice_id}`, `GET /v2/voices`,
 * `GET /v1/user/subscription` (free: reads the credit balance). `language_code` is accepted by Flash/Turbo v2.5 only.
 * A key is never put in an error message or a log.
 */
import { KeyPool, PoolBusyError, PoolEmptyError, type Verdict } from '../lib/key-pool.js';
import type { ProviderKeys } from '../lib/provider-keys.js';
import type { FetchLike } from '../providers/client.js';

export const ELEVEN_BASE = 'https://api.elevenlabs.io';
export const MAX_TEXT_CHARS = 2500;
const OUTPUT_FORMAT = 'mp3_44100_128';
const TTS_TIMEOUT_MS = 60_000;
const VOICES_TTL_MS = 10 * 60_000;

export type DubModel = { id: string; label: string; creditsPerChar: number; languageCode: boolean };
export const DUB_MODELS: DubModel[] = [
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2 — kualitas terbaik', creditsPerChar: 1, languageCode: false },
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5 — cepat dan hemat (½ kredit)', creditsPerChar: 0.5, languageCode: true },
  { id: 'eleven_v3', label: 'v3 — paling ekspresif', creditsPerChar: 1, languageCode: false }
];
export const DEFAULT_DUB_MODEL = 'eleven_multilingual_v2';
export const isDubModel = (id: unknown): id is string => typeof id === 'string' && DUB_MODELS.some(m => m.id === id);

export function estimateCredits(texts: string[], modelId: string): number {
  const rate = DUB_MODELS.find(m => m.id === modelId)?.creditsPerChar ?? 1;
  return texts.reduce((sum, t) => sum + t.length, 0) * rate;
}

export type DubErrorCode = 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'REJECTED' | 'CONFIRM_REQUIRED' | 'INVALID' | 'NOT_FOUND';
export class DubError extends Error {
  constructor(readonly code: DubErrorCode, message: string) { super(message); this.name = 'DubError'; }
}

export type VoiceSettings = { stability?: number; similarityBoost?: number; style?: number; speed?: number; speakerBoost?: boolean };
export type SynthesizeInput = {
  text: string; voiceId: string; modelId: string; settings?: VoiceSettings; languageCode?: string;
  previousText?: string; nextText?: string; seed?: number; signal?: AbortSignal;
};
export type Voice = { id: string; name: string; category?: string; gender?: string; age?: string; accent?: string; description?: string; previewUrl?: string };
/** `limited`: the key may speak but cannot read its subscription (a scoped key), so the credits are unknown. */
export type SubscriptionInfo = { ok: true; tier: string; used: number; limit: number; left: number; resetAtMs?: number; limited?: boolean } | { ok: false; reason: string; rejected: boolean };

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const readJson = async (res: Response): Promise<any> => { try { return await res.json(); } catch { return undefined; } };

/** The provider's reason for a refusal, with anything that looks like a key removed. */
function reasonOf(body: any, fallback: string): string {
  const d = body?.detail;
  const raw = typeof d === 'string' ? d : typeof d?.message === 'string' ? d.message : Array.isArray(d) && typeof d[0]?.msg === 'string' ? d[0].msg : fallback;
  return String(raw).replace(/\b(sk_|xi-)[\w-]{8,}/gi, '•••').slice(0, 200);
}
const statusOf = (body: any): string => (typeof body?.detail?.status === 'string' ? body.detail.status : '');

export class ElevenLabsClient {
  private readonly keys: ProviderKeys;
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  private voiceCache: { at: number; voices: Voice[] } | undefined;

  constructor(deps: { keys: ProviderKeys; fetch: FetchLike; baseUrl?: string }) {
    this.keys = deps.keys;
    this.fetchImpl = deps.fetch;
    this.base = deps.baseUrl ?? ELEVEN_BASE;
  }

  get pool(): KeyPool { return this.keys.pool; }
  configured(): boolean { return this.keys.pool.size() > 0; }

  async synthesize(input: SynthesizeInput): Promise<{ audio: Buffer; keyId: string }> {
    const text = input.text.trim();
    if (!text) throw new DubError('REJECTED', 'Teks dubbing kosong.');
    if (text.length > MAX_TEXT_CHARS) throw new DubError('REJECTED', `Teks dubbing terlalu panjang (${text.length} > ${MAX_TEXT_CHARS} karakter).`);
    const model = DUB_MODELS.find(m => m.id === input.modelId);
    const s = input.settings ?? {};
    const body: Record<string, unknown> = {
      text, model_id: input.modelId,
      ...(model?.languageCode && input.languageCode ? { language_code: input.languageCode } : {}),
      ...(input.previousText ? { previous_text: input.previousText } : {}),
      ...(input.nextText ? { next_text: input.nextText } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      voice_settings: {
        ...(s.stability !== undefined ? { stability: clamp(s.stability, 0, 1) } : {}),
        ...(s.similarityBoost !== undefined ? { similarity_boost: clamp(s.similarityBoost, 0, 1) } : {}),
        ...(s.style !== undefined ? { style: clamp(s.style, 0, 1) } : {}),
        ...(s.speed !== undefined ? { speed: clamp(s.speed, 0.7, 1.2) } : {}),
        ...(s.speakerBoost !== undefined ? { use_speaker_boost: s.speakerBoost } : {})
      }
    };
    const url = `${this.base}/v1/text-to-speech/${encodeURIComponent(input.voiceId)}?output_format=${OUTPUT_FORMAT}`;
    let lastReason = '';
    try {
      return await this.keys.pool.run<{ audio: Buffer; keyId: string }>(async key => {
        const verdict = await this.call(url, key.key, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'audio/mpeg' } }, input.signal);
        if ('rotate' in verdict) lastReason = verdict.rotate.reason;
        return 'ok' in verdict ? { ok: { audio: verdict.ok, keyId: key.id } } : verdict;
      });
    } catch (error) {
      if (error instanceof DubError) throw error;
      if (error instanceof PoolEmptyError) throw new DubError('NOT_CONFIGURED', 'API key ElevenLabs belum diisi. Isi di Pengaturan › Provider › ElevenLabs.');
      if (error instanceof PoolBusyError) throw new DubError('UNAVAILABLE', `Semua API key ElevenLabs sedang tidak bisa dipakai${lastReason ? ` (${lastReason})` : ''}. Coba lagi sebentar.`);
      throw error;
    }
  }

  /** One request with one key, turned into a pool verdict. */
  private async call(url: string, key: string, init: { method: string; body?: string; headers?: Record<string, string> }, outer?: AbortSignal): Promise<Verdict<Buffer>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    outer?.addEventListener('abort', onAbort, { once: true });
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { ...init, headers: { 'xi-api-key': key, ...(init.headers ?? {}) }, signal: controller.signal });
      } catch {
        if (outer?.aborted) return { fail: new DubError('UNAVAILABLE', 'Dubbing dibatalkan.') };
        return { rotate: { cooldownMs: 3_000, reason: 'tidak bisa dihubungi / terlalu lambat' } };
      }
      if (res.ok) {
        const type = res.headers.get('content-type') ?? '';
        const bytes = Buffer.from(await res.arrayBuffer());
        if (!/audio|octet-stream/i.test(type) || bytes.length < 100) return { rotate: { cooldownMs: 5_000, reason: 'jawaban bukan audio' } };
        return { ok: bytes };
      }
      const body = await readJson(res);
      const reason = reasonOf(body, `HTTP ${res.status}`);
      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after'));
        return { rotate: { cooldownMs: Number.isFinite(retry) && retry > 0 ? Math.min(retry, 300) * 1000 : 5_000, reason: `batas pemakaian (429)` } };
      }
      if (res.status === 401 || res.status === 403) {
        if (statusOf(body) === 'quota_exceeded' || /quota|credit/i.test(reason)) return { rotate: { cooldownMs: 30 * 60_000, reason: 'kredit karakter habis' } };
        return { rotate: { cooldownMs: 15 * 60_000, reason: `ditolak (${res.status})`, invalid: true } };
      }
      if (res.status === 402) return { rotate: { cooldownMs: 30 * 60_000, reason: 'perlu pembayaran / kredit habis (402)' } };
      if (res.status >= 500) return { rotate: { cooldownMs: 5_000, reason: `server ElevenLabs error (${res.status})` } };
      return { fail: new DubError('REJECTED', `ElevenLabs menolak permintaan: ${reason}`) };
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    }
  }

  /** Every voice the keys can use (cached 10 minutes). */
  async voices(): Promise<Voice[]> {
    if (this.voiceCache && Date.now() - this.voiceCache.at < VOICES_TTL_MS) return this.voiceCache.voices;
    const voices: Voice[] = [];
    let token = '';
    for (let page = 0; page < 20; page++) {
      const url = `${this.base}/v2/voices?page_size=100${token ? `&next_page_token=${encodeURIComponent(token)}&page_token=${encodeURIComponent(token)}` : ''}`;
      const body = await this.keys.pool.run<any>(async key => {
        const verdict = await this.callJson(url, key.key);
        return verdict;
      }).catch(error => {
        if (error instanceof PoolEmptyError) throw new DubError('NOT_CONFIGURED', 'API key ElevenLabs belum diisi. Isi di Pengaturan › Provider › ElevenLabs.');
        if (error instanceof PoolBusyError) throw new DubError('UNAVAILABLE', 'Semua API key ElevenLabs sedang tidak bisa dipakai.');
        throw error;
      });
      for (const v of Array.isArray(body?.voices) ? body.voices : []) {
        if (typeof v?.voice_id !== 'string') continue;
        const labels = v.labels ?? {};
        voices.push({
          id: v.voice_id, name: String(v.name ?? v.voice_id), ...(v.category ? { category: String(v.category) } : {}),
          ...(labels.gender ? { gender: String(labels.gender) } : {}), ...(labels.age ? { age: String(labels.age) } : {}),
          ...(labels.accent ? { accent: String(labels.accent) } : {}), ...(typeof v.description === 'string' ? { description: v.description } : {}),
          ...(typeof v.preview_url === 'string' ? { previewUrl: v.preview_url } : {})
        });
      }
      token = body?.has_more && typeof body.next_page_token === 'string' ? body.next_page_token : '';
      if (!token) break;
    }
    this.voiceCache = { at: Date.now(), voices };
    return voices;
  }

  private async callJson(url: string, key: string): Promise<Verdict<any>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await this.fetchImpl(url, { method: 'GET', headers: { 'xi-api-key': key }, signal: controller.signal });
      if (res.ok) return { ok: await readJson(res) };
      const body = await readJson(res);
      if (res.status === 401 || res.status === 403) return { rotate: { cooldownMs: 15 * 60_000, reason: `ditolak (${res.status})`, invalid: true } };
      if (res.status === 429 || res.status >= 500) return { rotate: { cooldownMs: 5_000, reason: `HTTP ${res.status}` } };
      return { fail: new DubError('REJECTED', `ElevenLabs menolak permintaan: ${reasonOf(body, `HTTP ${res.status}`)}`) };
    } catch {
      return { rotate: { cooldownMs: 3_000, reason: 'tidak bisa dihubungi' } };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Credit balance of ONE stored key (free call; also proves the key works). */
  async subscription(keyId: string): Promise<SubscriptionInfo> {
    const secret = this.keys.secretOf(keyId);
    return secret ? this.probeKey(secret) : { ok: false, reason: 'key tidak ditemukan', rejected: false };
  }

  /** Same for a key that is not stored yet (used to vet a key before it is added). */
  async probeKey(secret: string): Promise<SubscriptionInfo> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}/v1/user/subscription`, { method: 'GET', headers: { 'xi-api-key': secret }, signal: controller.signal });
      } catch {
        return { ok: false, reason: 'ElevenLabs tidak bisa dihubungi', rejected: false };
      }
      const body = await readJson(res);
      if (res.ok) {
        const used = Number(body?.character_count), limit = Number(body?.character_limit);
        if (!Number.isFinite(used) || !Number.isFinite(limit)) return { ok: false, reason: 'jawaban tidak terbaca', rejected: false };
        const reset = Number(body?.next_character_count_reset_unix);
        return { ok: true, tier: String(body?.tier ?? '?'), used, limit, left: Math.max(0, limit - used), ...(Number.isFinite(reset) && reset > 0 ? { resetAtMs: reset * 1000 } : {}) };
      }
      if (res.status === 401 || res.status === 403) {
        // A key limited to text-to-speech cannot read the subscription: it is valid, only its balance is hidden.
        if (statusOf(body) === 'missing_permissions' || /permission/i.test(reasonOf(body, ''))) return { ok: true, tier: '?', used: 0, limit: 0, left: 0, limited: true };
        return { ok: false, reason: `ditolak (${res.status})`, rejected: true };
      }
      return { ok: false, reason: `HTTP ${res.status}`, rejected: false };
    } finally {
      clearTimeout(timer);
    }
  }
}
