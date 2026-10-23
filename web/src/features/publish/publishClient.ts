import { post, requestJson, type FetchLike } from '../../lib/api.js';

export type Platform = 'youtube' | 'tiktok' | 'meta';
export type Visibility = 'unlisted' | 'public' | 'private';

export type PublisherStatus = {
  platform: Platform;
  configured: boolean;
  connected: boolean;
  accountLabel?: string;
  expiresAt?: string;
  needsReconnect?: boolean;
};

export type StorySummary = { id: string; title: string; status: string; video?: { bytes: number } };
export type PublishResult = { ok: true; platform: Platform; externalId?: string; url?: string };

export const PLATFORM_LABEL: Record<Platform, string> = { youtube: 'YouTube', tiktok: 'TikTok', meta: 'Meta' };

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  unlisted: 'Tidak publik (unlisted)',
  public: 'Publik',
  private: 'Pribadi'
};

export function publishApi(fetchImpl: FetchLike) {
  return {
    status: () => requestJson<{ publishers: PublisherStatus[] }>(fetchImpl, '/api/publish/status'),
    connect: (platform: Platform) => requestJson<{ url: string }>(fetchImpl, `/api/publish/${platform}/connect`, post({})),
    disconnect: (platform: Platform) => requestJson<{ ok: boolean }>(fetchImpl, `/api/publish/${platform}/disconnect`, post({})),
    stories: () => requestJson<{ stories: StorySummary[] }>(fetchImpl, '/api/stories'),
    publish: (platform: Platform, input: { storyId: string; title: string; description: string; visibility: Visibility }) =>
      requestJson<PublishResult>(fetchImpl, `/api/publish/${platform}/publish`, post(input))
  };
}

/** What the status pill says for one platform. */
export function connectionState(s: PublisherStatus): { label: string; tone: 'done' | 'pending' | 'failed' | '' } {
  if (!s.configured) return { label: 'Belum dikonfigurasi', tone: '' };
  if (s.connected && s.needsReconnect) return { label: 'Perlu sambung ulang', tone: 'failed' };
  if (s.connected) return { label: 'Terhubung', tone: 'done' };
  return { label: 'Belum terhubung', tone: 'pending' };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Terjadi kesalahan';
}
