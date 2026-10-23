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
};

const PLATFORMS: PublisherPlatform[] = ['youtube', 'tiktok', 'meta'];

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
    return { publishers: await service.statuses() };
  });

  server.post<{ Params: { platform: string } }>('/api/publish/:platform/connect', async (request, reply) => {
    if (!requireAdmin(userAuthStore, request, reply)) return undefined;
    const platform = request.params.platform as PublisherPlatform;
    if (!PLATFORMS.includes(platform)) return reply.code(404).send({ error: { code: 'UNKNOWN_PLATFORM', message: 'Unknown platform' } });
    try {
      return service.connectUrl(platform);
    } catch (error) {
      return sendPublisherError(reply, error);
    }
  });

  server.get<{ Params: { platform: string }; Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/publish/:platform/callback',
    async (request, reply) => {
      const platform = request.params.platform as PublisherPlatform;
      const done = (params: string): void => {
        void reply.redirect(`${publicBaseUrl(env)}/#/settings?tab=platform-connections&publisher=${platform}&${params}`);
      };
      if (!PLATFORMS.includes(platform)) return reply.code(404).send({ error: { code: 'UNKNOWN_PLATFORM', message: 'Unknown platform' } });
      try {
        await service.handleCallback(platform, request.query);
        done('connected=1');
      } catch (error) {
        const code = error instanceof PublisherError ? error.code : 'CALLBACK_FAILED';
        done(`connected=0&error=${encodeURIComponent(code)}`);
      }
    }
  );

  server.post<{ Params: { platform: string }; Body: { filePath?: unknown; title?: unknown; description?: unknown; visibility?: unknown } }>(
    '/api/publish/:platform/publish',
    async (request, reply) => {
      if (!requireAdmin(userAuthStore, request, reply)) return undefined;
      const platform = request.params.platform as PublisherPlatform;
      if (!PLATFORMS.includes(platform)) return reply.code(404).send({ error: { code: 'UNKNOWN_PLATFORM', message: 'Unknown platform' } });
      const filePath = typeof request.body?.filePath === 'string' ? request.body.filePath : '';
      const title = typeof request.body?.title === 'string' ? request.body.title : '';
      const description = typeof request.body?.description === 'string' ? request.body.description : undefined;
      const visibility = request.body?.visibility === 'public' || request.body?.visibility === 'private' ? request.body.visibility : 'unlisted';
      if (!filePath || !title) {
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'filePath and title are required' } });
      }
      try {
        return await service.publish(platform, { filePath, title, description, visibility });
      } catch (error) {
        return sendPublisherError(reply, error);
      }
    }
  );

  server.post<{ Params: { platform: string } }>('/api/publish/:platform/disconnect', async (request, reply) => {
    if (!requireAdmin(userAuthStore, request, reply)) return undefined;
    const platform = request.params.platform as PublisherPlatform;
    if (!PLATFORMS.includes(platform)) return reply.code(404).send({ error: { code: 'UNKNOWN_PLATFORM', message: 'Unknown platform' } });
    await service.disconnect(platform);
    return { ok: true };
  });
}
