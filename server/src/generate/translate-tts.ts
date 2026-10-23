import { FreeGenerateError, type FetchLike } from './types.js';

/**
 * Google Translate TTS (unofficial, keyless, plain HTTPS).
 * ~200 chars per request; longer text is split on sentence boundaries and
 * the ADTS MP3 frames are concatenated. Voice picked by `tl` (id/en/...).
 */
const CHUNK_LIMIT = 200;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type TranslateTtsOptions = {
  lang?: string;
  fetchImpl?: FetchLike;
};

export function splitTtsText(text: string, limit = CHUNK_LIMIT): string[] {
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length > limit) {
      for (let i = 0; i < sentence.length; i += limit) chunks.push(sentence.slice(i, i + limit));
      continue;
    }
    const last = chunks[chunks.length - 1];
    if (last !== undefined && `${last} ${sentence}`.length <= limit) chunks[chunks.length - 1] = `${last} ${sentence}`;
    else chunks.push(sentence);
  }
  return chunks;
}

export async function googleTtsMp3(text: string, options: TranslateTtsOptions = {}): Promise<Uint8Array> {
  const trimmed = text.trim();
  if (!trimmed) throw new FreeGenerateError('INVALID_INPUT', 'Text is required');
  const fetchImpl = options.fetchImpl ?? fetch;
  const lang = options.lang ?? 'id';
  const frames: Uint8Array[] = [];
  for (const chunk of splitTtsText(trimmed)) {
    const url = `https://translate.google.com/translate_tts?client=tw-ob&q=${encodeURIComponent(chunk)}&tl=${encodeURIComponent(lang)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetchImpl(url, { headers: { 'User-Agent': UA }, signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) throw new FreeGenerateError('TTS_FAILED', `Google TTS returned HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length < 100) throw new FreeGenerateError('TTS_FAILED', 'Google TTS returned empty audio');
      frames.push(bytes);
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof FreeGenerateError) throw error;
      throw new FreeGenerateError('TTS_FAILED', `Google TTS failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
    }
  }
  const total = frames.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.byteLength;
  }
  return out;
}
