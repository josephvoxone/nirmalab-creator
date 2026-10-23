import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { requireAdmin, sessionUser } from '../auth/routes.js';
import type { UserAuthStore } from '../auth/store.js';
import { AccountPoolStore } from './accounts.js';
import { createBingProvider } from './bing.js';
import { createPollinationsProvider, pollinationsEnv, pollinationsImage, pollinationsModels, pollinationsText } from './pollinations.js';
import { GenerateRouter } from './pool.js';
import { synthesizeTts } from './tts.js';

export type FreeGenerateRouteOptions = {
  userAuthStore: UserAuthStore;
  dataDir: string;
  pools?: AccountPoolStore;
  router?: GenerateRouter;
};

/**
 * Cloudflare mengganti body 502 dari origin dengan halaman error-nya sendiri,
 * sehingga klien tidak pernah melihat JSON error. Pakai 503 untuk kegagalan
 * upstream agar payload JSON lolos sampai browser.
 */
export function generateErrorStatus(code: string): number {
  if (code === 'INVALID_INPUT') return 400;
  if (code === 'NEEDS_KEY') return 402;
  if (code === 'UNAUTHORIZED') return 401;
  return 503;
}

export async function registerFreeGenerateRoutes(server: FastifyInstance, options: FreeGenerateRouteOptions): Promise<void> {
  const pools = options.pools ?? new AccountPoolStore(join(options.dataDir, 'free-generate', 'pools'));
  const router = options.router ?? new GenerateRouter();
  if (!options.router) {
    router.register(createPollinationsProvider());
    router.register(createBingProvider(pools));
  }
  const ttsDir = join(options.dataDir, 'free-generate', 'tts');
  let modelsCache: { at: number; models: string[] } | undefined;
  await registerPoolAccountRoutes(server, options, pools);

  server.get('/api/generate/status', async (request, reply) => {
    const user = sessionUser(options.userAuthStore, request);
    if (!user) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    const providers = ['pollinations', 'bing', 'kling', 'flow'] as const;
    return {
      providers: await Promise.all(providers.map(async name => ({
        name,
        registered: router.names.includes(name),
        accounts: (await pools.list(name)).map(a => ({
          id: a.id,
          label: a.label,
          usedToday: a.usedToday ?? 0,
          coolingDown: (a.cooldownUntilMs ?? 0) > Date.now()
        }))
      })))
    };
  });

  server.get('/api/generate/models', async (request, reply) => {
    const user = sessionUser(options.userAuthStore, request);
    if (!user) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    const now = Date.now();
    if (!modelsCache || now - modelsCache.at > 3_600_000) {
      try {
        modelsCache = { at: now, models: await pollinationsModels(fetch) };
      } catch (error) {
        return reply.code(generateErrorStatus('GENERATE_FAILED')).send({
          error: { code: 'GENERATE_FAILED', message: error instanceof Error ? error.message : 'Failed' }
        });
      }
    }
    return { models: modelsCache.models };
  });

  server.post<{ Body: { prompt?: unknown; model?: unknown; system?: unknown } }>('/api/generate/text', async (request, reply) => {
    if (!requireAdmin(options.userAuthStore, request, reply)) return undefined;
    const prompt = typeof request.body?.prompt === 'string' ? request.body.prompt : '';
    const model = typeof request.body?.model === 'string' ? request.body.model : undefined;
    const system = typeof request.body?.system === 'string' ? request.body.system : undefined;
    try {
      const out = await pollinationsText(
        fetch,
        { prompt, model, system, apiKey: pollinationsEnv().apiKey },
        join(options.dataDir, 'free-generate', 'texts')
      );
      return { ok: true, text: out.text, model: out.model };
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code: string }).code) : 'GENERATE_FAILED';
      return reply.code(generateErrorStatus(code)).send({
        error: { code, message: error instanceof Error ? error.message : 'Failed' }
      });
    }
  });

  server.post<{ Body: { text?: unknown; voice?: unknown } }>('/api/generate/tts', async (request, reply) => {
    if (!requireAdmin(options.userAuthStore, request, reply)) return undefined;
    const text = typeof request.body?.text === 'string' ? request.body.text : '';
    const voice = typeof request.body?.voice === 'string' ? request.body.voice : undefined;
    try {
      const out = await synthesizeTts({ text, voice }, ttsDir);
      return { ok: true, filePath: out.filePath, bytes: out.bytes };
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code: string }).code) : 'TTS_FAILED';
      return reply.code(generateErrorStatus(code)).send({
        error: { code, message: error instanceof Error ? error.message : 'Failed' }
      });
    }
  });

  server.post<{ Body: { prompt?: unknown } }>('/api/generate/image', async (request, reply) => {
    if (!requireAdmin(options.userAuthStore, request, reply)) return undefined;
    const prompt = typeof request.body?.prompt === 'string' ? request.body.prompt : '';
    try {
      const out = await pollinationsImage(fetch, { prompt, apiKey: pollinationsEnv().apiKey }, join(options.dataDir, 'free-generate', 'images'));
      return { ok: true, filePath: out.filePath, bytes: out.bytes };
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code: string }).code) : 'GENERATE_FAILED';
      return reply.code(generateErrorStatus(code)).send({
        error: { code, message: error instanceof Error ? error.message : 'Failed' }
      });
    }
  });

  server.post<{ Body: { prompt?: unknown; durationSec?: unknown; aspect?: unknown } }>('/api/generate/clip', async (request, reply) => {
    if (!requireAdmin(options.userAuthStore, request, reply)) return undefined;
    const prompt = typeof request.body?.prompt === 'string' ? request.body.prompt : '';
    const durationSec = typeof request.body?.durationSec === 'number' ? request.body.durationSec : undefined;
    const aspect = request.body?.aspect === '16:9' ? '16:9' : '9:16';
    try {
      const out = await router.generate(
        { prompt, durationSec, aspect },
        { outDir: join(options.dataDir, 'free-generate', 'clips'), pools }
      );
      return out;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code: string }).code) : 'GENERATE_FAILED';
      return reply.code(generateErrorStatus(code)).send({
        error: { code, message: error instanceof Error ? error.message : 'Failed' }
      });
    }
  });
}

