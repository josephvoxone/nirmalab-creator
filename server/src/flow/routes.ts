import { timingSafeEqual } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAdmin } from '../auth/routes.js';
import type { UserAuthStore } from '../auth/store.js';
import { FlowStore } from './store.js';

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

  server.get('/api/flow/jobs', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    return { jobs: await store.listJobs() };
  });

  server.post<{ Body: { prompt?: unknown; technique?: unknown; aspect?: unknown; durationSec?: unknown } }>(
    '/api/flow/jobs',
    async (request, reply) => {
      if (!requireAdmin(auth, request, reply)) return undefined;
      const prompt = typeof request.body?.prompt === 'string' ? request.body.prompt : '';
      if (!prompt.trim()) return bad(reply, 400, 'INVALID_INPUT', 'prompt is required');
      const job = await store.createJob({
        prompt,
        aspect: request.body?.aspect === '16:9' ? '16:9' : '9:16',
        ...(typeof request.body?.durationSec === 'number' ? { durationSec: request.body.durationSec } : {}),
        ...(typeof request.body?.technique === 'string' && request.body.technique.trim()
          ? { technique: request.body.technique.trim().slice(0, 120) } : {})
      });
      return { job };
    }
  );

  server.get<{ Params: { id: string } }>('/api/flow/jobs/:id/file', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    if (!JOB_ID.test(request.params.id)) return bad(reply, 404, 'NOT_FOUND', 'Job not found');
    const job = await store.getJob(request.params.id);
    if (!job || job.status !== 'done') return bad(reply, 404, 'NOT_FOUND', 'Clip not ready');
    const path = join(clipsDir, `${job.id}.mp4`);
    try {
      const info = await stat(path);
      reply.header('Content-Type', 'video/mp4');
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
      const filePath = join(clipsDir, `${job.id}.mp4`);
      await writeFile(filePath, body, { mode: 0o600 });
      const updated = await store.completeJob(job.id, { filePath, bytes: body.byteLength, provider: 'flow' });
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
