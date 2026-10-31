/**
 * Project assistant routes (admin-only, like every story mutation):
 * - `GET  /api/stories/:id/assistant` → `{ turns, configured }`
 * - `POST /api/stories/:id/assistant` `{ message, attachments?, confirm?, rev? }` → text/event-stream
 * - `POST /api/stories/:id/assistant/undo/:undoId` `{ rev? }` → `{ ok, rev, attention }` or 409/404
 * One assistant operation per story: a second POST, or an undo, while a turn runs answers 409 —
 * and a POST while an undo runs too. While a turn streams, `: ping` comment lines keep proxies from
 * closing the connection (every 15 s).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { sessionUser } from '../auth/routes.js';
import type { UserAuthStore } from '../auth/store.js';
import type { TextModel } from '../llm/opencode.js';
import { StoryError, type StoryService } from '../stories/service.js';
import { BUSY_MESSAGE, UNDO_STALE_MESSAGE, type ActionContext } from './actions.js';
import {
  AssistantError, HEARTBEAT_MS, MAX_MESSAGE_CHARS, TURN_BUSY_MESSAGE, confirmPending, resolveAttachments, runPending, runTurn, startHeartbeat,
  type AssistantDeps, type Emit
} from './chat.js';
import { listTurns, markUndone } from './history.js';

const send = (reply: FastifyReply, status: number, code: string, message: string) => reply.code(status).send({ error: { code, message } });

export async function registerAssistantRoutes(
  server: FastifyInstance,
  options: {
    userAuthStore: UserAuthStore; stories: StoryService; textModel?: TextModel; price?: ActionContext['price'];
    /** Whole-turn limit (tests); default 90 s. */
    totalMs?: number;
    /** SSE keep-alive interval (tests); default 15 s. */
    heartbeatMs?: number;
  }
): Promise<void> {
  const { userAuthStore: auth, stories } = options;
  const deps: AssistantDeps = {
    stories,
    ...(options.textModel ? { model: options.textModel } : {}),
    ...(options.price ? { price: options.price } : {}),
    ...(options.totalMs ? { totalMs: options.totalMs } : {})
  };
  /** Stories with a turn, a confirmed run or an undo in flight. */
  const inFlight = new Set<string>();

  // The global gate (tenancy/ownership.ts) already refused every non-owner; the user is needed here to act as him.
  const member = (request: Parameters<typeof sessionUser>[1], reply: FastifyReply) => {
    const user = sessionUser(auth, request);
    if (!user) void reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    return user;
  };

  const exists = async (id: string) => {
    try { return !!(await stories.get(id)); } catch (error) { if (error instanceof StoryError && error.code === 'NOT_FOUND') return false; throw error; }
  };

  server.get<{ Params: { id: string } }>('/api/stories/:id/assistant', async (request, reply) => {
    if (!member(request, reply)) return undefined;
    if (!(await exists(request.params.id))) return send(reply, 404, 'NOT_FOUND', 'Story not found');
    const configured = options.textModel ? await options.textModel.configured().catch(() => false) : false;
    return { turns: await listTurns(stories.storyDir(request.params.id)), configured };
  });

  server.post<{ Params: { id: string }; Body: { message?: unknown; attachments?: unknown; confirm?: unknown; rev?: unknown } }>('/api/stories/:id/assistant', async (request, reply) => {
    const user = member(request, reply);
    if (!user) return undefined;
    const id = request.params.id;
    if (!(await exists(id))) return send(reply, 404, 'NOT_FOUND', 'Story not found');
    if (inFlight.has(id)) return send(reply, 409, 'BUSY', TURN_BUSY_MESSAGE);
    inFlight.add(id);
    let streaming = false;
    try {
      const body = request.body ?? {};
      const clientRev = typeof body.rev === 'number' ? body.rev : undefined;
      let start: (emit: Emit, signal: AbortSignal) => Promise<void>;
      if (body.confirm !== undefined && body.confirm !== null) {
        if (typeof body.confirm !== 'string' || !body.confirm) return send(reply, 400, 'INVALID', 'confirm harus id persetujuan');
        // Claim + re-plan (409 when the cost moved) before the stream; the run is pinned to the approved rev.
        const pending = await confirmPending(deps, { storyId: id, userId: user.id, pendingId: body.confirm, ...(clientRev !== undefined ? { clientRev } : {}) });
        start = emit => runPending(deps, { storyId: id, userId: user.id, pending }, emit);
      } else {
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message) return send(reply, 400, 'INVALID', 'Tulis pesan dulu');
        if (message.length > MAX_MESSAGE_CHARS) return send(reply, 400, 'INVALID', `Pesan terlalu panjang (maks ${MAX_MESSAGE_CHARS} karakter)`);
        const attachments = await resolveAttachments(stories, id, body.attachments, user.id);
        start = (emit, signal) => runTurn(deps, { storyId: id, userId: user.id, message, attachments, signal }, emit);
      }

      // From here on the answer is a stream; every failure becomes `error` + `done`, never a throw.
      streaming = true;
      reply.hijack();
      const res = reply.raw;
      const write = (chunk: string) => { if (!res.writableEnded && !res.destroyed) res.write(chunk); };
      const emit: Emit = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const controller = new AbortController();
      let stopHeartbeat: () => void = () => undefined;
      try {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          'x-content-type-options': 'nosniff'
        });
        res.on('close', () => { if (!res.writableEnded) controller.abort(); });
        stopHeartbeat = startHeartbeat(write, options.heartbeatMs ?? HEARTBEAT_MS);
        await start(emit, controller.signal);
      } catch (error) {
        request.log.warn({ err: error }, 'assistant turn failed');
        emit('error', { message: 'Asisten gagal — coba lagi.' });
        emit('done', { rev: (await stories.get(id).catch(() => undefined))?.rev ?? 0 });
      } finally {
        stopHeartbeat();
        if (!res.writableEnded) res.end();
      }
      return undefined;
    } catch (error) {
      // Only reached before the stream started (a hijacked reply never gets here: see above).
      if (!streaming && error instanceof AssistantError) return send(reply, error.status, error.code, error.message);
      throw error;
    } finally {
      inFlight.delete(id);
    }
  });

  server.post<{ Params: { id: string; undoId: string }; Body: { rev?: unknown } | undefined }>('/api/stories/:id/assistant/undo/:undoId', async (request, reply) => {
    if (!member(request, reply)) return undefined;
    const { id, undoId } = request.params;
    const record = await stories.get(id).catch(() => undefined);
    if (!record) return send(reply, 404, 'NOT_FOUND', 'Story not found');
    if (inFlight.has(id)) return send(reply, 409, 'BUSY', TURN_BUSY_MESSAGE);
    inFlight.add(id);
    try {
      const rev = typeof request.body?.rev === 'number' ? request.body.rev : record.rev;
      let outcome;
      try {
        outcome = await stories.restoreSnapshot(id, undoId, rev);
      } catch (error) {
        if (error instanceof StoryError && error.code === 'BUSY') return send(reply, 409, 'BUSY', BUSY_MESSAGE);
        throw error;
      }
      if (outcome.result === 'stale') return send(reply, 409, 'STALE', UNDO_STALE_MESSAGE);
      if (outcome.result === 'missing') return send(reply, 404, 'NOT_FOUND', 'Perubahan itu sudah tidak bisa dibatalkan.');
      await markUndone(stories.storyDir(id), undoId);
      return { ok: true, rev: (await stories.get(id))?.rev ?? rev + 1, attention: outcome.attention };
    } finally {
      inFlight.delete(id);
    }
  });
}