export async function registerPoolAccountRoutes(
  server: FastifyInstance,
  options: FreeGenerateRouteOptions,
  pools: AccountPoolStore
): Promise<void> {
  server.post<{ Body: { provider?: unknown; id?: unknown; label?: unknown; secret?: unknown } }>(
    '/api/generate/accounts',
    async (request, reply) => {
      if (!requireAdmin(options.userAuthStore, request, reply)) return undefined;
      const provider = typeof request.body?.provider === 'string' ? request.body.provider : '';
      const id = typeof request.body?.id === 'string' ? request.body.id.trim() : '';
      const label = typeof request.body?.label === 'string' ? request.body.label.trim() : id;
      const secret = typeof request.body?.secret === 'string' ? request.body.secret.trim() : '';
      if (!['bing', 'kling', 'flow', 'pollinations'].includes(provider) || !id || !secret) {
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'provider, id and secret are required' } });
      }
      await pools.upsert(provider, { id, label });
      await pools.saveSecret(provider, id, secret);
      return { ok: true, id };
    }
  );

  server.post<{ Body: { provider?: unknown; id?: unknown } }>('/api/generate/accounts/remove', async (request, reply) => {
    if (!requireAdmin(options.userAuthStore, request, reply)) return undefined;
    const provider = typeof request.body?.provider === 'string' ? request.body.provider : '';
    const id = typeof request.body?.id === 'string' ? request.body.id.trim() : '';
    if (!provider || !id) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'provider and id are required' } });
    }
    await pools.remove(provider, id);
    await pools.deleteSecret(provider, id);
    return { ok: true };
  });
}
