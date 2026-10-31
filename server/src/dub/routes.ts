/**
 * HTTP routes of the key pools (ElevenLabs, Gemini), the text routing and the per-story dubbing.
 * Everything that spends money or changes a story needs an admin; reading is for any signed-in member.
 * A key is accepted only after the provider proves it (or cannot be asked) and is never sent back.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { requireAdmin, sessionUser } from '../auth/routes.js';
import type { UserAuthStore } from '../auth/store.js';
import { MAX_POOL_KEYS, type PoolProvider, type ProviderKeys } from '../lib/provider-keys.js';
import { probeGeminiKey } from '../llm/gemini.js';
import type { TextRoutingStore } from '../llm/router.js';
import { ProviderInputError } from '../providers/config.js';
import { QuotaError } from '../quota/errors.js';
import { StoryError, type StoryService } from '../stories/service.js';
import { sendVideo } from '../stories/routes.js';
import { DubError, type DubErrorCode, type ElevenLabsClient } from './elevenlabs.js';
import type { DubScope, DubService } from './service.js';

const PROVIDERS: PoolProvider[] = ['elevenlabs', 'gemini'];
const DUB_STATUS: Record<DubErrorCode, number> = { NOT_CONFIGURED: 400, INVALID: 400, NOT_FOUND: 404, CONFIRM_REQUIRED: 409, REJECTED: 422, UNAVAILABLE: 503, INSUFFICIENT: 409, TOO_LONG: 409 };

export type DubRouteOptions = {
  userAuthStore: UserAuthStore;
  stories: StoryService;
  dub: DubService;
  client: ElevenLabsClient;
  keys: Record<PoolProvider, ProviderKeys>;
  routing: TextRoutingStore;
  fetch: typeof fetch;
};

function send(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof QuotaError) return reply.code(429).send(error.toBody());
  if (error instanceof DubError) return send(reply, DUB_STATUS[error.code], error.code, error.message);
  if (error instanceof ProviderInputError) return send(reply, 400, 'INVALID_INPUT', error.message);
  if (error instanceof StoryError) return send(reply, error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID' ? 400 : 409, error.code, error.message);
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return send(reply, 404, 'NOT_FOUND', 'Story tidak ditemukan');
  return send(reply, 503, 'DUB_FAILED', error instanceof Error ? error.message.slice(0, 200) : 'Gagal');
}

function parseScope(value: unknown): DubScope | undefined {
  const v = value as { kind?: unknown; sceneId?: unknown; shotIds?: unknown } | undefined;
  if (v?.kind === 'all') return { kind: 'all' };
  if (v?.kind === 'scene' && typeof v.sceneId === 'string') return { kind: 'scene', sceneId: v.sceneId };
  if (v?.kind === 'shots' && Array.isArray(v.shotIds) && v.shotIds.length <= 200 && v.shotIds.every(s => typeof s === 'string')) return { kind: 'shots', shotIds: v.shotIds as string[] };
  return undefined;
}

export async function registerDubRoutes(server: FastifyInstance, options: DubRouteOptions): Promise<void> {
  const { userAuthStore: auth, stories, dub, client, keys, routing } = options;
  const member = (request: Parameters<typeof sessionUser>[1], reply: FastifyReply) => {
    const user = sessionUser(auth, request);
    if (!user) void reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    return user;
  };
  const providerOf = (value: string): PoolProvider | undefined => (PROVIDERS as string[]).includes(value) ? value as PoolProvider : undefined;

  // ------------------------------------------------------------------ key pools

  server.get('/api/providers/keypool', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    return {
      elevenlabs: { keys: keys.elevenlabs.view(), max: MAX_POOL_KEYS },
      gemini: { keys: keys.gemini.view(), max: MAX_POOL_KEYS, ...(await routing.view()) }
    };
  });

  server.post<{ Params: { provider: string }; Body: { key?: unknown; label?: unknown } | undefined }>('/api/providers/keypool/:provider', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const provider = providerOf(request.params.provider);
    if (!provider) return send(reply, 404, 'NOT_FOUND', 'Provider tidak dikenal');
    const key = typeof request.body?.key === 'string' ? request.body.key.trim() : '';
    const label = typeof request.body?.label === 'string' ? request.body.label : undefined;
    if (key.length < 16 || key.length > 300 || /\s/.test(key)) return send(reply, 400, 'INVALID_INPUT', 'API key tidak valid');
    // Prove the key first (a free call). Refused = not stored; provider unreachable = stored, marked unverified.
    let verified = false; let limited = false; let detail: string | undefined;
    if (provider === 'elevenlabs') {
      const info = await client.probeKey(key);
      if (info.ok) { verified = true; limited = info.limited === true; }
      else if (info.rejected) return send(reply, 400, 'INVALID_KEY', 'ElevenLabs menolak API key ini. Periksa lagi key-nya.');
      else detail = info.reason;
    } else {
      const info = await probeGeminiKey(options.fetch, key);
      if (info.ok) verified = true;
      else if (info.rejected) return send(reply, 400, 'INVALID_KEY', 'Gemini menolak API key ini. Periksa lagi key-nya.');
      else detail = info.reason;
    }
    try {
      const view = await keys[provider].add({ key, ...(label !== undefined ? { label } : {}) });
      return reply.code(201).send({ key: view, verified, ...(limited ? { limited } : {}), ...(detail ? { detail } : {}) });
    } catch (error) { return fail(reply, error); }
  });

  server.delete<{ Params: { provider: string; id: string } }>('/api/providers/keypool/:provider/:id', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const provider = providerOf(request.params.provider);
    if (!provider) return send(reply, 404, 'NOT_FOUND', 'Provider tidak dikenal');
    if (keys[provider].view().find(v => v.id === request.params.id)?.source === 'env') {
      return send(reply, 409, 'MANAGED_BY_ENV', 'Key ini berasal dari environment server; hapus dari konfigurasi server, bukan dari sini.');
    }
    return (await keys[provider].remove(request.params.id)) ? { ok: true } : send(reply, 404, 'NOT_FOUND', 'Key tidak ditemukan');
  });

  server.post<{ Params: { provider: string; id: string } }>('/api/providers/keypool/:provider/:id/test', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const provider = providerOf(request.params.provider);
    if (!provider) return send(reply, 404, 'NOT_FOUND', 'Provider tidak dikenal');
    const secret = keys[provider].secretOf(request.params.id);
    if (!secret) return send(reply, 404, 'NOT_FOUND', 'Key tidak ditemukan');
    if (provider === 'elevenlabs') return client.probeKey(secret);
    return probeGeminiKey(options.fetch, secret);
  });

  server.get('/api/providers/text-routing', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    return routing.view();
  });

  server.put<{ Body: { primary?: unknown; geminiModel?: unknown } | undefined }>('/api/providers/text-routing', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const body = request.body ?? {};
    try {
      return await routing.patch({
        ...(typeof body.primary === 'string' ? { primary: body.primary } : {}),
        ...(typeof body.geminiModel === 'string' || body.geminiModel === null ? { geminiModel: body.geminiModel as string | null } : {})
      });
    } catch (error) { return fail(reply, error); }
  });

  // ------------------------------------------------------------------ voices + per-story dubbing

  server.get('/api/dub/voices', async (request, reply) => {
    if (!member(request, reply)) return undefined;
    try { return { voices: await client.voices() }; } catch (error) { return fail(reply, error); }
  });

  server.get<{ Params: { id: string } }>('/api/stories/:id/dub', async (request, reply) => {
    if (!member(request, reply)) return undefined;
    try { return { dub: await dub.state(request.params.id) }; } catch (error) { return fail(reply, error); }
  });

  server.put<{ Params: { id: string }; Body: Record<string, unknown> | undefined }>('/api/stories/:id/dub/settings', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const b = request.body ?? {};
    const voice = b.voice && typeof b.voice === 'object' ? b.voice as Record<string, unknown> : undefined;
    try {
      return { dub: await dub.updateSettings(request.params.id, {
        ...(typeof b.voiceId === 'string' || b.voiceId === null ? { voiceId: b.voiceId as string | null } : {}),
        ...(typeof b.modelId === 'string' ? { modelId: b.modelId } : {}),
        ...(typeof b.keepAmbient === 'boolean' ? { keepAmbient: b.keepAmbient } : {}),
        ...(voice ? { voice: {
          ...(typeof voice.stability === 'number' ? { stability: voice.stability } : {}),
          ...(typeof voice.similarityBoost === 'number' ? { similarityBoost: voice.similarityBoost } : {}),
          ...(typeof voice.style === 'number' ? { style: voice.style } : {}),
          ...(typeof voice.speed === 'number' ? { speed: voice.speed } : {}),
          ...(typeof voice.speakerBoost === 'boolean' ? { speakerBoost: voice.speakerBoost } : {})
        } } : {})
      }) };
    } catch (error) { return fail(reply, error); }
  });

  server.put<{ Params: { id: string; shotId: string }; Body: { text?: unknown; voiceId?: unknown } | undefined }>('/api/stories/:id/dub/shots/:shotId', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const b = request.body ?? {};
    try {
      return { dub: await dub.setShot(request.params.id, request.params.shotId, {
        ...(typeof b.text === 'string' || b.text === null ? { text: b.text as string | null } : {}),
        ...(typeof b.voiceId === 'string' || b.voiceId === null ? { voiceId: b.voiceId as string | null } : {})
      }) };
    } catch (error) { return fail(reply, error); }
  });

  server.delete<{ Params: { id: string; shotId: string } }>('/api/stories/:id/dub/shots/:shotId', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    try { return { dub: await dub.remove(request.params.id, request.params.shotId) }; } catch (error) { return fail(reply, error); }
  });

  server.post<{ Params: { id: string }; Body: { scope?: unknown; force?: unknown } | undefined }>('/api/stories/:id/dub/plan', async (request, reply) => {
    if (!member(request, reply)) return undefined;
    const scope = parseScope(request.body?.scope);
    if (!scope) return send(reply, 400, 'INVALID_INPUT', 'scope harus all, scene, atau shots');
    try { return { plan: await dub.plan(request.params.id, scope, request.body?.force === true ? { force: true } : {}) }; } catch (error) { return fail(reply, error); }
  });

  server.post<{ Params: { id: string }; Body: { scope?: unknown; confirmCredits?: unknown; force?: unknown; acceptTooLong?: unknown } | undefined }>('/api/stories/:id/dub/render', async (request, reply) => {
    const user = requireAdmin(auth, request, reply);
    if (!user) return undefined;
    const scope = parseScope(request.body?.scope);
    if (!scope) return send(reply, 400, 'INVALID_INPUT', 'scope harus all, scene, atau shots');
    const confirm = request.body?.confirmCredits;
    try {
      const state = await dub.render(request.params.id, scope, {
        owner: user.id,
        ...(typeof confirm === 'number' ? { confirmCredits: confirm } : {}),
        ...(request.body?.force === true ? { force: true } : {}),
        ...(request.body?.acceptTooLong === true ? { acceptTooLong: true } : {})
      });
      return reply.code(202).send({ dub: state });
    } catch (error) { return fail(reply, error); }
  });

  server.post<{ Params: { id: string } }>('/api/stories/:id/dub/cancel', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    try { return { dub: await dub.cancel(request.params.id) }; } catch (error) { return fail(reply, error); }
  });

  server.get<{ Params: { id: string; shotId: string } }>('/api/stories/:id/dub/shots/:shotId/audio', async (request, reply) => {
    if (!member(request, reply)) return undefined;
    try {
      await stories.readStoryboard(request.params.id);
      const file = await dub.audioPath(request.params.id, request.params.shotId);
      if (!file) return send(reply, 404, 'NOT_FOUND', 'Dubbing belum ada');
      return sendVideo(reply, file, request.headers.range, 'audio/mpeg');
    } catch (error) { return fail(reply, error); }
  });
}
