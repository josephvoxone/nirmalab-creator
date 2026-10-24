import type { FastifyInstance, FastifyReply } from 'fastify';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { sniffMediaType } from '../lib/media-type.js';
import { requireAdmin, sessionUser } from '../auth/routes.js';
import type { UserAuthStore } from '../auth/store.js';
import { draftStoryboard, type TextGenerator } from './draft.js';
import { CATALOG } from './looks.js';
import type { CoverService } from './covers.js';
import { StoryError, type StoryService } from './service.js';
import { SHOT_ID, type Storyboard } from './storyboard.js';

const STATUS: Record<StoryError['code'], number> = { INVALID: 400, NOT_FOUND: 404, BUSY: 409, BUDGET: 409 };

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof StoryError) return reply.code(STATUS[error.code]).send({ error: { code: error.code, message: error.message } });
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(503).send({ error: { code: 'STORY_FAILED', message } });
}

function sendVideo(reply: FastifyReply, file: string, range: string | undefined) {
  if (!existsSync(file)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Video belum ada' } });
  const size = statSync(file).size;
  reply.header('content-type', 'video/mp4').header('accept-ranges', 'bytes').header('cache-control', 'private, no-cache');
  const m = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) return reply.code(416).header('content-range', `bytes */${size}`).send();
    return reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1)
      .send(createReadStream(file, { start, end }));
  }
  return reply.header('content-length', size).send(createReadStream(file));
}

