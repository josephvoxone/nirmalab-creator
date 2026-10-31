/**
 * Gemini as a text model, through Google's OpenAI-compatible endpoint (`/v1beta/openai/chat/completions`,
 * Bearer key, `tools` supported) and a pool of API keys: round-robin, a rate-limited key cools down and the call
 * moves to another key, a refused key is taken out of rotation. When every key is limited for the chosen model
 * the next model is tried. Keys never appear in an error message.
 */
import { PoolBusyError, PoolEmptyError, type Verdict } from '../lib/key-pool.js';
import type { ProviderKeys } from '../lib/provider-keys.js';
import type { FetchLike } from '../providers/client.js';
import { LlmError, parseReply, type ChatInput, type ChatOutput, type TextModel } from './opencode.js';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';
/** Model names move quickly: this is only the default; the settings can name any `gemini-…` model. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const GEMINI_FALLBACK_MODELS = ['gemini-3.6-flash'];
export const GEMINI_MODEL_ID = /^gemini-[a-z0-9][a-z0-9.\-]{1,60}$/i;
export const isGeminiModel = (v: unknown): v is string => typeof v === 'string' && GEMINI_MODEL_ID.test(v);

const USER_AGENT = 'shotweave-studio/1.0 (+https://github.com/josephvoxone/shotweave-studio)';
const CANCELLED = 'Permintaan ke model teks dibatalkan.';
const scrub = (text: string) => text.replace(/AIza[\w-]{10,}/g, '•••').replace(/\b(sk|xi)[-_][\w-]{10,}/gi, '•••').slice(0, 220);
const reasonOf = (body: any, fallback: string) => scrub(String(body?.error?.message ?? body?.[0]?.error?.message ?? fallback));
const readJson = async (res: Response): Promise<any> => { try { return await res.json(); } catch { return undefined; } };
const KEY_REFUSED = /api key not valid|api_key_invalid|invalid api key|permission denied|consumer.*suspended/i;

export function createGeminiModel(deps: { keys: ProviderKeys; fetch: FetchLike; chosenModel?: () => Promise<string | undefined>; models?: string[]; timeoutMs?: number }): TextModel {
  async function attempt(key: string, model: string, input: ChatInput): Promise<Verdict<ChatOutput>> {
    if (input.signal?.aborted) return { fail: new LlmError('UNAVAILABLE', CANCELLED) };
    const timeoutMs = input.timeoutMs ?? deps.timeoutMs ?? 60_000;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onAbort = () => controller.abort();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let res: Response;
      try {
        res = await deps.fetch(`${GEMINI_BASE}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': USER_AGENT },
          body: JSON.stringify({
            model, messages: input.messages,
            ...(input.tools?.length ? { tools: input.tools } : {}),
            ...(input.maxTokens ? { max_tokens: input.maxTokens } : {})
          }),
          signal: controller.signal
        });
      } catch {
        if (input.signal?.aborted) return { fail: new LlmError('UNAVAILABLE', CANCELLED) };
        return { rotate: { cooldownMs: 3_000, reason: timedOut ? `tidak menjawab dalam ${Math.round(timeoutMs / 1000)} dtk` : 'tidak bisa dihubungi' } };
      }
      if (res.ok) {
        const reply = parseReply(await readJson(res), model);
        return reply ? { ok: reply } : { rotate: { cooldownMs: 2_000, reason: 'jawaban tidak terbaca' } };
      }
      const body = await readJson(res);
      const reason = reasonOf(body, `HTTP ${res.status}`);
      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after'));
        return { rotate: { cooldownMs: Number.isFinite(retry) && retry > 0 ? Math.min(retry, 600) * 1000 : 20_000, reason: 'batas pemakaian (429)', scoped: true } };
      }
      if (res.status === 401 || res.status === 403 || (res.status === 400 && KEY_REFUSED.test(reason))) {
        return { rotate: { cooldownMs: 15 * 60_000, reason: `ditolak (${res.status})`, invalid: true } };
      }
      if (res.status >= 500) return { rotate: { cooldownMs: 2_000, reason: `server error (${res.status})` } };
      return { fail: new LlmError('UNAVAILABLE', `Gemini menolak permintaan ke ${model}: ${reason}`) };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    configured: async () => deps.keys.pool.size() > 0,
    async chat(input) {
      if (!deps.keys.pool.size()) throw new LlmError('NOT_CONFIGURED', 'API key Gemini belum diisi. Isi di Pengaturan › Provider › Gemini.');
      const chosen = (await deps.chosenModel?.()) || DEFAULT_GEMINI_MODEL;
      const chain = input.fallback === false ? [chosen] : [...new Set([chosen, ...(deps.models ?? GEMINI_FALLBACK_MODELS)])];
      const reasons: string[] = [];
      for (const model of chain) {
        if (input.signal?.aborted) throw new LlmError('UNAVAILABLE', CANCELLED);
        try {
          return await deps.keys.pool.run<ChatOutput>(key => attempt(key.key, model, input), { scope: model }); // quotas are per model
        } catch (error) {
          if (error instanceof LlmError) throw error;
          if (error instanceof PoolEmptyError) throw new LlmError('NOT_CONFIGURED', 'API key Gemini belum diisi. Isi di Pengaturan › Provider › Gemini.');
          if (error instanceof PoolBusyError) { reasons.push(`${model}: semua key sedang dibatasi`); continue; }
          throw error;
        }
      }
      throw new LlmError('UNAVAILABLE', `Gemini sedang tidak tersedia (${reasons.join('; ')}). Coba lagi sebentar.`);
    }
  };
}

export type GeminiProbe = { ok: true; models: string[] } | { ok: false; reason: string; rejected: boolean };

/** Lists the models with one key: free, and proves the key works. */
export async function probeGeminiKey(fetchImpl: FetchLike, key: string): Promise<GeminiProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetchImpl(`${GEMINI_BASE}/models`, { method: 'GET', headers: { authorization: `Bearer ${key}`, 'user-agent': USER_AGENT }, signal: controller.signal });
    const body = await readJson(res);
    if (res.ok) return { ok: true, models: (Array.isArray(body?.data) ? body.data : []).map((m: any) => String(m?.id ?? '').replace(/^models\//, '')).filter(Boolean) };
    const reason = reasonOf(body, `HTTP ${res.status}`);
    return { ok: false, reason, rejected: res.status === 401 || res.status === 403 || (res.status === 400 && KEY_REFUSED.test(reason)) };
  } catch {
    return { ok: false, reason: 'Gemini tidak bisa dihubungi', rejected: false };
  } finally {
    clearTimeout(timer);
  }
}
