import type { FastifyInstance } from 'fastify';
import { requireAdmin, sessionUser } from '../auth/routes.js';
import type { UserAuthStore } from '../auth/store.js';
import { publicBaseUrl } from '../lib/public-url.js';
import { PublisherService } from './service.js';
import { PublisherError, type PublisherPlatform } from './types.js';

export type PublisherRouteOptions = {
  service: PublisherService;
  userAuthStore: UserAuthStore;
  env?: NodeJS.ProcessEnv;
  /**
   * Resolves a story id to the absolute path of its final video, only when the
   * story is done. Lets the browser publish by `storyId` instead of a raw path.
   */
  resolveStoryVideo?: (id: string) => Promise<string | undefined>;
  /**
   * Resolves a story id to the title + caption shown in the publish preview (P4:
   * `stories/caption.ts` writes the hook formula). Read-only; publishing stays admin.
   */
  resolveStoryPreview?: (id: string) => Promise<{ title: string; caption: string } | undefined>;
};

const STORY_ID = /^story_[a-f0-9]{16}$/;

const PLATFORMS: PublisherPlatform[] = ['youtube', 'tiktok', 'meta'];

const PLATFORM_NAME: Record<PublisherPlatform, string> = { youtube: 'YouTube', tiktok: 'TikTok', meta: 'Meta' };

/** One plain-Indonesian line for the Settings → Koneksi notice after a failed OAuth round trip. */
export function callbackErrorMessage(platform: PublisherPlatform, error: unknown): string {
  const name = PLATFORM_NAME[platform];
  const code = error instanceof PublisherError ? error.code : '';
  if (code === 'OAUTH_DENIED') return `Izin akses ditolak di ${name}. Coba hubungkan lagi dan setujui izinnya.`;
  if (code === 'INVALID_STATE' || code === 'INVALID_INPUT') return `Sesi login ${name} kedaluwarsa atau tidak lengkap. Coba hubungkan lagi.`;
  if (code === 'NOT_CONFIGURED') return `Aplikasi developer ${name} belum diatur di server.`;
  if (code === 'OAUTH_FAILED' && error instanceof Error && /no Page/i.test(error.message)) {
    return 'Akun Meta ini tidak punya Halaman Facebook untuk publish.';
  }
  return `${name} tidak bisa dihubungkan sekarang. Coba lagi sebentar.`;
}

/** Validates an optional schedule: an ISO time in the future, YouTube only. */
function parsePublishAt(platform: PublisherPlatform, value: unknown, nowMs: number): { publishAt?: string; error?: string } {
  if (value === undefined || value === null || value === '') return {};
  if (platform !== 'youtube') return { error: 'Jadwal tayang hanya didukung untuk YouTube' };
  if (typeof value !== 'string') return { error: 'publishAt harus berupa waktu ISO 8601' };
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return { error: 'publishAt harus berupa waktu ISO 8601' };
  if (ms <= nowMs) return { error: 'Jadwal tayang harus di masa depan' };
  return { publishAt: new Date(ms).toISOString() };
}

function sendPublisherError(reply: { code(n: number): { send(b: unknown): unknown } }, error: unknown): unknown {
  if (error instanceof PublisherError) {
    const status = error.code === 'NOT_CONNECTED' || error.code === 'NEEDS_RECONNECT' ? 409
      : error.code === 'NOT_CONFIGURED' ? 503
      : error.code === 'INVALID_INPUT' ? 400
      : 502;
    return reply.code(status).send({ error: { code: error.code, message: error.message } });
  }
  return reply.code(500).send({ error: { code: 'PUBLISH_FAILED', message: error instanceof Error ? error.message : 'Failed' } });
}

