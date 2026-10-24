/** Provider settings API (admin): Flow pool summary + OpenRouter key, defaults, key test and model catalog. */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAdmin } from '../auth/routes.js';
import type { UserAuthStore } from '../auth/store.js';
import type { FlowStore } from '../flow/store.js';
import { OpenRouterCatalog } from './catalog.js';
import { OpenRouterError, keyBalance, type FetchLike } from './client.js';
import { OpenRouterConfigStore, ProviderInputError, type OpenRouterPatch } from './config.js';

export type ProviderRouteOptions = {
  userAuthStore: UserAuthStore;
  dataDir: string;
  flow: FlowStore;
  fetch?: FetchLike;
  catalog?: OpenRouterCatalog;
};

const bad = (reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ error: { code, message } });

export async function registerProviderRoutes(server: FastifyInstance, options: ProviderRouteOptions): Promise<void> {
  const auth = options.userAuthStore;
  const fetchImpl = options.fetch ?? fetch;
  const config = new OpenRouterConfigStore(options.dataDir);
  const catalog = options.catalog ?? new OpenRouterCatalog(options.dataDir, { fetch: fetchImpl });

  server.get('/api/providers', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const accounts = await options.flow.listAccounts();
    const known = accounts.filter(a => typeof a.credits === 'number');
    return {
      flow: {
        accounts: accounts.length,
        credits: known.length ? known.reduce((sum, a) => sum + (a.credits ?? 0), 0) : null,
        online: (await options.flow.bridgeStatus()).online
      },
      openrouter: await config.view()
    };
  });

  server.put<{ Body: Record<string, unknown> | undefined }>('/api/providers/openrouter', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const patch: OpenRouterPatch = {};
    if ('apiKey' in body) {
      if (body.apiKey !== null && typeof body.apiKey !== 'string') return bad(reply, 400, 'INVALID_INPUT', 'apiKey harus berupa teks atau null');
      patch.apiKey = body.apiKey as string | null;
    }
    if ('defaults' in body) {
      const defaults = body.defaults as Record<string, unknown> | null;
      if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return bad(reply, 400, 'INVALID_INPUT', 'defaults harus berupa object');
      patch.defaults = {};
      for (const kind of ['image', 'video'] as const) {
        if (!(kind in defaults)) continue;
        const value = defaults[kind];
        if (value !== null && typeof value !== 'string') return bad(reply, 400, 'INVALID_INPUT', `defaults.${kind} harus berupa model id atau null`);
        patch.defaults[kind] = value as string | null;
      }
    }
    try {
      return await config.update(patch);
    } catch (error) {
      if (error instanceof ProviderInputError) return bad(reply, 400, 'INVALID_INPUT', error.message);
      throw error;
    }
  });

  server.post('/api/providers/openrouter/test', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const key = await config.apiKey();
    if (!key) return bad(reply, 400, 'NOT_CONFIGURED', 'API key OpenRouter belum diisi');
    try {
      return { ok: true, balance: await keyBalance(fetchImpl, key) };
    } catch (error) {
      const message = error instanceof OpenRouterError ? error.message : 'OpenRouter tidak bisa dihubungi';
      return bad(reply, 400, 'OPENROUTER_FAILED', message);
    }
  });

  server.get('/api/providers/openrouter/models', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    try {
      return await catalog.models();
    } catch (error) {
      return bad(reply, 502, 'UPSTREAM', error instanceof Error ? error.message : 'Katalog model OpenRouter tidak bisa dimuat');
    }
  });
}
