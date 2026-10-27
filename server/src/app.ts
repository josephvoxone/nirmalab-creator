import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { registerAuthRoutes } from './auth/routes.js';
import { UserAuthStore } from './auth/store.js';
import { registerFlowRoutes } from './flow/routes.js';
import { registerFreeGenerateRoutes } from './generate/routes.js';
import { PublisherService, registerPublisherRoutes } from './publisher/index.js';
import { FlowStore } from './flow/store.js';
import { pollinationsText } from './generate/pollinations.js';
import type { TextGenerator } from './stories/draft.js';
import { assembleStory, imageSize, probeClip } from './stories/media.js';
import { registerStoryRoutes } from './stories/routes.js';
import { registerAssistantRoutes } from './assistant/routes.js';
import { CoverService } from './stories/covers.js';
import { captionFor } from './stories/caption.js';
import { MediaCache, type FfmpegRunner } from './media/images.js';
import { registerStorageRoutes, serialCleanup } from './media/storage.js';
import { StoryService, type StoryDeps } from './stories/service.js';
import { openRouterBalance } from './providers/balance.js';
import { OpenRouterCatalog } from './providers/catalog.js';
import { registerProviderRoutes } from './providers/routes.js';
import { registerQuotaRoutes } from './quota.js';
import { OpenRouterWorker } from './providers/worker.js';
import { registerTrendRoutes } from './trends/routes.js';
import { OpenRouterConfigStore } from './providers/config.js';
import { auditShot } from './audit/vision.js';
import { sampleFrames } from './audit/frames.js';
import { AuditLedger } from './audit/ledger.js';
import { TextModelConfigStore } from './llm/config.js';
import { createOpenCodeModel, type TextModel } from './llm/opencode.js';

