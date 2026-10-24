import { ApiError, post, requestJson, type FetchLike } from '../../lib/api.js';
import { describeError } from '../../ui/states.js';

export type Platform = 'youtube' | 'tiktok' | 'meta';
export type Visibility = 'unlisted' | 'public' | 'private';

export type PublisherStatus = {
  platform: Platform;
  configured: boolean;
  connected: boolean;
  accountLabel?: string;
  expiresAt?: string;
  needsReconnect?: boolean;
  /** Env vars the server reads for this platform's developer app that are still empty. */
  missingEnv?: string[];
};

export type StorySummary = { id: string; title: string; status: string; video?: { bytes: number } };
export type PublishResult = { ok: true; platform: Platform; externalId?: string; url?: string };
export type PublishInput = { storyId: string; title: string; description: string; visibility: Visibility; publishAt?: string };

export const PLATFORMS: Platform[] = ['youtube', 'tiktok', 'meta'];
export const PLATFORM_LABEL: Record<Platform, string> = { youtube: 'YouTube', tiktok: 'TikTok', meta: 'Meta' };
export const PLATFORM_HINT: Record<Platform, string> = {
  youtube: 'Video ke channel YouTube.',
  tiktok: 'Video ke akun TikTok.',
  meta: 'Reels ke Halaman Facebook yang terhubung.'
};

/** What the server reads (server/src/publisher/{youtube,tiktok,meta}.ts); used if an older server sends no missingEnv. */
export const PLATFORM_ENV: Record<Platform, string[]> = {
  youtube: ['OPENCREATOR_PUBLISHER_YOUTUBE_CLIENT_ID', 'OPENCREATOR_PUBLISHER_YOUTUBE_CLIENT_SECRET'],
  tiktok: ['OPENCREATOR_PUBLISHER_TIKTOK_CLIENT_KEY', 'OPENCREATOR_PUBLISHER_TIKTOK_CLIENT_SECRET'],
  meta: ['OPENCREATOR_PUBLISHER_META_APP_ID', 'OPENCREATOR_PUBLISHER_META_APP_SECRET']
};

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  public: 'Publik',
  unlisted: 'Tidak publik',
  private: 'Pribadi'
};

/** Only YouTube honours a schedule (status.publishAt); the server refuses it elsewhere. */
export const CAN_SCHEDULE: Record<Platform, boolean> = { youtube: true, tiktok: false, meta: false };

export function publishApi(fetchImpl: FetchLike) {
  return {
    status: () => requestJson<{ publishers?: unknown }>(fetchImpl, '/api/publish/status').then(readStatuses),
    connect: (platform: Platform) => requestJson<{ url: string }>(fetchImpl, `/api/publish/${platform}/connect`, post({})),
    disconnect: (platform: Platform) => requestJson<{ ok: boolean }>(fetchImpl, `/api/publish/${platform}/disconnect`, post({})),
    stories: () => requestJson<{ stories?: unknown }>(fetchImpl, '/api/stories')
      .then(r => (Array.isArray(r?.stories) ? (r.stories as StorySummary[]) : [])),
    /** P4: the caption the preview starts from, built from the story's own facts. */
    preview: (storyId: string) => requestJson<{ title?: string; caption?: string }>(fetchImpl, `/api/publish/preview/${encodeURIComponent(storyId)}`),
    publish: (platform: Platform, input: PublishInput) =>
      requestJson<PublishResult>(fetchImpl, `/api/publish/${platform}/publish`, post(input))
  };
}

/** Reads the status list defensively: an older server or a catch-all fake can answer `{}`. */
export function readStatuses(r: { publishers?: unknown } | undefined): PublisherStatus[] {
  return Array.isArray(r?.publishers) ? (r.publishers as PublisherStatus[]).filter(s => PLATFORMS.includes(s?.platform)) : [];
}

export type ConnectionState = { kind: 'connected' | 'reconnect' | 'disconnected' | 'unconfigured'; label: string };

export function connectionState(s: PublisherStatus): ConnectionState {
  if (!s.configured) return { kind: 'unconfigured', label: 'Belum dikonfigurasi' };
  if (s.connected) return { kind: 'connected', label: s.accountLabel ? `Terhubung sebagai ${s.accountLabel}` : 'Terhubung' };
  if (s.needsReconnect) return { kind: 'reconnect', label: 'Perlu sambung ulang' };
  return { kind: 'disconnected', label: 'Belum terhubung' };
}

/** One line on what the server is missing for a platform without a developer app. */
export function missingAppText(s: PublisherStatus): string {
  const names = s.missingEnv?.length ? s.missingEnv : PLATFORM_ENV[s.platform];
  return `Server belum punya aplikasi developer ${PLATFORM_LABEL[s.platform]}: isi ${names.join(' dan ')} di env server, lalu deploy ulang.`;
}

/** Plain-Indonesian cause for a failed publish to one platform. */
export function publishErrorText(platform: Platform, error: unknown): string {
  const name = PLATFORM_LABEL[platform];
  if (error instanceof ApiError) {
    if (error.code === 'NOT_CONNECTED') return `${name} belum terhubung. Hubungkan di Pengaturan → Koneksi.`;
    if (error.code === 'NEEDS_RECONNECT') return `Sesi ${name} sudah habis. Hubungkan ulang di Pengaturan → Koneksi.`;
    if (error.code === 'NOT_CONFIGURED') return `Aplikasi developer ${name} belum diatur di server.`;
    if (error.code === 'NOT_FOUND') return 'Video cerita ini belum selesai atau sudah dihapus.';
    if (error.status === 400) return error.message;
    if (error.status === 502) return `${name} menolak unggahan: ${error.message}`;
  }
  return describeError(error);
}
