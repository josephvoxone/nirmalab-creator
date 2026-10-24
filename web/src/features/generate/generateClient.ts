import { post, requestJson, type FetchLike } from '../../lib/api.js';

export type GeneratedFile = { ok: true; filePath: string; bytes: number; url?: string };
export type GeneratedText = { ok: true; text: string; model: string };

/** Voices the server's TTS understands; it picks the language from the voice prefix. */
export const VOICES: Array<{ id: string; label: string }> = [
  { id: 'id-ID-GadisNeural', label: 'Indonesia (Gadis)' },
  { id: 'en-US-AriaNeural', label: 'English (Aria)' }
];

export function generateApi(fetchImpl: FetchLike) {
  return {
    models: () => requestJson<{ models: string[] }>(fetchImpl, '/api/generate/models'),
    /** `system` is an optional brief the server passes to the LLM; absent keys are not sent. */
    text: (input: { prompt: string; model?: string; system?: string }) =>
      requestJson<GeneratedText>(fetchImpl, '/api/generate/text', post({
        prompt: input.prompt,
        ...(input.system ? { system: input.system } : {}),
        ...(input.model ? { model: input.model } : {})
      })),
    tts: (input: { text: string; voice: string }) => requestJson<GeneratedFile>(fetchImpl, '/api/generate/tts', post(input)),
    image: (prompt: string) => requestJson<GeneratedFile>(fetchImpl, '/api/generate/image', post({ prompt }))
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Only a server-provided URL is playable; a server-side path is not reachable from the browser. */
export function mediaSrc(file: GeneratedFile): string | undefined {
  return typeof file.url === 'string' && file.url.startsWith('/') ? file.url : undefined;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Terjadi kesalahan';
}
