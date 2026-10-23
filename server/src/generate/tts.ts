import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { googleTtsMp3 } from './translate-tts.js';
import { FreeGenerateError, type TtsRequest } from './types.js';

const MAX_CHARS = 5_000;

export type TtsRunner = (text: string, options?: { voice?: string; rate?: string; pitch?: string }) => Promise<Uint8Array>;

/** Indonesian default voice; override per request. */
export const DEFAULT_ID_VOICE = 'id-ID-GadisNeural';
export const DEFAULT_EN_VOICE = 'en-US-AriaNeural';

export async function synthesizeTts(
  request: TtsRequest,
  outDir: string,
  run: TtsRunner = defaultRunner,
  now: () => number = Date.now
): Promise<{ filePath: string; bytes: number }> {
  const text = request.text.trim();
  if (!text) throw new FreeGenerateError('INVALID_INPUT', 'Text is required');
  if (text.length > MAX_CHARS) throw new FreeGenerateError('INVALID_INPUT', `Text exceeds ${MAX_CHARS} chars`);
  const audio = await run(text, { voice: request.voice ?? DEFAULT_ID_VOICE, rate: request.rate, pitch: request.pitch });
  if (!audio.byteLength) throw new FreeGenerateError('TTS_FAILED', 'Edge TTS returned empty audio');
  await mkdir(outDir, { recursive: true });
  const filePath = join(outDir, `tts-${now()}-${Math.floor(Math.random() * 1e6)}.mp3`);
  await writeFile(filePath, audio);
  return { filePath, bytes: audio.byteLength };
}

async function defaultRunner(text: string, options?: { voice?: string; rate?: string; pitch?: string }): Promise<Uint8Array> {
  // Google TTS voices are picked by language: id-ID-* -> id, en-US-* -> en.
  const voice = options?.voice ?? '';
  const lang = /^en/i.test(voice) ? 'en' : 'id';
  void options?.rate;
  void options?.pitch;
  return googleTtsMp3(text, { lang });
}
