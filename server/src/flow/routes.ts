import { sniffMediaType } from '../lib/media-type.js';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAdmin } from '../auth/routes.js';
import { MediaCache, sendImage } from '../media/images.js';
import type { UserAuthStore } from '../auth/store.js';
import { usdLabel } from '../providers/catalog.js';
import { AXCEL_MODELS, isAxcelModel } from '../providers/axcel.js';
import { isModelId } from '../providers/config.js';
import { FLOW_ROTATIONS, FlowInputError, FlowStore, type FlowAccountPatch, type FlowRotation } from './store.js';

export type FlowRouteOptions = {
  userAuthStore: UserAuthStore;
  dataDir: string;
  /** Shared store (must point at `<dataDir>/flow`). */
  store?: FlowStore;
  /**
   * Shared secret for the Mac-side Flow bridge. When unset, the token is read from
   * `<dataDir>/flow/bridge-token` (0600) on every request so it can be rotated
   * without a redeploy. With neither, bridge routes always answer 401.
   */
  bridgeToken?: string;
  /** Studio OpenRouter budget: price of one clip of a model and the key's balance (unknown → no check). */
  openRouter?: {
    usdPerClip: (model: string) => Promise<number | null>;
    balance: () => Promise<{ remainingUsd: number | null } | null>;
  };
  /** Thumbnail cache for `GET /api/flow/jobs/:id/file?w=` (image jobs). */
  media?: MediaCache;
};

const MIN_CLIP_BYTES = 1024;
const MAX_CLIP_BYTES = 200 * 1024 * 1024;
const JOB_ID = /^job_[a-f0-9]{16}$/;