export async function registerPublisherRoutes(server: FastifyInstance, options: PublisherRouteOptions): Promise<void> {
  const { service, userAuthStore } = options;
  const env = options.env ?? process.env;

  server.get('/api/publish/status', async (request, reply) => {
    const user = sessionUser(userAuthStore, request);
    if (!user) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    return { publishers: await service.statuses(user.id) };
  });

  // The publish preview: title + a caption generated from the story's own facts. Read-only and
  // available to members; the publish call itself stays admin-only.
  server.get<{ Params: { storyId: string } }>('/api/publish/preview/:storyId', async (request, reply) => {
    const user = sessionUser(userAuthStore, request);
    if (!user) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    const storyId = request.params.storyId;
    if (!STORY_ID.test(storyId)) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Invalid storyId' } });
    const preview = options.resolveStoryPreview ? await options.resolveStoryPreview(storyId) : undefined;
    if (!preview) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Video cerita belum selesai' } });
    return { title: preview.title, caption: preview.caption };
  });

  server.post<{ Params: { platform: string } }>('/api/publish/:platform/connect', async (request, reply) => {
    const user = requireAdmin(userAuthStore, request, reply);
    if (!user) return undefined;
    const platform = request.params.platform as PublisherPlatform;
    if (!PLATFORMS.includes(platform)) return reply.code(404).send({ error: { code: 'UNKNOWN_PLATFORM', message: 'Unknown platform' } });
    try {
      return service.connectUrl(user.id, platform);
    } catch (error) {
      return sendPublisherError(reply, error);
    }
  });

  server.get<{ Params: { platform: string }; Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/publish/:platform/callback',
    async (request, reply) => {
      const platform = request.params.platform as PublisherPlatform;
      const done = (params: URLSearchParams): void => {
        void reply.redirect(`${publicBaseUrl(env)}/pengaturan/koneksi?${params.toString()}`);
      };
      if (!PLATFORMS.includes(platform)) return reply.code(404).send({ error: { code: 'UNKNOWN_PLATFORM', message: 'Unknown platform' } });
      try {
        await service.handleCallback(platform, request.query);
        done(new URLSearchParams({ connected: platform }));
      } catch (error) {
        done(new URLSearchParams({ platform, error: callbackErrorMessage(platform, error) }));
      }
    }
  );

  server.post<{ Params: { platform: string }; Body: { storyId?: unknown; filePath?: unknown; title?: unknown; description?: unknown; visibility?: unknown; publishAt?: unknown } }>(
    '/api/publish/:platform/publish',
    async (request, reply) => {
      // Admin only: a raw filePath is never accepted from non-admin callers.
      const user = requireAdmin(userAuthStore, request, reply);
      if (!user) return undefined;
      const platform = request.params.platform as PublisherPlatform;
      if (!PLATFORMS.includes(platform)) return reply.code(404).send({ error: { code: 'UNKNOWN_PLATFORM', message: 'Unknown platform' } });
      const schedule = parsePublishAt(platform, request.body?.publishAt, Date.now());
      if (schedule.error) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: schedule.error } });
      let filePath = '';
      if (request.body?.storyId !== undefined) {
        const storyId = request.body.storyId;
        if (typeof storyId !== 'string' || !STORY_ID.test(storyId)) {
          return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Invalid storyId' } });
        }
        const resolved = options.resolveStoryVideo ? await options.resolveStoryVideo(storyId) : undefined;
        if (!resolved) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Video cerita belum selesai' } });
        filePath = resolved;
      } else {
        // Raw server paths are never accepted from the browser: publish a finished story.
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'storyId is required' } });
      }
      const title = typeof request.body?.title === 'string' ? request.body.title : '';
      const description = typeof request.body?.description === 'string' ? request.body.description : undefined;
      const visibility = request.body?.visibility === 'public' || request.body?.visibility === 'private' ? request.body.visibility : 'unlisted';
      if (!filePath || !title) {
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'storyId (or filePath) and title are required' } });
      }
      try {
        return await service.publish(user.id, platform, {
          filePath, title, description, visibility,
          ...(schedule.publishAt ? { publishAt: schedule.publishAt } : {})
        });
      } catch (error) {
        return sendPublisherError(reply, error);
      }
    }
  );

  server.post<{ Params: { platform: string } }>('/api/publish/:platform/disconnect', async (request, reply) => {
    const user = requireAdmin(userAuthStore, request, reply);
    if (!user) return undefined;
    const platform = request.params.platform as PublisherPlatform;
    if (!PLATFORMS.includes(platform)) return reply.code(404).send({ error: { code: 'UNKNOWN_PLATFORM', message: 'Unknown platform' } });
    await service.disconnect(user.id, platform);
    return { ok: true };
  });
}
