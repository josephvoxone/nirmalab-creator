/**
 * The app's draft writer: the OpenCode Go text model when it is configured (one system + one
 * user message, no tools), otherwise Pollinations as before. A NOT_CONFIGURED or UNAVAILABLE
 * model falls back; any other error (or a caller abort) goes to the draft loop as is.
 * Shared by `POST /api/stories/draft` and MCP `create_project`.
 */
import { LlmError, type TextModel } from '../llm/opencode.js';
import type { TextGenerator } from './draft.js';

const DRAFT_MAX_TOKENS = 6000;
const DRAFT_TIMEOUT_MS = 120_000;

export function draftTextGenerator(model: TextModel | undefined, fallback: TextGenerator): TextGenerator {
  if (!model) return fallback;
  return async (system, prompt, signal) => {
    try {
      const out = await model.chat({
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        maxTokens: DRAFT_MAX_TOKENS,
        timeoutMs: DRAFT_TIMEOUT_MS,
        ...(signal ? { signal } : {})
      });
      return out.message.content;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof LlmError && (error.code === 'NOT_CONFIGURED' || error.code === 'UNAVAILABLE')) return fallback(system, prompt, signal);
      throw error;
    }
  };
}
