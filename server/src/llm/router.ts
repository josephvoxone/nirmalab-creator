/**
 * Text provider routing: OpenCode Go and Gemini behind one `TextModel`. The primary is tried first; an
 * unavailable / garbled answer falls back to the other; a provider without a key is skipped. `limitedModel`
 * bounds how many model calls run at once (with many users the providers' rate limits are the real ceiling).
 */
import { join } from 'node:path';
import { FairQueue, QueueFullError } from '../lib/fair-queue.js';
import { readPrivateJsonFile, writePrivateJsonFile } from '../lib/private-json-file.js';
import { ProviderInputError } from '../providers/config.js';
import { isGeminiModel } from './gemini.js';
import { LlmError, type ChatInput, type ChatOutput, type TextModel } from './opencode.js';

export type TextPrimary = 'opencode-go' | 'gemini';
export type TextRouting = { primary: TextPrimary; geminiModel?: string };
export type TextRoutingPatch = { primary?: string; geminiModel?: string | null };

export class TextRoutingStore {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(dataDir: string) { this.path = join(dataDir, 'providers', 'text-routing.json'); }

  async view(): Promise<TextRouting> {
    let raw: Partial<TextRouting> = {};
    try { raw = ((await readPrivateJsonFile(this.path)) as Partial<TextRouting> | undefined) ?? {}; } catch { raw = {}; }
    return { primary: raw.primary === 'gemini' ? 'gemini' : 'opencode-go', ...(isGeminiModel(raw.geminiModel) ? { geminiModel: raw.geminiModel } : {}) };
  }

  async patch(patch: TextRoutingPatch): Promise<TextRouting> {
    if (patch.primary !== undefined && patch.primary !== 'opencode-go' && patch.primary !== 'gemini') throw new ProviderInputError('primary harus opencode-go atau gemini');
    if (typeof patch.geminiModel === 'string' && !isGeminiModel(patch.geminiModel)) throw new ProviderInputError('Nama model Gemini tidak valid (contoh: gemini-3.8-flash)');
    const run = this.queue.then(async () => {
      const next = { ...(await this.view()) } as TextRouting;
      if (patch.primary === 'opencode-go' || patch.primary === 'gemini') next.primary = patch.primary;
      if (patch.geminiModel === null) delete next.geminiModel; else if (typeof patch.geminiModel === 'string') next.geminiModel = patch.geminiModel;
      await writePrivateJsonFile(this.path, next);
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

export function createRoutedModel(deps: { opencode: TextModel; gemini: TextModel; routing: () => Promise<TextRouting> }): TextModel {
  return {
    configured: async () => (await deps.opencode.configured()) || (await deps.gemini.configured()),
    async chat(input: ChatInput): Promise<ChatOutput> {
      const { primary } = await deps.routing();
      const order = primary === 'gemini' ? [deps.gemini, deps.opencode] : [deps.opencode, deps.gemini];
      let first: LlmError | undefined;
      let tried = 0;
      for (const model of order) {
        if (input.signal?.aborted) throw first ?? new LlmError('UNAVAILABLE', 'Permintaan ke model teks dibatalkan.');
        if (!(await model.configured())) continue;
        tried++;
        try {
          return await model.chat(input);
        } catch (error) {
          if (!(error instanceof LlmError)) throw error;
          if (error.code === 'NOT_CONFIGURED') { tried--; continue; }
          first ??= error;
          if (input.fallback === false || input.signal?.aborted) throw first;
        }
      }
      if (first) throw first;
      if (!tried) throw new LlmError('NOT_CONFIGURED', 'Belum ada API key model teks. Isi OpenCode Go atau Gemini di Pengaturan › Provider.');
      throw new LlmError('UNAVAILABLE', 'Model teks sedang tidak tersedia.');
    }
  };
}

/** At most `queue`'s concurrency model calls at once; the rest wait; a very long line is refused with a plain message. */
export function limitedModel(model: TextModel, queue: FairQueue, owner = 'llm'): TextModel {
  return {
    configured: () => model.configured(),
    async chat(input: ChatInput): Promise<ChatOutput> {
      try {
        return await queue.run(owner, () => model.chat(input), input.signal ? { signal: input.signal } : {});
      } catch (error) {
        if (error instanceof QueueFullError) throw new LlmError('UNAVAILABLE', 'Layanan model teks sedang ramai. Coba lagi sebentar.');
        if ((error as Error)?.name === 'AbortError') throw new LlmError('UNAVAILABLE', 'Permintaan ke model teks dibatalkan.');
        throw error;
      }
    }
  };
}
