/** Provider settings API (admin): Flow pool summary + OpenRouter key, defaults, key test and model catalog. */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAdmin } from '../auth/routes.js';
import type { UserAuthStore } from '../auth/store.js';
import type { FlowStore } from '../flow/store.js';
import { OpenRouterCatalog } from './catalog.js';
import { OpenRouterError, keyBalance, type FetchLike } from './client.js';
import { OpenRouterConfigStore, ProviderInputError, isModelId, type OpenRouterPatch } from './config.js';
import { TextModelConfigStore, type TextModelPatch } from '../llm/config.js';
import { LlmError, createOpenCodeModel, type TextModel } from '../llm/opencode.js';

export type ProviderRouteOptions = {
  userAuthStore: UserAuthStore;
  dataDir: string;
  flow: FlowStore;
  fetch?: FetchLike;
  catalog?: OpenRouterCatalog;
  /** OpenCode Go text model (one store instance per process; built from dataDir + fetch when omitted). */
  text?: { store: TextModelConfigStore; model: TextModel };
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
  const textStore = options.text?.store ?? new TextModelConfigStore(options.dataDir);
  const textModel = options.text?.model ?? createOpenCodeModel({ store: textStore, fetch: fetchImpl });

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

  // Model teks (OpenCode Go): key + chosen model, and a one-line connection test.
  server.get('/api/providers/text', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    return textStore.view();
  });

  server.put<{ Body: Record<string, unknown> | undefined }>('/api/providers/text', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const patch: TextModelPatch = {};
    if ('apiKey' in body) {
      if (body.apiKey !== null && typeof body.apiKey !== 'string') return bad(reply, 400, 'INVALID_INPUT', 'apiKey harus berupa teks atau null');
      patch.apiKey = body.apiKey as string | null;
    }
    if ('model' in body) {
      if (typeof body.model !== 'string') return bad(reply, 400, 'INVALID_INPUT', 'model harus berupa teks');
      patch.model = body.model;
    }
    try {
      return await textStore.patch(patch);
    } catch (error) {
      if (error instanceof ProviderInputError) return bad(reply, 400, 'INVALID_INPUT', error.message);
      throw error;
    }
  });

  server.post('/api/providers/text/test', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const started = Date.now();
    try {
      const out = await textModel.chat({ messages: [{ role: 'user', content: 'Balas satu kata: ok' }], maxTokens: 16 });
      return { ok: true, model: out.model, ms: Date.now() - started };
    } catch (error) {
      if (error instanceof LlmError) return bad(reply, error.code === 'NOT_CONFIGURED' ? 400 : 502, error.code, error.message);
      return bad(reply, 502, 'UNAVAILABLE', 'Model teks tidak bisa dihubungi');
    }
  });
}