function tokenMatches(expected: string | undefined, provided: unknown): boolean {
  if (!expected || typeof provided !== 'string' || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

function bad(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

export async function registerFlowRoutes(server: FastifyInstance, options: FlowRouteOptions): Promise<void> {
  const flowDir = join(options.dataDir, 'flow');
  const clipsDir = join(flowDir, 'clips');
  // One shared instance per process: two instances on one file race (separate serialise queues).
  const store = options.store ?? new FlowStore(flowDir);
  const media = options.media ?? new MediaCache({ dataDir: options.dataDir });
  const auth = options.userAuthStore;

  const tokenFile = join(flowDir, 'bridge-token');
  const currentBridgeToken = (): string | undefined => {
    if (options.bridgeToken) return options.bridgeToken;
    try {
      const value = readFileSync(tokenFile, 'utf8').trim();
      return value.length >= 24 ? value : undefined;
    } catch {
      return undefined;
    }
  };

  const requireBridge = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (tokenMatches(currentBridgeToken(), request.headers['x-flow-bridge-token'])) return true;
    void bad(reply, 401, 'UNAUTHORIZED', 'Invalid bridge token');
    return false;
  };

  // ---------- admin (session cookie)
  server.get('/api/flow/accounts', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    return { accounts: await store.listAccounts(), bridge: await store.bridgeStatus() };
  });

  server.post<{ Body: { label?: unknown; email?: unknown; profileDir?: unknown; proxy?: unknown } }>(
    '/api/flow/accounts',
    async (request, reply) => {
      if (!requireAdmin(auth, request, reply)) return undefined;
      const label = typeof request.body?.label === 'string' ? request.body.label : '';
      const email = typeof request.body?.email === 'string' ? request.body.email : '';
      if (!label.trim()) return bad(reply, 400, 'INVALID_INPUT', 'label is required');
      try {
        const account = await store.addAccount({
          label,
          email,
          ...(typeof request.body?.profileDir === 'string' && request.body.profileDir.trim()
            ? { profileDir: request.body.profileDir.trim() } : {}),
          ...(typeof request.body?.proxy === 'string' && request.body.proxy.trim()
            ? { proxy: request.body.proxy.trim() } : {})
        });
        return { account };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed';
        return bad(reply, /duplicate/i.test(message) ? 409 : 400, 'INVALID_INPUT', message);
      }
    }
  );

  server.delete<{ Params: { id: string } }>('/api/flow/accounts/:id', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const removed = await store.removeAccount(request.params.id);
    return removed ? { ok: true } : bad(reply, 404, 'NOT_FOUND', 'Account not found');
  });

  server.patch<{ Params: { id: string }; Body: Record<string, unknown> | undefined }>('/api/flow/accounts/:id', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const patch: FlowAccountPatch = {};
    if ('label' in body) {
      if (typeof body.label !== 'string') return bad(reply, 400, 'INVALID_INPUT', 'label must be a string');
      patch.label = body.label;
    }
    if ('enabled' in body) {
      if (typeof body.enabled !== 'boolean') return bad(reply, 400, 'INVALID_INPUT', 'enabled must be true or false');
      patch.enabled = body.enabled;
    }
    if ('priority' in body) {
      if (typeof body.priority !== 'number' || !Number.isInteger(body.priority)) {
        return bad(reply, 400, 'INVALID_INPUT', 'priority must be an integer');
      }
      patch.priority = body.priority;
    }
    if ('dailyCreditCap' in body) {
      const cap = body.dailyCreditCap;
      if (cap !== null && (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 0)) {
        return bad(reply, 400, 'INVALID_INPUT', 'dailyCreditCap must be a whole number ≥ 0, or null for no cap');
      }
      patch.dailyCreditCap = cap as number | null;
    }
    if (Object.keys(patch).length === 0) {
      return bad(reply, 400, 'INVALID_INPUT', 'Nothing to update (label, enabled, priority, dailyCreditCap)');
    }
    try {
      const account = await store.updateAccount(request.params.id, patch);
      return account ? { account } : bad(reply, 404, 'NOT_FOUND', 'Account not found');
    } catch (error) {
      if (!(error instanceof FlowInputError)) throw error;
      return bad(reply, /duplicate/i.test(error.message) ? 409 : 400, 'INVALID_INPUT', error.message);
    }
  });

  server.get('/api/flow/pool', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    return { pool: await store.getPool() };
  });

  server.put<{ Body: { rotation?: unknown } | undefined }>('/api/flow/pool', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const rotation = request.body?.rotation;
    if (typeof rotation !== 'string' || !FLOW_ROTATIONS.includes(rotation as FlowRotation)) {
      return bad(reply, 400, 'INVALID_INPUT', `rotation must be one of ${FLOW_ROTATIONS.join(', ')}`);
    }
    return { pool: await store.setPool({ rotation: rotation as FlowRotation }) };
  });

  server.get<{ Querystring: { days?: string } }>('/api/flow/usage', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const parsed = Number.parseInt(String(request.query?.days ?? ''), 10);
    const report = await store.usage({ days: Number.isFinite(parsed) ? parsed : 7 });
    return {
      ...report,
      byMember: report.byMember.map(m => {
        const email = m.userId === 'unknown' ? undefined : auth.findUserById(m.userId)?.email;
        return email ? { userId: m.userId, email, jobs: m.jobs, done: m.done, credits: m.credits } : m;
      })
    };
  });

  server.get('/api/flow/jobs', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    return { jobs: await store.listJobs() };
  });

  server.post<{ Body: { prompt?: unknown; technique?: unknown; aspect?: unknown; durationSec?: unknown; kind?: unknown; provider?: unknown; model?: unknown; force?: unknown } }>(
    '/api/flow/jobs',
    async (request, reply) => {
      const user = requireAdmin(auth, request, reply);
      if (!user) return undefined;
      const prompt = typeof request.body?.prompt === 'string' ? request.body.prompt : '';
      if (!prompt.trim()) return bad(reply, 400, 'INVALID_INPUT', 'prompt is required');
      const provider = request.body?.provider ?? 'flow';
      if (provider !== 'flow' && provider !== 'openrouter' && provider !== 'axcel') return bad(reply, 400, 'INVALID_INPUT', 'provider must be flow, openrouter or axcel');
      if (provider === 'openrouter' && !isModelId(request.body?.model)) {
        return bad(reply, 400, 'INVALID_INPUT', 'model is required for provider openrouter (e.g. google/veo-3.1-fast)');
      }
      if (provider === 'axcel' && !isAxcelModel(request.body?.model)) {
        return bad(reply, 400, 'INVALID_INPUT', `model is required for provider axcel (one of: ${AXCEL_MODELS.join(', ')})`);
      }
      if (provider === 'openrouter' && request.body?.kind !== 'image' && request.body?.force !== true && options.openRouter) {
        const [price, balance] = await Promise.all([
          options.openRouter.usdPerClip(request.body!.model as string).catch(() => null),
          options.openRouter.balance().catch(() => null)
        ]);
        const remaining = balance?.remainingUsd;
        if (typeof price === 'number' && typeof remaining === 'number' && price > remaining) {
          return bad(reply, 402, 'BUDGET', `Butuh ±${usdLabel(price)}, saldo OpenRouter ${usdLabel(remaining)}`);
        }
      }
      const job = await store.createJob({
        ...(provider === 'flow' ? {} : { provider, model: request.body!.model as string }),
        prompt,
        // Studio queues stills or clips; character/keyframe jobs belong to stories only.
        kind: request.body?.kind === 'image' ? 'image' : 'video',
        aspect: request.body?.aspect === '16:9' ? '16:9' : '9:16',
        ...(typeof request.body?.durationSec === 'number' ? { durationSec: request.body.durationSec } : {}),
        ...(typeof request.body?.technique === 'string' && request.body.technique.trim()
          ? { technique: request.body.technique.trim().slice(0, 120) } : {}),
        createdBy: user.id
      });
      return { job };
    }
  );

  server.get<{ Params: { id: string } }>('/api/flow/jobs/:id/file', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    if (!JOB_ID.test(request.params.id)) return bad(reply, 404, 'NOT_FOUND', 'Job not found');
    const job = await store.getJob(request.params.id);
    if (!job || job.status !== 'done') return bad(reply, 404, 'NOT_FOUND', 'Clip not ready');
    const path = join(clipsDir, `${job.id}.${job.kind === 'video' ? 'mp4' : 'png'}`);
    const query = request.query as Record<string, unknown> | undefined;
    if (job.kind === 'video' && query?.w !== undefined) return bad(reply, 400, 'INVALID_INPUT', 'w is for image jobs only');
    try {
      if (job.kind !== 'video') {
        await stat(path);
        return await sendImage(request, reply, path, media);
      }
      const info = await stat(path);
      reply.header('Content-Type', sniffMediaType(path));
      reply.header('Content-Length', String(info.size));
      reply.header('Cache-Control', 'private, max-age=3600');
      return reply.send(createReadStream(path));
    } catch {
      return bad(reply, 404, 'NOT_FOUND', 'Clip file missing');
    }
  });

  // ---------- bridge (shared token, Mac-side worker)
  await server.register(async scope => {
    scope.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: MAX_CLIP_BYTES },
      (_request, body, done) => done(null, body)
    );

    scope.post<{ Body: { bridgeId?: unknown } }>('/api/flow/bridge/claim', async (request, reply) => {
      if (!requireBridge(request, reply)) return undefined;
      const bridgeId = typeof request.body?.bridgeId === 'string' ? request.body.bridgeId : 'bridge';
      const job = await store.claimJob(bridgeId);
      if (!job) return reply.code(204).send();
      const account = job.accountId ? await store.getAccount(job.accountId) : undefined;
      return {
        job,
        account: account === undefined ? undefined : {
          id: account.id,
          label: account.label,
          ...(account.profileDir === undefined ? {} : { profileDir: account.profileDir }),
          ...(account.proxy === undefined ? {} : { proxy: account.proxy })
        }
      };
    });

    scope.post<{ Params: { id: string }; Body: Buffer }>('/api/flow/bridge/jobs/:id/complete', async (request, reply) => {
      if (!requireBridge(request, reply)) return undefined;
      if (!JOB_ID.test(request.params.id)) return bad(reply, 404, 'NOT_FOUND', 'Job not found');
      const job = await store.getJob(request.params.id);
      if (!job || job.status !== 'running') return bad(reply, 409, 'INVALID_STATE', 'Job is not running');
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.byteLength < MIN_CLIP_BYTES) {
        return bad(reply, 400, 'INVALID_INPUT', 'Clip body missing or too small');
      }
      await mkdir(clipsDir, { recursive: true, mode: 0o700 });
      const ext = job.kind === 'video' ? 'mp4' : 'png';
      const filePath = join(clipsDir, `${job.id}.${ext}`);
      await writeFile(filePath, body, { mode: 0o600 });
      const header = (name: string) => {
        const v = request.headers[name];
        const raw = typeof v === 'string' ? v : undefined;
        if (!raw) return undefined;
        try { return decodeURIComponent(raw).slice(0, 200); } catch { return raw.slice(0, 200); }
      };
      const result = {
        ...(header('x-flow-media-id') ? { mediaId: header('x-flow-media-id') } : {}),
        ...(header('x-flow-caption') ? { caption: header('x-flow-caption') } : {}),
        ...(header('x-flow-character-id') ? { flowCharacterId: header('x-flow-character-id') } : {})
      };
      // The bridge reports which engine produced the file (Flow today, Axcel through the same
      // upload path); anything unknown falls back to the job's own provider.
      const claimed = String(request.headers['x-nirmalab-provider'] || '');
      const provider = claimed === 'axcel' || claimed === 'openrouter' ? claimed : 'flow';
      const updated = await store.completeJob(job.id, { filePath, bytes: body.byteLength, provider, ...(Object.keys(result).length ? { result } : {}) });
      return { job: updated };
    });

    scope.post<{ Params: { id: string }; Body: { error?: unknown; cooldownMs?: unknown } }>(
      '/api/flow/bridge/jobs/:id/fail',
      async (request, reply) => {
        if (!requireBridge(request, reply)) return undefined;
        const job = await store.getJob(request.params.id);
        if (!job) return bad(reply, 404, 'NOT_FOUND', 'Job not found');
        const error = typeof request.body?.error === 'string' ? request.body.error : 'Bridge failure';
        const cooldownMs = typeof request.body?.cooldownMs === 'number' ? request.body.cooldownMs : 0;
        if (job.accountId && cooldownMs > 0) {
          await store.coolDown(job.accountId, Math.min(cooldownMs, 24 * 3_600_000), error);
        }
        const updated = await store.failJob(job.id, error);
        return { job: updated };
      }
    );

    scope.post<{ Body: { bridgeId?: unknown; accounts?: unknown } }>('/api/flow/bridge/heartbeat', async (request, reply) => {
      if (!requireBridge(request, reply)) return undefined;
      const bridgeId = typeof request.body?.bridgeId === 'string' ? request.body.bridgeId : 'bridge';
      const raw = Array.isArray(request.body?.accounts) ? request.body.accounts : [];
      const credits = raw
        .filter((a): a is { id: string; credits: number } =>
          typeof a === 'object' && a !== null && typeof (a as { id?: unknown }).id === 'string'
          && typeof (a as { credits?: unknown }).credits === 'number')
        .slice(0, 50);
      await store.heartbeat(bridgeId, credits);
      return { ok: true, accounts: await store.listAccounts() };
    });
  });
}
