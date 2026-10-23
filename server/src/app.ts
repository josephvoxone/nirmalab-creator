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
import { assembleStory, probeClip } from './stories/media.js';
import { registerStoryRoutes } from './stories/routes.js';
import { StoryService, type StoryDeps } from './stories/service.js';

export type AppOptions = {
  dataDir: string;
  /** Built web app (index.html + assets/). Omitted in API-only tests/dev. */
  webDist?: string;
  env?: NodeJS.ProcessEnv;
  logger?: boolean;
  version?: string;
  stories?: Partial<Pick<StoryDeps, 'probe' | 'assemble'>> & {
    generateText?: TextGenerator;
    /** Background reconcile interval; 0 disables (tests). Default 5 s. */
    reconcileMs?: number;
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
  const stories = new StoryService({
    dataDir: options.dataDir,
    flow: flowStore,
    probe: options.stories?.probe ?? probeClip,
    assemble: options.stories?.assemble ?? assembleStory
  });
  await registerPublisherRoutes(server, {
    service: new PublisherService({ dataDir: options.dataDir, env }),
    userAuthStore,
    env,
    resolveStoryVideo: async id => ((await stories.get(id))?.status === 'done' ? stories.videoPath(id) : undefined)
  });
  await registerFreeGenerateRoutes(server, { userAuthStore, dataDir: options.dataDir });
  await registerFlowRoutes(server, {
    userAuthStore,
    dataDir: options.dataDir,
    store: flowStore,
    bridgeToken: env.OPENCREATOR_FLOW_BRIDGE_TOKEN?.trim() || undefined
  });

  const generateText: TextGenerator = options.stories?.generateText ?? (async (system, prompt) => (await pollinationsText(
    fetch,
    { prompt, system, model: env.STORY_LLM_MODEL || 'openai', apiKey: env.OPENCREATOR_POLLINATIONS_API_KEY, maxTokens: 6000 },
    options.dataDir,
    { timeoutMs: 120_000 }
  )).text);
  await registerStoryRoutes(server, { userAuthStore, stories, generateText });
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
