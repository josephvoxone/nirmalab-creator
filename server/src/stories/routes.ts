import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { THUMB_WIDTHS, sendImage, sendPoster, type MediaCache } from '../media/images.js';
import { requireAdmin, sessionUser } from '../auth/routes.js';
import type { UserAuthStore } from '../auth/store.js';
import { DraftError, draftStoryboard, type TextGenerator } from './draft.js';
import { CATALOG } from './looks.js';
import type { CoverService } from './covers.js';
import { StoryError, type StoryService } from './service.js';
import { ShotCompileError } from '../bible/compiler.js';
import { SHOT_ID, compileBoardShot, validateEngine, type Shot, type Storyboard } from './storyboard.js';
import { ACTIONS, type ActionContext, type ActionResult } from '../assistant/actions.js';
import { sceneNumber } from '../assistant/resolve.js';
import { MAX_UPLOAD_BYTES, NOT_IMAGE_MESSAGE, TOO_LARGE_MESSAGE, UPLOAD_FILE, UPLOAD_TYPES, UploadError, mimeOfFile, saveUpload, uploadsDir } from '../assistant/uploads.js';
import type { TextModel } from '../llm/opencode.js';
import { MAX_MUSIC_BYTES, MUSIC_MIME, MUSIC_TOO_LARGE_MESSAGE, MUSIC_TYPES, NOT_AUDIO_MESSAGE, type MusicExt } from './music.js';

const STATUS: Record<StoryError['code'], number> = { INVALID: 400, NOT_FOUND: 404, BUSY: 409, BUDGET: 409, STALE: 409 };

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof StoryError) return reply.code(STATUS[error.code]).send({ error: { code: error.code, message: error.message } });
  const message = error instanceof Error ? error.message : String(error);
  return reply.code(503).send({ error: { code: 'STORY_FAILED', message } });
}

/** A draft that could not be written: the plain message (also what MCP create_project says); the detail goes to the log. */
function failDraft(reply: FastifyReply, error: DraftError, log: FastifyBaseLogger) {
  log.warn({ detail: error.message.slice(0, 2000) }, 'story draft failed');
  return reply.code(503).send({ error: { code: 'STORY_FAILED', message: error.plain } });
}

