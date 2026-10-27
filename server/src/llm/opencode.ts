/**
 * OpenCode Go text model (OpenAI-compatible chat completions at `https://opencode.ai/zen/go/v1`).
 * The chosen model is tried first, then the rest of the chain: a 429, 5xx, network error or
 * 60 s timeout moves on to the next model; any other 4xx (e.g. a rejected key) stops at once.
 * The key is read from `TextModelConfigStore` per call and never logged or put in an error.
 */
import { randomBytes } from 'node:crypto';
import type { FetchLike } from '../providers/client.js';
import { TEXT_MODELS, type TextModelConfigStore } from './config.js';

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ToolSpec = { type: 'function'; function: { name: string; description: string; parameters: object } };
export type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: ToolCall[]; tool_call_id?: string };

export type ChatInput = { messages: ChatMessage[]; tools?: ToolSpec[]; maxTokens?: number; signal?: AbortSignal };
export type ChatOutput = { message: ChatMessage; model: string; usage?: { total_tokens?: number } };

export interface TextModel {
  chat(input: ChatInput): Promise<ChatOutput>;
  configured(): Promise<boolean>;
}

export type LlmErrorCode = 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'BAD_RESPONSE';
export class LlmError extends Error {
  constructor(readonly code: LlmErrorCode, message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

export const OPENCODE_GO_BASE = 'https://opencode.ai/zen/go/v1';
/** Fallback order; the stored pick goes in front of it. */
export const TEXT_CHAIN = TEXT_MODELS.slice(0, 3);
const USER_AGENT = 'nirmalab-creator/1.0 (+https://nirmalab.com)';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** `ses_<12 hex><14 alnum>`, new for every request. */
export function sessionId(): string {
  const tail = [...randomBytes(14)].map(b => ALNUM[b % ALNUM.length]).join('');
  return `ses_${randomBytes(6).toString('hex')}${tail}`;
}

/** Outcome of one model attempt: `next` = try the next model, `stop` = give up now. */
type Attempt = { ok: ChatOutput } | { next: string; bad?: boolean } | { stop: string };

const isToolCall = (v: unknown): v is ToolCall => {
  const c = v as ToolCall | undefined;
  return !!c && typeof c.id === 'string' && typeof c.function?.name === 'string' && typeof c.function?.arguments === 'string';
};

function parseReply(payload: unknown, model: string): ChatOutput | undefined {
  const body = payload as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>; usage?: { total_tokens?: unknown } } | undefined;
  const msg = body?.choices?.[0]?.message;
  if (!msg || typeof msg !== 'object') return undefined;
  const message: ChatMessage = { role: 'assistant', content: typeof msg.content === 'string' ? msg.content : '' };
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    message.tool_calls = msg.tool_calls.filter(isToolCall).map(c => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } }));
  }
  const total = body?.usage?.total_tokens;
  return { message, model, ...(typeof total === 'number' ? { usage: { total_tokens: total } } : {}) };
}

export function createOpenCodeModel(deps: { store: TextModelConfigStore; fetch: FetchLike; models?: string[]; timeoutMs?: number }): TextModel {
  const timeoutMs = deps.timeoutMs ?? 60_000;

  async function attempt(key: string, model: string, input: ChatInput): Promise<Attempt> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onAbort = () => controller.abort();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await deps.fetch(`${OPENCODE_GO_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
          'x-opencode-session': sessionId()
        },
        body: JSON.stringify({
          model,
          messages: input.messages,
          ...(input.tools?.length ? { tools: input.tools } : {}),
          ...(input.maxTokens ? { max_tokens: input.maxTokens } : {})
        }),
        signal: controller.signal
      });
      if (res.status === 429) return { next: `${model}: batas pemakaian (429)` };
      if (res.status >= 500) return { next: `${model}: server error (${res.status})` };
      if (res.status === 401 || res.status === 403) return { stop: `OpenCode Go menolak API key (${res.status}). Periksa key di Pengaturan › Provider › Model teks.` };
      if (!res.ok) return { stop: `OpenCode Go menolak permintaan ke ${model} (${res.status}).` };
      const reply = parseReply(await res.json().catch(() => undefined), model);
      return reply ? { ok: reply } : { next: `${model}: jawaban tidak terbaca`, bad: true };
    } catch {
      if (input.signal?.aborted) return { stop: 'Permintaan ke model teks dibatalkan.' };
      return { next: timedOut ? `${model}: tidak menjawab dalam ${Math.round(timeoutMs / 1000)} dtk` : `${model}: tidak bisa dihubungi` };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    configured: async () => !!(await deps.store.key()),
    async chat(input) {
      const key = await deps.store.key();
      if (!key) throw new LlmError('NOT_CONFIGURED', 'API key OpenCode Go belum diisi. Isi di Pengaturan › Provider › Model teks.');
      const { model: chosen } = await deps.store.view();
      const chain = [...new Set([chosen, ...(deps.models ?? TEXT_CHAIN)])];
      const reasons: string[] = [];
      let lastBad = false;
      for (const model of chain) {
        const result = await attempt(key, model, input);
        if ('ok' in result) return result.ok;
        if ('stop' in result) throw new LlmError('UNAVAILABLE', result.stop);
        reasons.push(result.next);
        lastBad = !!result.bad;
      }
      throw new LlmError(lastBad ? 'BAD_RESPONSE' : 'UNAVAILABLE', `Model teks sedang tidak tersedia (${reasons.join('; ')}). Coba lagi sebentar.`);
    }
  };
}
