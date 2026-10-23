export type PublisherPlatform = 'youtube' | 'tiktok' | 'meta';

export type PublisherStatus = {
  platform: PublisherPlatform;
  /** Client id/secret (or key) present in env. */
  configured: boolean;
  connected: boolean;
  accountLabel?: string;
  expiresAt?: string;
  needsReconnect?: boolean;
};

export type PublishInput = {
  /** Absolute server-side path to the rendered mp4/mov. */
  filePath: string;
  title: string;
  description?: string;
  /** youtube privacyStatus; tiktok maps public->PUBLIC_TO_EVERYONE else SELF_ONLY. */
  visibility?: 'public' | 'unlisted' | 'private';
  /** meta only: 'facebook' (default) or 'instagram'. */
  target?: 'facebook' | 'instagram';
};

export type PublishResult = {
  ok: true;
  platform: PublisherPlatform;
  externalId?: string;
  url?: string;
};

export class PublisherError extends Error {
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

export type FileReader = {
  statBytes(path: string): Promise<number>;
  readAll(path: string): Promise<Uint8Array>;
};