export function sendVideo(reply: FastifyReply, file: string, range: string | undefined, type = 'video/mp4') {
  if (!existsSync(file)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Video belum ada' } });
  const size = statSync(file).size;
  reply.header('content-type', type).header('accept-ranges', 'bytes').header('cache-control', 'private, no-cache');
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

function sendPng(request: FastifyRequest, reply: FastifyReply, file: string, media: MediaCache) {
  if (!existsSync(file)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Gambar belum ada' } });
  return sendImage(request, reply, file, media);
}

const TOKEN = /^[A-Z][A-Z0-9_]{1,20}$/;
const notFound = (reply: FastifyReply, what = 'Shot') => reply.code(404).send({ error: { code: 'NOT_FOUND', message: `${what} not found` } });

const badRequest = (reply: FastifyReply, message: string) => reply.code(400).send({ error: { code: 'INVALID', message } });

const ACTION_STATUS: Record<string, number> = { INVALID: 400, NOT_FOUND: 404, BUSY: 409, BUDGET: 409, STALE: 409, NOT_CONFIGURED: 400, UNAVAILABLE: 503, FAILED: 503 };

/** An action result over HTTP: a plain error keeps its code; `needsConfirm` is a normal 200 the UI answers with confirm. */
function sendAction(reply: FastifyReply, result: ActionResult, ok: () => Promise<Record<string, unknown>>) {
  if (result.ok) return ok().then(body => reply.send({ label: result.label, changed: result.changed ?? false, ...body }));
  if ('needsConfirm' in result) return reply.send({ needsConfirm: true, label: result.label, estimate: result.estimate });
  const code = result.code ?? 'INVALID';
  return reply.code(ACTION_STATUS[code] ?? 400).send({ error: { code, message: result.error } });
}

/** Optional `scene`/`shot` id of a partial run: absent, or a well-formed id (existence is checked by the service → 404). */
function runTarget(body: { scene?: unknown; shot?: unknown } | undefined): { scene?: string; shot?: string } | string {
  const out: { scene?: string; shot?: string } = {};
  for (const key of ['scene', 'shot'] as const) {
    const value = body?.[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !SHOT_ID.test(value)) return `${key} must be a ${key} id`;
    out[key] = value;
  }
  return out;
}

const asBoard = (value: unknown): Storyboard => {
  if (!value || typeof value !== 'object') throw new StoryError('INVALID', 'storyboard is required');
  return value as Storyboard;
};

export async function registerStoryRoutes(
  server: FastifyInstance,
  options: {
    userAuthStore: UserAuthStore; stories: StoryService; generateText: TextGenerator; covers?: CoverService; media: MediaCache;
    /** Assistant text model (scene breakdown); absent = breakdown answers that no model is set. */
    textModel?: TextModel;
    /** OpenRouter prices for spending estimates. */
    price?: ActionContext['price'];
  }
): Promise<void> {
  const { userAuthStore: auth, stories } = options;
  /** One UI click = one turn: its own snapshot, scoped to the story in the URL. */
  const uiContext = (userId: string): ActionContext => ({
    stories, snapshots: stories.snapshots, userId, source: 'ui', turn: {},
    ...(options.textModel ? { model: options.textModel } : {}), ...(options.price ? { price: options.price } : {})
  });
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
    const user = requireAdmin(auth, request, reply);
    if (!user) return undefined;
    try {
      return reply.code(201).send({ story: await stories.create(asBoard(request.body?.storyboard), { createdBy: user.id }) });
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
      return await sendImage(request, reply, file, options.media);
    } catch (error) { return fail(reply, error); }
  });

  server.post<{ Params: { id: string } }>('/api/stories/templates/:id/cover', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    if (!options.covers) return reply.code(503).send({ error: { code: 'UNAVAILABLE', message: 'Covers not configured' } });
    try {
      return { cover: await options.covers.queue(request.params.id) };
    } catch (error) { return fail(reply, error); }
  });

  server.post<{ Body: { premise?: unknown; shots?: unknown; style?: unknown; template?: unknown; look?: unknown; mode?: unknown; aspect?: unknown; narrator?: unknown; engine?: unknown } }>('/api/stories/draft', async (request, reply) => {
    const user = requireAdmin(auth, request, reply);
    if (!user) return undefined;
    const premise = typeof request.body?.premise === 'string' ? request.body.premise.trim() : '';
    if (premise.length < 5) return reply.code(400).send({ error: { code: 'INVALID', message: 'Tulis premis cerita (min. 5 karakter)' } });
    // Checked before drafting: a bad engine must not cost an LLM call.
    const engine = request.body?.engine ?? undefined;
    const engineErrors = validateEngine(engine);
    if (engineErrors.length) return badRequest(reply, engineErrors.join('; '));
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
      const drafted = engine === undefined ? board : { ...board, engine: engine as Storyboard['engine'] };
      return reply.code(201).send({ story: await stories.create(drafted, { createdBy: user.id }) });
    } catch (error) {
      if (error instanceof DraftError) return failDraft(reply, error, request.log);
      return fail(reply, error);
    }
  });

  server.get<{ Params: { id: string } }>('/api/stories/:id', async (request, reply) => {
    if (!member(request, reply)) return undefined;
    try {
      const story = (await stories.reconcile(request.params.id, { wait: false })) ?? (await stories.get(request.params.id));
      if (!story) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Story not found' } });
      return { story, storyboard: await stories.readStoryboard(story.id) };
    } catch (error) { return fail(reply, error); }
  });

  server.put<{ Params: { id: string }; Body: { storyboard?: unknown; rev?: unknown } }>('/api/stories/:id', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    // `rev` = the revision this client read; absent = no check (clients from before revisions).
    const rev = request.body?.rev ?? undefined;
    if (rev !== undefined && !(typeof rev === 'number' && Number.isInteger(rev))) return badRequest(reply, 'rev must be a number');
    try {
      return { story: await stories.updateStoryboard(request.params.id, asBoard(request.body?.storyboard), rev === undefined ? {} : { rev }) };
    } catch (error) { return fail(reply, error); }
  });

  /** Preview the compiled prompts of one shot against the saved board (nothing is saved). */
  server.post<{ Params: { id: string }; Body: { shot?: unknown } }>('/api/stories/:id/compile-shot', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const shot = request.body?.shot as Shot | undefined;
    if (!shot || typeof shot !== 'object' || Array.isArray(shot) || typeof shot.id !== 'string' || !SHOT_ID.test(shot.id)) {
      return badRequest(reply, 'shot with a valid id is required');
    }
    const intent = (shot as { intent?: unknown }).intent;
    if (intent !== undefined && (!intent || typeof intent !== 'object' || Array.isArray(intent))) return badRequest(reply, 'shot.intent must be an object');
    try {
      if (!(await stories.get(request.params.id))) return notFound(reply, 'Story');
      const board = await stories.readStoryboard(request.params.id);
      const exists = board.shots.some(s => s.id === shot.id);
      const preview: Storyboard = { ...board, shots: exists ? board.shots.map(s => (s.id === shot.id ? shot : s)) : [...board.shots, shot] };
      try {
        const compiled = compileBoardShot(preview, shot);
        return { imagePrompt: compiled.imagePrompt, videoPrompt: compiled.videoPrompt, issues: [], warnings: compiled.warnings };
      } catch (error) {
        if (error instanceof ShotCompileError) return { imagePrompt: '', videoPrompt: '', issues: error.issues, warnings: [] };
        throw error;
      }
    } catch (error) { return fail(reply, error); }
  });

  server.post<{ Params: { id: string }; Body: { force?: unknown; scene?: unknown; shot?: unknown } }>('/api/stories/:id/render', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const target = runTarget(request.body);
    if (typeof target === 'string') return badRequest(reply, target);
    // A shot is the narrower target: it wins when both are sent.
    const subset = target.shot ? { shot: target.shot } : target.scene ? { scene: target.scene } : {};
    try {
      return { story: await stories.render(request.params.id, { force: request.body?.force === true, ...subset }) };
    } catch (error) { return fail(reply, error); }
  });

  server.post<{ Params: { id: string }; Body: { scene?: unknown } }>('/api/stories/:id/prepare', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    const target = runTarget({ scene: request.body?.scene });
    if (typeof target === 'string') return badRequest(reply, target);
    try {
      return { story: await stories.prepare(request.params.id, target.scene ? { scene: target.scene } : {}) };
    } catch (error) { return fail(reply, error); }
  });

  server.post<{ Params: { id: string } }>('/api/stories/:id/assemble', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    try {
      // Returns at once; the assembly waits its turn in the shared queue and finishes in the background (the page polls).
      return reply.code(202).send({ story: await stories.startAssembly(request.params.id) });
    } catch (error) {
      // Contract: 409 INVALID while some shot is not done yet (a state conflict, not a bad body).
      if (error instanceof StoryError && error.code === 'INVALID') return reply.code(409).send({ error: { code: 'INVALID', message: error.message } });
      return fail(reply, error);
    }
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
      return await sendPng(request, reply, stories.framePath(request.params.id, request.params.shotId), options.media);
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

  server.post<{ Params: { id: string; shotId: string } }>('/api/stories/:id/shots/:shotId/repair', async (request, reply) => {
    const user = requireAdmin(auth, request, reply);
    if (!user) return undefined;
    if (!SHOT_ID.test(request.params.shotId)) return notFound(reply);
    try {
      return { story: await stories.repairShot(request.params.id, request.params.shotId, { by: user.id }) };
    } catch (error) { return fail(reply, error); }
  });

  /** Human sign-off on a shot the audit refused (spec §4.4): records who approved it. */
  server.post<{ Params: { id: string; shotId: string } }>('/api/stories/:id/shots/:shotId/approve-audit', async (request, reply) => {
    const user = requireAdmin(auth, request, reply);
    if (!user) return undefined;
    if (!SHOT_ID.test(request.params.shotId)) return notFound(reply);
    try {
      return { story: await stories.approveShot(request.params.id, request.params.shotId, { by: user.id }) };
    } catch (error) { return fail(reply, error); }
  });

  /**
   * Free motion check of the clips that are already done (projects made before the check existed). Admin only; one
   * run per story at a time; nothing is queued or spent and the project is not gated by it. Answers when it is done.
   */
  server.post<{ Params: { id: string } }>('/api/stories/:id/motion-check', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    try {
      if (!(await stories.get(request.params.id))) return notFound(reply, 'Story');
      const result = await stories.checkMotions(request.params.id);
      return { ...result, story: await stories.get(request.params.id) };
    } catch (error) { return fail(reply, error); }
  });

  server.get<{ Params: { id: string; token: string } }>('/api/stories/:id/cast/:token/image', async (request, reply) => {
    if (!member(request, reply)) return undefined;
    if (!TOKEN.test(request.params.token)) return notFound(reply, 'Character');
    try {
      if (!(await stories.get(request.params.id))) return notFound(reply, 'Story');
      return await sendPng(request, reply, stories.castPath(request.params.id, request.params.token), options.media);
    } catch (error) { return fail(reply, error); }
  });

  /** "Pecah jadi shot": the AI shot planner for one scene (same action the assistant uses). */
  server.post<{ Params: { id: string; sceneId: string }; Body: { count?: unknown; brief?: unknown; mode?: unknown } }>('/api/stories/:id/scenes/:sceneId/breakdown', async (request, reply) => {
    const user = requireAdmin(auth, request, reply);
    if (!user) return undefined;
    try {
      if (!(await stories.get(request.params.id))) return notFound(reply, 'Story');
      const ctx = uiContext(user.id);
      const body = request.body ?? {};
      // The URL names a scene id; only when no scene has that id is it read as a number ("2").
      const board = await stories.readStoryboard(request.params.id);
      const byId = sceneNumber(board, request.params.sceneId);
      const result = await ACTIONS.breakdown_scene.run(ctx, request.params.id, {
        scene: byId > 0 ? byId : request.params.sceneId,
        ...(body.count !== undefined ? { count: body.count } : {}),
        ...(body.brief !== undefined ? { brief: body.brief } : {}),
        ...(body.mode !== undefined ? { mode: body.mode } : {})
      });
      return await sendAction(reply, result, async () => ({
        undoId: ctx.turn.undoId, story: await stories.get(request.params.id), storyboard: await stories.readStoryboard(request.params.id)
      }));
    } catch (error) { return fail(reply, error); }
  });

  /** "Buat sheet": one sheet job for one character. Without `confirm: true` (the user's click) it only answers the estimate. */
  server.post<{ Params: { id: string; token: string }; Body: { confirm?: unknown; reference?: unknown; rev?: unknown } }>('/api/stories/:id/cast/:token/sheet', async (request, reply) => {
    const user = requireAdmin(auth, request, reply);
    if (!user) return undefined;
    try {
      if (!(await stories.get(request.params.id))) return notFound(reply, 'Story');
      // `rev`: the project revision the click was made on; a newer one is refused (409 STALE), nothing queued.
      const rev = request.body?.rev;
      if (rev !== undefined && (typeof rev !== 'number' || !Number.isInteger(rev))) return reply.code(400).send({ error: { code: 'INVALID', message: 'rev harus angka' } });
      const ctx: ActionContext = { ...uiContext(user.id), confirmed: request.body?.confirm === true, ...(typeof rev === 'number' ? { rev } : {}) };
      const result = await ACTIONS.make_sheet.run(ctx, request.params.id, {
        token: request.params.token,
        ...(typeof request.body?.reference === 'string' ? { reference: request.body.reference } : {})
      });
      return await sendAction(reply, result, async () => ({ story: await stories.get(request.params.id) }));
    } catch (error) { return fail(reply, error); }
  });

  // Image uploads (references, start frames): raw body, the type proven by its bytes, 10 MB.
  await server.register(async scope => {
    scope.addContentTypeParser([...UPLOAD_TYPES], { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_request, body, done) => done(null, body));
    scope.setErrorHandler((error: { statusCode?: number; message?: string }, _request, reply) => {
      if (error.statusCode === 413) return reply.code(413).send({ error: { code: 'TOO_LARGE', message: TOO_LARGE_MESSAGE } });
      if (error.statusCode === 415 || error.statusCode === 400) return reply.code(400).send({ error: { code: 'INVALID', message: NOT_IMAGE_MESSAGE } });
      return fail(reply, error);
    });
    scope.post<{ Params: { id: string } }>('/api/stories/:id/uploads', {
      bodyLimit: MAX_UPLOAD_BYTES,
      // Checked before the body is read: nobody but an admin gets to stream 10 MB at the server.
      onRequest: async (request, reply) => { if (!requireAdmin(auth, request, reply)) return reply; return undefined; }
    }, async (request, reply) => {
      try {
        if (!(await stories.get(request.params.id))) return notFound(reply, 'Story');
        const body = request.body;
        if (!Buffer.isBuffer(body)) return badRequest(reply, NOT_IMAGE_MESSAGE);
        const upload = await saveUpload(stories.storyDir(request.params.id), body);
        return reply.code(201).send({
          id: upload.id, url: `/api/stories/${request.params.id}/uploads/${upload.file}`, w: upload.w, h: upload.h, bytes: upload.bytes
        });
      } catch (error) {
        if (error instanceof UploadError) return reply.code(error.code === 'TOO_LARGE' ? 413 : 400).send({ error: { code: error.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'INVALID', message: error.message } });
        return fail(reply, error);
      }
    });
  });

  // Timeline music: raw audio body, the type proven by its bytes, 25 MB, one file per project.
  await server.register(async scope => {
    scope.addContentTypeParser([...MUSIC_TYPES], { parseAs: 'buffer', bodyLimit: MAX_MUSIC_BYTES }, (_request, body, done) => done(null, body));
    scope.setErrorHandler((error: { statusCode?: number; message?: string }, _request, reply) => {
      if (error.statusCode === 413) return reply.code(413).send({ error: { code: 'TOO_LARGE', message: MUSIC_TOO_LARGE_MESSAGE } });
      if (error.statusCode === 415 || error.statusCode === 400) return reply.code(400).send({ error: { code: 'INVALID', message: NOT_AUDIO_MESSAGE } });
      return fail(reply, error);
    });
    scope.post<{ Params: { id: string } }>('/api/stories/:id/music', {
      bodyLimit: MAX_MUSIC_BYTES,
      onRequest: async (request, reply) => { if (!requireAdmin(auth, request, reply)) return reply; return undefined; }
    }, async (request, reply) => {
      try {
        if (!(await stories.get(request.params.id))) return notFound(reply, 'Story');
        if (!Buffer.isBuffer(request.body)) return badRequest(reply, NOT_AUDIO_MESSAGE);
        const raw = String(request.headers['x-file-name'] ?? '');
        let name = '';
        try { name = decodeURIComponent(raw); } catch { name = ''; }
        return reply.code(201).send(await stories.saveMusic(request.params.id, request.body, name.replace(/[\u0000-\u001f]/g, '')));
      } catch (error) { return fail(reply, error); }
    });
  });

  server.get<{ Params: { id: string } }>('/api/stories/:id/music', async (request, reply) => {
    if (!member(request, reply)) return undefined;
    try {
      if (!(await stories.get(request.params.id))) return notFound(reply, 'Story');
      const file = await stories.musicPath(request.params.id);
      if (!file) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Musik belum diunggah' } });
      return sendVideo(reply, file, request.headers.range, MUSIC_MIME[file.split('.').pop() as MusicExt]);
    } catch (error) { return fail(reply, error); }
  });

  server.get<{ Params: { id: string; file: string } }>('/api/stories/:id/uploads/:file', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    if (!UPLOAD_FILE.test(request.params.file)) return notFound(reply, 'Upload');
    try {
      if (!(await stories.get(request.params.id))) return notFound(reply, 'Story');
      const file = join(uploadsDir(stories.storyDir(request.params.id)), request.params.file);
      if (!existsSync(file)) return notFound(reply, 'Upload');
      // `?w=`: a cached webp thumbnail (the same resize cache as frames and sheets), small widths included.
      if ((request.query as Record<string, unknown> | undefined)?.w !== undefined) {
        return await sendImage(request, reply.header('x-content-type-options', 'nosniff'), file, options.media, THUMB_WIDTHS);
      }
      return reply.header('content-type', mimeOfFile(request.params.file)!).header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=3600')
        .header('content-length', statSync(file).size).send(createReadStream(file));
    } catch (error) { return fail(reply, error); }
  });

  server.post<{ Params: { id: string } }>('/api/stories/:id/retry', async (request, reply) => {
    if (!requireAdmin(auth, request, reply)) return undefined;
    try {
      await stories.retry(request.params.id);
      return { story: await stories.reconcile(request.params.id, { wait: false }) };
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
      // A stale video (storyboard edited after assembly) stays watchable until it is rebuilt.
      const watchable = story?.status === 'done' || (!!story?.video && story.status !== 'assembling');
      if (!story || !watchable) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Video belum selesai' } });
      return sendVideo(reply, stories.videoPath(story.id), request.headers.range);
    } catch (error) { return fail(reply, error); }
  });

  const noVideo = (reply: FastifyReply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Video belum ada' } });

  server.get<{ Params: { id: string } }>('/api/stories/:id/video/poster', async (request, reply) => {
    if (!member(request, reply)) return undefined;
    try {
      if (!(await stories.get(request.params.id))) return notFound(reply, 'Story');
      const file = stories.videoPath(request.params.id);
      if (!existsSync(file)) return noVideo(reply);
      return await sendPoster(request, reply, file, options.media);
    } catch (error) { return fail(reply, error); }
  });

  server.get<{ Params: { id: string; shotId: string } }>('/api/stories/:id/shots/:shotId/poster', async (request, reply) => {
    if (!member(request, reply)) return undefined;
    if (!SHOT_ID.test(request.params.shotId)) return notFound(reply);
    try {
      if (!(await stories.get(request.params.id))) return notFound(reply, 'Story');
      const file = stories.shotPath(request.params.id, request.params.shotId);
      if (!existsSync(file)) return noVideo(reply);
      return await sendPoster(request, reply, file, options.media);
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