function sendPng(reply: FastifyReply, file: string) {
  if (!existsSync(file)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Gambar belum ada' } });
  return reply.header('content-type', sniffMediaType(file)).header('cache-control', 'private, no-cache')
    .header('content-length', statSync(file).size).send(createReadStream(file));
}

const TOKEN = /^[A-Z][A-Z0-9_]{1,20}$/;
const notFound = (reply: FastifyReply, what = 'Shot') => reply.code(404).send({ error: { code: 'NOT_FOUND', message: `${what} not found` } });

const asBoard = (value: unknown): Storyboard => {
  if (!value || typeof value !== 'object') throw new StoryError('INVALID', 'storyboard is required');
  return value as Storyboard;
};

export async function registerStoryRoutes(
  server: FastifyInstance,
  options: { userAuthStore: UserAuthStore; stories: StoryService; generateText: TextGenerator; covers?: CoverService }
): Promise<void> {
  const { userAuthStore: auth, stories } = options;
  const member = (request: Parameters<typeof sessionUser>[1], reply: FastifyReply) => {
    const user = sessionUser(auth, request);
    if (!user) void reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
    return user;
  };

  server.get('/api/stories', async (request, reply) => {
    if (!member(request, reply)) return undefined;
    return { stories: await stories.list() };
  });

  server.post<{ Body: { storyboard?: unknown } }>('/api/stories', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    try {
      return reply.code(201).send({ story: await stories.create(asBoard(request.body?.storyboard)) });
    } catch (error) { return fail(reply, error); }
  });

  server.get('/api/stories/catalog', async (request, reply) => {
    if (!member(request, reply)) return undefined;
    return { catalog: CATALOG, covers: options.covers ? await options.covers.status() : {} };
  });

  server.get<{ Params: { id: string } }>('/api/stories/templates/:id/cover', async (request, reply) => {
    if (!member(request, reply)) return undefined;
    try {
      const file = await options.covers?.file(request.params.id);
      if (!file) return notFound(reply, 'Cover');
      return reply.header('content-type', sniffMediaType(file)).header('cache-control', 'private, max-age=300')
        .header('content-length', statSync(file).size).send(createReadStream(file));
    } catch (error) { return fail(reply, error); }
  });

  server.post<{ Params: { id: string } }>('/api/stories/templates/:id/cover', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    if (!options.covers) return reply.code(503).send({ error: { code: 'UNAVAILABLE', message: 'Covers not configured' } });
    try {
      return { cover: await options.covers.queue(request.params.id) };
    } catch (error) { return fail(reply, error); }
  });

  server.post<{ Body: { premise?: unknown; shots?: unknown; style?: unknown; template?: unknown; look?: unknown; mode?: unknown; aspect?: unknown; narrator?: unknown } }>('/api/stories/draft', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const premise = typeof request.body?.premise === 'string' ? request.body.premise.trim() : '';
    if (premise.length < 5) return reply.code(400).send({ error: { code: 'INVALID', message: 'Tulis premis cerita (min. 5 karakter)' } });
    try {
      const board = await draftStoryboard({
        premise: premise.slice(0, 2000),
        shots: typeof request.body?.shots === 'number' ? request.body.shots : undefined,
        style: typeof request.body?.style === 'string' ? request.body.style.slice(0, 400) : undefined,
        template: typeof request.body?.template === 'string' ? request.body.template : undefined,
        look: request.body?.look && typeof request.body.look === 'object' ? request.body.look as Record<string, unknown> : undefined,
        mode: request.body?.mode === 'konsisten' || request.body?.mode === 'cepat' ? request.body.mode : undefined,
        aspect: request.body?.aspect === '16:9' || request.body?.aspect === '9:16' ? request.body.aspect : undefined,
        narrator: typeof request.body?.narrator === 'string' ? request.body.narrator.slice(0, 200) : undefined
      }, options.generateText);
      return reply.code(201).send({ story: await stories.create(board) });
    } catch (error) { return fail(reply, error); }
  });

  server.get<{ Params: { id: string } }>('/api/stories/:id', async (request, reply) => {
    if (!member(request, reply)) return undefined;
    try {
      const story = (await stories.reconcile(request.params.id)) ?? (await stories.get(request.params.id));
      if (!story) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Story not found' } });
      return { story, storyboard: await stories.readStoryboard(story.id) };
    } catch (error) { return fail(reply, error); }
  });

  server.put<{ Params: { id: string }; Body: { storyboard?: unknown } }>('/api/stories/:id', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    try {
      return { story: await stories.updateStoryboard(request.params.id, asBoard(request.body?.storyboard)) };
    } catch (error) { return fail(reply, error); }
  });

  server.post<{ Params: { id: string }; Body: { force?: unknown } }>('/api/stories/:id/render', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    try {
      return { story: await stories.render(request.params.id, { force: request.body?.force === true }) };
    } catch (error) { return fail(reply, error); }
  });

  server.post<{ Params: { id: string } }>('/api/stories/:id/prepare', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    try {
      return { story: await stories.prepare(request.params.id) };
    } catch (error) { return fail(reply, error); }
  });

  server.post<{ Params: { id: string }; Body: { look?: unknown } }>('/api/stories/:id/look', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const look = request.body?.look;
    if (!look || typeof look !== 'object') return reply.code(400).send({ error: { code: 'INVALID', message: 'look is required' } });
    try {
      return { story: await stories.setLook(request.params.id, look as Record<string, unknown>) };
    } catch (error) { return fail(reply, error); }
  });

  server.get<{ Params: { id: string; shotId: string } }>('/api/stories/:id/shots/:shotId/frame', async (request, reply) => {
    if (!member(request, reply)) return undefined;
    if (!SHOT_ID.test(request.params.shotId)) return notFound(reply);
    try {
      if (!(await stories.get(request.params.id))) return notFound(reply, 'Story');
      return sendPng(reply, stories.framePath(request.params.id, request.params.shotId));
    } catch (error) { return fail(reply, error); }
  });

  server.post<{ Params: { id: string; shotId: string }; Body: { prompt?: unknown } }>('/api/stories/:id/shots/:shotId/frame', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    if (!SHOT_ID.test(request.params.shotId)) return notFound(reply);
    const prompt = typeof request.body?.prompt === 'string' && request.body.prompt.trim() ? request.body.prompt.slice(0, 2000) : undefined;
    try {
      return { story: await stories.redrawFrame(request.params.id, request.params.shotId, prompt) };
    } catch (error) { return fail(reply, error); }
  });

  server.get<{ Params: { id: string; token: string } }>('/api/stories/:id/cast/:token/image', async (request, reply) => {
    if (!member(request, reply)) return undefined;
    if (!TOKEN.test(request.params.token)) return notFound(reply, 'Character');
    try {
      if (!(await stories.get(request.params.id))) return notFound(reply, 'Story');
      return sendPng(reply, stories.castPath(request.params.id, request.params.token));
    } catch (error) { return fail(reply, error); }
  });

  server.post<{ Params: { id: string } }>('/api/stories/:id/retry', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    try {
      await stories.retry(request.params.id);
      return { story: await stories.reconcile(request.params.id) };
    } catch (error) { return fail(reply, error); }
  });

  server.delete<{ Params: { id: string } }>('/api/stories/:id', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    try {
      if (!(await stories.remove(request.params.id))) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Story not found' } });
      return { ok: true };
    } catch (error) { return fail(reply, error); }
  });

  server.get<{ Params: { id: string } }>('/api/stories/:id/video', async (request, reply) => {
    if (!member(request, reply)) return undefined;
    try {
      const story = await stories.get(request.params.id);
      if (story?.status !== 'done') return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Video belum selesai' } });
      return sendVideo(reply, stories.videoPath(story.id), request.headers.range);
    } catch (error) { return fail(reply, error); }
  });

  server.get<{ Params: { id: string; shotId: string } }>('/api/stories/:id/shots/:shotId/video', async (request, reply) => {
    if (!member(request, reply)) return undefined;
    if (!SHOT_ID.test(request.params.shotId)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Shot not found' } });
    try {
      if (!(await stories.get(request.params.id))) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Story not found' } });
      return sendVideo(reply, stories.shotPath(request.params.id, request.params.shotId), request.headers.range);
    } catch (error) { return fail(reply, error); }
  });
}