export type AppOptions = {
  dataDir: string;
  /** Built web app (index.html + assets/). Omitted in API-only tests/dev. */
  webDist?: string;
  env?: NodeJS.ProcessEnv;
  logger?: boolean;
  version?: string;
  stories?: Partial<Pick<StoryDeps, 'probe' | 'assemble' | 'imageSize' | 'audit'>> & {
    generateText?: TextGenerator;
    /** Background reconcile interval; 0 disables (tests). Default 5 s. */
    reconcileMs?: number;
  };
  providers?: {
    /** fetch used for every OpenRouter call (tests inject a fake; never a real key in tests). */
    fetch?: typeof fetch;
    /** OpenRouter worker interval; 0 disables. Default 5 s. */
    workerMs?: number;
  };
  text?: {
    /** fetch used for OpenCode Go calls (tests inject a fake; never a real key in tests). Default: providers.fetch. */
    fetch?: typeof fetch;
    /** Replaces the OpenCode Go model entirely (tests). */
    model?: TextModel;
  };
  media?: {
    /** ffmpeg used for thumbnails/posters (tests inject a counting runner). */
    ffmpeg?: FfmpegRunner;
    /** Storage janitor interval; 0 disables. Default daily (first run 10 min after start). */
    cleanupMs?: number;
  };
};

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const env = options.env ?? process.env;
  const server = Fastify({ logger: options.logger ?? false, bodyLimit: 210 * 1024 * 1024, trustProxy: true });

  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
    return payload;
  });

  server.get('/api/health', async () => ({ ok: true, app: 'nirmalab-creator', version: options.version ?? 'dev' }));

  const userAuthStore = new UserAuthStore(options.dataDir);
  await server.register(async scoped => {
    await registerAuthRoutes(scoped, userAuthStore, {
      bootstrapAdminEmail: env.OPENCREATOR_ADMIN_EMAIL,
      bootstrapAdminPassword: env.OPENCREATOR_ADMIN_PASSWORD
    });
  }, { prefix: '/api' });

  const flowStore = new FlowStore(join(options.dataDir, 'flow'));
  const media = new MediaCache({ dataDir: options.dataDir, ffmpeg: options.media?.ffmpeg });
  const providerFetch = options.providers?.fetch ?? fetch;
  const catalog = new OpenRouterCatalog(options.dataDir, { fetch: providerFetch });
  const providerConfig = new OpenRouterConfigStore(options.dataDir);
  const auditLedger = new AuditLedger(options.dataDir);
  // Audit is inert without an OpenRouter key: `model()` returns undefined and nothing is spent or flagged.
  const audit: StoryDeps['audit'] = options.stories?.audit ?? {
    model: async () => ((await providerConfig.apiKey()) ? providerConfig.auditModel() : undefined),
    run: async ({ images, expectation, model }) => {
      const apiKey = await providerConfig.apiKey();
      if (!apiKey) throw new Error('OpenRouter belum dikonfigurasi');
      const result = await auditShot({ images, expectation, model, apiKey, fetch: providerFetch });
      await auditLedger.record({ atMs: Date.now(), costUsd: result.costUsd }).catch(() => undefined);
      return result;
    },
    frames: (clip, dir, shotId) => sampleFrames(clip, dir, shotId)
  };
  const stories = new StoryService({
    dataDir: options.dataDir,
    flow: flowStore,
    probe: options.stories?.probe ?? probeClip,
    assemble: options.stories?.assemble ?? assembleStory,
    imageSize: options.stories?.imageSize ?? imageSize,
    audit,
    openRouter: {
      usdPerClip: async model => {
        try { return (await catalog.find('video', model))?.usdPerClip ?? null; } catch { return null; }
      },
      balance: () => openRouterBalance(options.dataDir, { fetch: providerFetch })
    }
  });
  await registerPublisherRoutes(server, {
    service: new PublisherService({ dataDir: options.dataDir, env }),
    userAuthStore,
    env,
    resolveStoryVideo: async id => ((await stories.get(id))?.status === 'done' ? stories.videoPath(id) : undefined),
    // P4: the preview caption comes from the story's own facts, never from a blank field.
    resolveStoryPreview: async id => {
      if ((await stories.get(id))?.status !== 'done') return undefined;
      const board = await stories.readStoryboard(id).catch(() => undefined);
      if (!board) return undefined;
      const bible = board.bible ? { logline: board.bible.logline, theme: board.bible.theme } : null;
      return {
        title: board.title,
        caption: board.caption ?? captionFor({
          title: board.title,
          ...(board.logline ? { logline: board.logline } : {}),
          ...(board.titleCard?.kicker ? { kicker: board.titleCard.kicker } : {}),
          ...(board.template ? { template: board.template } : {}),
          lines: board.shots.map(shot => shot.narration).filter((line): line is string => !!line),
          bible
        })
      };
    }
  });
  await registerFreeGenerateRoutes(server, { userAuthStore, dataDir: options.dataDir });
  await registerFlowRoutes(server, {
    userAuthStore,
    dataDir: options.dataDir,
    store: flowStore,
    media,
    bridgeToken: env.OPENCREATOR_FLOW_BRIDGE_TOKEN?.trim() || undefined,
    openRouter: {
      usdPerClip: async model => { try { return (await catalog.find('video', model))?.usdPerClip ?? null; } catch { return null; } },
      balance: () => openRouterBalance(options.dataDir, { fetch: providerFetch })
    }
  });
  // One text-model store + client per process; later features (project assistant, MCP) take `textModel` from here.
  const textStore = new TextModelConfigStore(options.dataDir);
  const textModel = options.text?.model ?? createOpenCodeModel({ store: textStore, fetch: options.text?.fetch ?? providerFetch });
  await registerProviderRoutes(server, { userAuthStore, dataDir: options.dataDir, flow: flowStore, fetch: providerFetch, catalog, text: { store: textStore, model: textModel } });
  await registerQuotaRoutes(server, { userAuthStore, dataDir: options.dataDir, flow: flowStore, balance: () => openRouterBalance(options.dataDir, { fetch: providerFetch }) });
  const workerMs = options.providers?.workerMs ?? 5000;
  if (workerMs > 0) {
    const stopWorker = new OpenRouterWorker({ dataDir: options.dataDir, store: flowStore, fetch: providerFetch, catalog }).start(workerMs);
    server.addHook('onClose', async () => stopWorker());
  }

  const generateText: TextGenerator = options.stories?.generateText ?? (async (system, prompt) => (await pollinationsText(
    fetch,
    { prompt, system, model: env.STORY_LLM_MODEL || 'openai', apiKey: env.OPENCREATOR_POLLINATIONS_API_KEY, maxTokens: 6000 },
    options.dataDir,
    { timeoutMs: 120_000 }
  )).text);
  const covers = new CoverService({ dataDir: options.dataDir, flow: flowStore, webDist: options.webDist });
  // OpenRouter prices for spending estimates (story actions and the assistant).
  const actionPrice = {
    usdPerClip: async (model: string) => { try { return (await catalog.find('video', model))?.usdPerClip ?? null; } catch { return null; } },
    usdPerImage: async (model: string) => { try { return (await catalog.find('image', model))?.usdPerImage ?? null; } catch { return null; } }
  };
  await registerStoryRoutes(server, {
    userAuthStore, stories, generateText, covers, media,
    // Project actions (breakdown, sheets): the shared text model and OpenRouter prices for estimates.
    textModel, price: actionPrice
  });
  // Project assistant chat (SSE), history and undo: same text model and prices as the story actions.
  await registerAssistantRoutes(server, { userAuthStore, stories, textModel, price: actionPrice });
  await registerTrendRoutes(server, { userAuthStore, dataDir: options.dataDir, stories, env });
  const reconcileMs = options.stories?.reconcileMs ?? 5000;
  if (reconcileMs > 0) {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void stories.reconcileAll().finally(() => { running = false; });
    }, reconcileMs);
    timer.unref();
    server.addHook('onClose', async () => clearInterval(timer));
  }

  const cleanup = serialCleanup(options.dataDir, { jobs: () => flowStore.listJobs(Number.MAX_SAFE_INTEGER) });
  await registerStorageRoutes(server, { userAuthStore, dataDir: options.dataDir, cleanup });
  const cleanupMs = options.media?.cleanupMs ?? 24 * 3_600_000;
  if (cleanupMs > 0) {
    const sweep = () => void cleanup().then(
      r => { if (r.removed || r.linked) server.log.info(r, 'storage cleanup'); },
      error => server.log.warn({ err: error }, 'storage cleanup failed')
    );
    // Deploys restart the process more often than daily: also sweep shortly after start.
    const first = setTimeout(sweep, Math.min(cleanupMs, 10 * 60_000));
    const daily = setInterval(sweep, cleanupMs);
    first.unref();
    daily.unref();
    server.addHook('onClose', async () => { clearTimeout(first); clearInterval(daily); });
  }

  const webDist = options.webDist;
  const hasWeb = webDist && existsSync(join(webDist, 'index.html'));
  if (hasWeb) {
    await server.register(fastifyStatic, { root: webDist, wildcard: false, index: false });
    server.get('/assets/*', async (request, reply) => {
      const file = (request.params as { '*': string })['*'];
      if (!/^[\w.\-/]+$/.test(file) || file.includes('..') || !existsSync(join(webDist, 'assets', file))) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      }
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      return reply.sendFile(join('assets', file));
    });
  }

  server.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (!hasWeb || path.startsWith('/api/') || request.method !== 'GET' || /\.[a-z0-9]{1,5}$/i.test(path)) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
    reply.header('cache-control', 'no-cache');
    return reply.type('text/html').sendFile('index.html');
  });

  await server.ready();
  return server;
}
