import type { FastifyInstance, FastifyReply } from 'fastify';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { requireAdmin, sessionUser } from '../auth/routes.js';
import type { UserAuthStore } from '../auth/store.js';
import { draftStoryboard, type TextGenerator } from './draft.js';
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

const asBoard = (value: unknown): Storyboard => {
  if (!value || typeof value !== 'object') throw new StoryError('INVALID', 'storyboard is required');
  return value as Storyboard;
};

export async function registerStoryRoutes(
  server: FastifyInstance,
  options: { userAuthStore: UserAuthStore; stories: StoryService; generateText: TextGenerator }
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

  server.post<{ Body: { premise?: unknown; shots?: unknown; style?: unknown } }>('/api/stories/draft', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const premise = typeof request.body?.premise === 'string' ? request.body.premise.trim() : '';
    if (premise.length < 5) return reply.code(400).send({ error: { code: 'INVALID', message: 'Tulis premis cerita (min. 5 karakter)' } });
    try {
      const board = await draftStoryboard({
        premise: premise.slice(0, 2000),
        shots: typeof request.body?.shots === 'number' ? request.body.shots : undefined,
        style: typeof request.body?.style === 'string' ? request.body.style.slice(0, 400) : undefined
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
