export type FreeClipRequest = {
  prompt: string;
  /** seconds, provider-clamped */
  durationSec?: number;
  aspect?: '9:16' | '16:9';
  /** absolute server path to a start/reference frame */
  startFramePath?: string;
};

export type FreeClipResult = {
  ok: true;
  /** absolute server path to the rendered mp4 */
  filePath: string;
  provider: string;
  width?: number;
  height?: number;
  durationMs?: number;
};

export type TtsRequest = {
  text: string;
  /** e.g. id-ID-GadisNeural, en-US-AriaNeural */
  voice?: string;
  rate?: string;
  pitch?: string;
};

export class FreeGenerateError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;
