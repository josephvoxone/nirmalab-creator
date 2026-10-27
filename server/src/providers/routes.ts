/** Provider settings API (admin): Flow pool summary + OpenRouter key, defaults, key test and model catalog. */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAdmin } from '../auth/routes.js';
import type { UserAuthStore } from '../auth/store.js';
import type { FlowStore } from '../flow/store.js';
import { AxcelClient, AxcelConfigStore, AxcelError, AxcelInputError, isAxcelModel } from './axcel.js';
import { OpenRouterCatalog } from './catalog.js';
import { OpenRouterError, keyBalance, type FetchLike } from './client.js';
import { OpenRouterConfigStore, ProviderInputError, isModelId, type OpenRouterPatch } from './config.js';

export type ProviderRouteOptions = {
  userAuthStore: UserAuthStore;
  dataDir: string;
  flow: FlowStore;
  fetch?: FetchLike;
  catalog?: OpenRouterCatalog;
};

const bad = (reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ error: { code, message } });

/**
 * The audit model must accept an image as input (spec §4.4). The catalog we have lists what each
 * OpenRouter model generates, so the check is one-sided and honest: a model the catalog knows as a
 * video generator is refused; anything else (a vision chat model) passes on its id shape alone.
 */
async function auditModelProblem(catalog: OpenRouterCatalog, model: string): Promise<string | undefined> {
  try {
    const { video } = await catalog.models();
    if (video.some(m => m.id === model)) return `auditModel: ${model} adalah model video, bukan model yang menerima gambar`;
  } catch {
    // Catalog offline: the id shape is all that can be checked, and that is already done.
  }
  return undefined;
}

export async function registerProviderRoutes(server: FastifyInstance, options: ProviderRouteOptions): Promise<void> {
  const auth = options.userAuthStore;
  const fetchImpl = options.fetch ?? fetch;
  const config = new OpenRouterConfigStore(options.dataDir);
  const catalog = options.catalog ?? new OpenRouterCatalog(options.dataDir, { fetch: fetchImpl });

  server.get('/api/providers', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const accounts = await options.flow.listAccounts();
    const known = accounts.filter(a => typeof a.credits === 'number');
    const axcelConfig = new AxcelConfigStore(options.dataDir);
    const axcelSettings = await axcelConfig.settings();
    let axcelHealth = null;
    let axcelError: string | undefined;
    if (axcelSettings.token) {
      try {
        axcelHealth = await new AxcelClient(fetchImpl, { url: axcelSettings.url, token: axcelSettings.token }).health(20_000);
      } catch (error) {
        axcelError = error instanceof AxcelError ? error.message : 'Axcel bridge tidak bisa dihubungi';
      }
    }
    return {
      flow: {
        accounts: accounts.length,
        credits: known.length ? known.reduce((sum, a) => sum + (a.credits ?? 0), 0) : null,
        online: (await options.flow.bridgeStatus()).online
      },
      openrouter: await config.view(),
      axcel: await axcelConfig.view(axcelHealth, axcelError)
    };
  });

  server.put<{ Body: Record<string, unknown> | undefined }>('/api/providers/axcel', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const patch: { url?: string | null; token?: string | null } = {};
    for (const key of ['url', 'token'] as const) {
      if (!(key in body)) continue;
      const value = body[key];
      if (value !== null && typeof value !== 'string') return bad(reply, 400, 'INVALID_INPUT', `${key} harus berupa teks atau null`);
      patch[key] = value as string | null;
    }
    const axcelConfig = new AxcelConfigStore(options.dataDir);
    try {
      const view = await axcelConfig.update(patch);
      const settings = await axcelConfig.settings();
      if (!settings.token) return view;
      try {
        const health = await new AxcelClient(fetchImpl, { url: settings.url, token: settings.token }).health(60_000);
        return await axcelConfig.view(health);
      } catch (error) {
        return await axcelConfig.view(null, error instanceof AxcelError ? error.message : 'Axcel bridge tidak bisa dihubungi');
      }
    } catch (error) {
      if (error instanceof AxcelInputError) return bad(reply, 400, 'INVALID_INPUT', error.message);
      throw error;
    }
  });

  server.post('/api/providers/axcel/test', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const settings = await new AxcelConfigStore(options.dataDir).settings();
    if (!settings.token) return bad(reply, 400, 'NOT_CONFIGURED', 'Token bridge Axcel belum diisi');
    try {
      return { ok: true, health: await new AxcelClient(fetchImpl, { url: settings.url, token: settings.token }).health() };
    } catch (error) {
      return bad(reply, 400, 'AXCEL_FAILED', error instanceof AxcelError ? error.message : 'Axcel bridge tidak bisa dihubungi');
    }
  });

  server.get('/api/providers/axcel/models', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const settings = await new AxcelConfigStore(options.dataDir).settings();
    if (!settings.token) return bad(reply, 400, 'NOT_CONFIGURED', 'Token bridge Axcel belum diisi');
    try {
      const models = await new AxcelClient(fetchImpl, { url: settings.url, token: settings.token }).models();
      return { models: models.filter(m => isAxcelModel(m.id)) };
    } catch (error) {
      return bad(reply, 502, 'UPSTREAM', error instanceof AxcelError ? error.message : 'Katalog Axcel tidak bisa dimuat');
    }
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
    if ('auditModel' in body) {
      const value = body.auditModel;
      if (value !== null && !isModelId(value)) return bad(reply, 400, 'INVALID_INPUT', 'auditModel harus berupa model id atau null');
      if (typeof value === 'string') {
        const problem = await auditModelProblem(catalog, value);
        if (problem) return bad(reply, 400, 'INVALID_INPUT', problem);
      }
      patch.auditModel = value as string | null;
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
