import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { registerAuthRoutes } from './auth/routes.js';
import { UserAuthStore } from './auth/store.js';
import { registerFlowRoutes } from './flow/routes.js';
import { registerFreeGenerateRoutes } from './generate/routes.js';
import { PublisherService, isStoryOwner, migratePublisherTokensAtBoot, registerPublisherRoutes, resolveMainOwner } from './publisher/index.js';
import { FlowStore } from './flow/store.js';
import { pollinationsText } from './generate/pollinations.js';
import type { TextGenerator } from './stories/draft.js';
import { draftTextGenerator } from './stories/draft-text.js';
import { assembleStory, imageSize, probeClip } from './stories/media.js';
import { registerStoryRoutes } from './stories/routes.js';
import { registerAssistantRoutes } from './assistant/routes.js';
import { registerMcpRoutes } from './mcp/routes.js';
import { McpTokenStore } from './mcp/tokens.js';
import { scanProjects } from './tenancy/project-meta.js';
import { CoverService } from './stories/covers.js';
import { captionFor } from './stories/caption.js';
import { MediaCache, type FfmpegRunner } from './media/images.js';
import { registerStorageRoutes, serialCleanup } from './media/storage.js';
import { StoryService, type StoryDeps } from './stories/service.js';
import { openRouterBalance, openRouterBalanceAt } from './providers/balance.js';
import { FlowGate, committedBalance, storyQuota } from './quota/gates.js';
import { SpendLedger } from './quota/ledger.js';
import { LimitsStore } from './quota/limits.js';
import { registerQuotaLimitRoutes } from './quota/routes.js';
import { OpenRouterCatalog } from './providers/catalog.js';
import { registerProviderRoutes } from './providers/routes.js';
import { AxcelClient, AxcelConfigStore, AxcelWorker } from './providers/axcel.js';
import { registerQuotaRoutes } from './quota.js';
import { OpenRouterWorker } from './providers/worker.js';
import { registerTrendRoutes } from './trends/routes.js';
import { OpenRouterConfigStore } from './providers/config.js';
import { auditShot } from './audit/vision.js';
import { sampleFrames } from './audit/frames.js';
import { AuditLedger } from './audit/ledger.js';
import { TextModelConfigStore } from './llm/config.js';
import { FairQueue } from './lib/fair-queue.js';
import { ProviderKeys } from './lib/provider-keys.js';
import { ElevenLabsClient } from './dub/elevenlabs.js';
import { DubService } from './dub/service.js';
import { registerDubRoutes } from './dub/routes.js';
import { createGeminiModel } from './llm/gemini.js';
import { TextRoutingStore, createRoutedModel, limitedModel } from './llm/router.js';
import { requireAdmin } from './auth/routes.js';
import { parseTrustProxyHops, trustProxyFor, useCloudflareRanges } from './auth/proxy.js';
import { registerCrossSiteGuard } from './auth/csrf.js';
import { installPolicyGuard } from './tenancy/policy.js';
import { ensureOwners, resolvePrimaryOwner } from './tenancy/migrate.js';
import { StorageMeter } from './media/storage-meter.js';
import { createOpenCodeModel, type TextModel } from './llm/opencode.js';

export type AppOptions = {
  dataDir: string;
  /** Built web app (index.html + assets/). Omitted in API-only tests/dev. */
  webDist?: string;
  env?: NodeJS.ProcessEnv;
  logger?: boolean;
  version?: string;
  /** Reverse proxies trusted to write X-Forwarded-For (env TRUST_PROXY_HOPS; default 1). See auth/proxy.ts. */
  trustProxyHops?: number;
  stories?: Partial<Pick<StoryDeps, 'probe' | 'assemble' | 'imageSize' | 'audit' | 'motion'>> & {
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
  /** Dubbing (ElevenLabs): the fetch used for its calls (tests inject a fake), resume of queued shots at boot, concurrency. */
  dub?: { fetch?: typeof fetch; baseUrl?: string; resume?: boolean; concurrency?: number };
  /** Concurrency of the shared work queues (env ASSEMBLY_CONCURRENCY / DUB_CONCURRENCY / LLM_CONCURRENCY otherwise). */
  queues?: { assembly?: number; dub?: number; llm?: number };
  /** Project assistant limits (tests): whole-turn deadline and SSE heartbeat interval. */
  assistant?: { totalMs?: number; heartbeatMs?: number };
  text?: {
    /** fetch used for OpenCode Go calls (tests inject a fake; never a real key in tests). Default: providers.fetch. */
    fetch?: typeof fetch;
    /** Replaces the OpenCode Go model entirely (tests). */
    model?: TextModel;
  };
  /** Called for every route Fastify registers (test seam: the tenancy policy test reads the live route set from here). */
  onRoute?: (route: { method: string | string[]; url: string; config?: unknown }) => void;
  /** Tenancy foundation (tests): a replacement route-policy registry, to prove the boot guard refuses what it does not list. */
  tenancy?: { policyRegistry?: import('./tenancy/policy.js').PolicyRegistry; report?: (finding: { key: string; policy: string; status: number }) => void };
  media?: {
    /** ffmpeg used for thumbnails/posters (tests inject a counting runner). */
    ffmpeg?: FfmpegRunner;
    /** Storage janitor interval; 0 disables. Default daily (first run 10 min after start). */
    cleanupMs?: number;
  };
};

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const env = options.env ?? process.env;
  // trustProxy is a hop COUNT (as a function, see auth/proxy.ts), never `true`: `true` trusts the whole X-Forwarded-For chain, i.e. whatever the client wrote.
  const trustProxyHops = options.trustProxyHops ?? parseTrustProxyHops(env.TRUST_PROXY_HOPS);
  useCloudflareRanges(env.CLOUDFLARE_IP_RANGES?.split(','));
  const server = Fastify({ logger: options.logger ?? false, bodyLimit: 210 * 1024 * 1024, trustProxy: trustProxyFor(trustProxyHops) });

  // Test seam: sees every route registered below (registered first, so nothing is missed).
  if (options.onRoute) server.addHook('onRoute', options.onRoute);

  // T0 tenancy: a route with no policy entry stops the boot (fail-closed); behaviour is only reported, never changed.
  installPolicyGuard(server, { ...(options.tenancy?.policyRegistry ? { registry: options.tenancy.policyRegistry } : {}), ...(options.tenancy?.report ? { report: options.tenancy.report } : {}) });

  // CSRF second layer: a cookie-carrying mutation that claims another site is refused (auth/csrf.ts).
  registerCrossSiteGuard(server, env.ALLOWED_ORIGINS);

  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
    // Only the directives that restrict nothing the SPA, media or previews load: no framing (same as X-Frame-Options,
    // but honoured where XFO is not), no <base> hijack, no plugins. A full script/style CSP is a separate, tested step.
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    return payload;
  });

  server.get('/api/health', async () => ({ ok: true, app: 'nirmalab-creator', version: options.version ?? 'dev' }));

  const userAuthStore = new UserAuthStore(options.dataDir);
  // T8 admin: one MCP token store per process (shared with the MCP routes below), so removing a member can revoke their tokens.
  const mcpTokens = new McpTokenStore(options.dataDir, userAuthStore);
  await server.register(async scoped => {
    await registerAuthRoutes(scoped, userAuthStore, {
      // T8 member removal (audit 06 §C.3): the account is already gone when this runs; revoke what hangs on it. Idempotent, so a retry heals a half-done removal.
      // The member's projects are NOT touched: they become orphans the admin moves or deletes from Pengaturan > Penyimpanan.
      onMemberRemoved: async member => {
        await mcpTokens.revokeAllFor(member.id);
        await publisherService.revokeAllFor(member.id);
        await quotaLimits.set(member.id, {});
        const { projects } = await scanProjects(options.dataDir, { withBytes: false });
        return { orphanedProjects: projects.filter(project => project.ownerId === member.id).length };
      },
      bootstrapAdminEmail: env.OPENCREATOR_ADMIN_EMAIL,
      bootstrapAdminPassword: env.OPENCREATOR_ADMIN_PASSWORD,
      trustProxyHops,
      // COOKIE_SECURE=1 always / 0 never / unset = only over HTTPS (see AuthRouteOptions.secureCookies).
      secureCookies: env.COOKIE_SECURE === '1' ? true : env.COOKIE_SECURE === '0' ? false : 'auto'
    });
  }, { prefix: '/api' });

  const flowStore = new FlowStore(join(options.dataDir, 'flow'));
  // QUOTA (T5): per-user ledger of what leaves money (Flow credits, OpenRouter USD, ElevenLabs characters). Limits live in
  // quota/limits.json (numbers only); admins (isAdmin) have no ElevenLabs limit, non-admins the defaults of quota/limits.ts.
  const quotaLimits = new LimitsStore(options.dataDir, id => userAuthStore.findUserById(id)?.isAdmin === true);
  await quotaLimits.init();
  const quotaLedger = new SpendLedger(options.dataDir, { limitFor: quotaLimits.resolve });
  const media = new MediaCache({ dataDir: options.dataDir, ffmpeg: options.media?.ffmpeg });
  const providerFetch = options.providers?.fetch ?? fetch;
  const catalog = new OpenRouterCatalog(options.dataDir, { fetch: providerFetch });
  const providerConfig = new OpenRouterConfigStore(options.dataDir);
  const auditLedger = new AuditLedger(options.dataDir);
  const balanceSource = { balance: () => openRouterBalance(options.dataDir, { fetch: providerFetch }), fetchedAtMs: () => openRouterBalanceAt(options.dataDir) };
  // The balance every budget check sees: the cached one minus what is already promised/spent since (closes the 60 s cache race).
  const spendableBalance = committedBalance(quotaLedger, balanceSource);
  flowStore.setGate(new FlowGate({
    ledger: quotaLedger,
    prices: {
      usdPerClip: async model => { try { return (await catalog.find('video', model))?.usdPerClip ?? null; } catch { return null; } },
      usdPerImage: async model => { try { return (await catalog.find('image', model))?.usdPerImage ?? null; } catch { return null; } }
    },
    balance: balanceSource
  }));
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
  const envInt = (name: string, fallback: number) => { const n = Number(env[name]); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback; };
  // ffmpeg takes ~1.2 GB and several cores per assembly: two at once on a 4-core / 16 GB VPS.
  const assemblyQueue = new FairQueue({ concurrency: options.queues?.assembly ?? envInt('ASSEMBLY_CONCURRENCY', Math.min(2, Math.max(1, Math.floor(availableParallelism() / 2)))), maxWaiting: 500 });
  // ElevenLabs: ONE active key (their terms forbid sharing/rotating accounts); extra keys are dormant. Gemini: a pool of up to 10.
  const elevenKeys = new ProviderKeys(options.dataDir, 'elevenlabs', { env });
  // More shots in flight than one key can carry would only wait FIFO inside the key pool (and time out); the fair queue
  // is where the waiting belongs, so its concurrency is what the single key can serve.
  const dubQueue = new FairQueue({ concurrency: Math.min(options.queues?.dub ?? options.dub?.concurrency ?? envInt('DUB_CONCURRENCY', 6), elevenKeys.concurrencyLimit()), maxWaiting: 5000 });
  const llmQueue = new FairQueue({ concurrency: options.queues?.llm ?? envInt('LLM_CONCURRENCY', 8), maxWaiting: 200 });
  let dubService: DubService | undefined;
  const dubRef = () => dubService!;
  const stories = new StoryService({
    dataDir: options.dataDir,
    flow: flowStore,
    probe: options.stories?.probe ?? probeClip,
    // One shared line for the CPU/RAM-heavy assembler: at most N at once, users served in turn (a hundred clicks no longer
    // start a hundred ffmpeg that the kernel then kills). The wait is shown to the user as "antre".
    assemble: (dir, ctx) => assemblyQueue.run(ctx?.owner ?? dir, () => (options.stories?.assemble ?? assembleStory)(dir, ctx), ctx?.onPosition ? { onPosition: ctx.onPosition } : {}),
    dub: { for: id => dubRef().dubFor(id) },
    // Tenancy: the account that owned everything before ownership was recorded may keep reusing its unattributed clips (shot.reuse).
    legacyOwnerId: () => { try { return resolvePrimaryOwner(userAuthStore.listUsers(), env.TENANCY_DEFAULT_OWNER_EMAIL)?.id; } catch { return undefined; } },
    imageSize: options.stories?.imageSize ?? imageSize,
    audit,
    // Free motion QC of finished clips. Wired by main.ts (production); absent here = nothing is checked (tests stay inert).
    ...(options.stories?.motion ? { motion: options.stories.motion } : {}),
    openRouter: {
      usdPerClip: async model => {
        try { return (await catalog.find('video', model))?.usdPerClip ?? null; } catch { return null; }
      },
      balance: spendableBalance
    },
    // Pre-flight of a run and the hold around one vision audit (quota/gates.ts).
    quota: storyQuota(quotaLedger, quotaLimits.resolve)
  });
  // T1 tenancy: every project gets an owner (ownerless -> primary owner), with backup + manifest; see tenancy/migrate.ts.
  // TENANCY_MIGRATE=0 skips it, TENANCY_DRY_RUN=1 only reports, TENANCY_ENFORCE=1 stops the boot when a project cannot be given an owner.
  if (env.TENANCY_MIGRATE !== '0') {
    try {
      const report = await ensureOwners({
        dataDir: options.dataDir, users: userAuthStore.listUsers(), lock: stories.lockStory.bind(stories),
        ...(env.TENANCY_DEFAULT_OWNER_EMAIL ? { defaultOwnerEmail: env.TENANCY_DEFAULT_OWNER_EMAIL } : {}),
        dryRun: env.TENANCY_DRY_RUN === '1', enforce: env.TENANCY_ENFORCE === '1'
      });
      server.log.info({ tenancy: { dryRun: report.dryRun, owner: report.primaryOwner?.email, assigned: report.assigned.length, alreadyOwned: report.alreadyOwned, orphans: report.orphans.length, qaOwned: report.qaOwned.length, unassigned: report.unassigned.length, unreadable: report.unreadable.length, manifest: report.manifest } }, 'tenancy: pemilik proyek');
    } catch (error) {
      if (env.TENANCY_ENFORCE === '1') throw error;
      server.log.error({ err: error }, 'tenancy: penetapan pemilik gagal (server tetap jalan; TENANCY_ENFORCE=1 menghentikan boot)');
    }
  }
  // T7 (publisher): tokens saved before per-user storage were one global file per platform. Hand them to the main
  // owner (backup + manifest + rollback; no-op once done) BEFORE the routes can answer a status request.
  await migratePublisherTokensAtBoot({ dataDir: options.dataDir, users: userAuthStore.listUsers(), env, log: server.log });
  // Hoisted so the member-removal flow can call `publisherService.revokeAllFor(userId)`.
  const publisherService = new PublisherService({ dataDir: options.dataDir, env });
  await registerPublisherRoutes(server, {
    service: publisherService,
    userAuthStore,
    env,
    // T7: only the project's owner may preview/publish it (isStoryOwner is the small replaceable decision; the
    // formal ownership helper of the tenancy area can take its place here).
    canAccessStory: async (id, user) =>
      isStoryOwner(await stories.get(id), user.id, resolveMainOwner(userAuthStore.listUsers(), env).owner?.user.id),
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
      balance: spendableBalance
    }
  });
  // One text-model store + client per process; later features (project assistant, MCP) take `textModel` from here.
  const textStore = new TextModelConfigStore(options.dataDir);
  const openCodeModel = options.text?.model ?? createOpenCodeModel({ store: textStore, fetch: options.text?.fetch ?? providerFetch });
  // API keys: ElevenLabs for dubbing (ONE active key, no rotation across accounts), Gemini as a text model next to OpenCode Go (pool of up to 10).
  const geminiKeys = new ProviderKeys(options.dataDir, 'gemini', { env });
  await Promise.all([elevenKeys.load(), geminiKeys.load()]);
  const textRouting = new TextRoutingStore(options.dataDir);
  const dubFetch = options.dub?.fetch ?? providerFetch;
  const geminiModel = createGeminiModel({ keys: geminiKeys, fetch: options.text?.fetch ?? providerFetch, chosenModel: async () => (await textRouting.view()).geminiModel });
  // The model every feature uses: primary + automatic fallback, with a cap on simultaneous provider calls.
  const textModel = options.text?.model ?? limitedModel(createRoutedModel({ opencode: openCodeModel, gemini: geminiModel, routing: () => textRouting.view() }), llmQueue);
  await registerProviderRoutes(server, { userAuthStore, dataDir: options.dataDir, flow: flowStore, fetch: providerFetch, catalog, text: { store: textStore, model: openCodeModel } });
  // One cached disk scan for the sidebar quota; the storage janitor drops it when it has changed the volume.
  const storageMeter = new StorageMeter(options.dataDir);
  await registerQuotaRoutes(server, { userAuthStore, dataDir: options.dataDir, flow: flowStore, balance: () => openRouterBalance(options.dataDir, { fetch: providerFetch }), storage: storageMeter, quotaLedger: { ledger: quotaLedger, limits: quotaLimits } });
  await registerQuotaLimitRoutes(server, { userAuthStore, ledger: quotaLedger, limits: quotaLimits });
  const workerMs = options.providers?.workerMs ?? 5000;
  if (workerMs > 0) {
    const stopWorker = new OpenRouterWorker({ dataDir: options.dataDir, store: flowStore, fetch: providerFetch, catalog }).start(workerMs);
    server.addHook('onClose', async () => stopWorker());
    // Axcel renders through the Mac bridge (no key: it reuses the browser session), so it runs
    // whenever a bridge token is configured — the client resolves per tick.
    const axcelConfig = new AxcelConfigStore(options.dataDir);
    const axcelWorker = new AxcelWorker({
      store: flowStore,
      client: async () => {
        const settings = await axcelConfig.settings();
        return settings.token ? new AxcelClient(providerFetch, { url: settings.url, token: settings.token }) : undefined;
      }
    }).start(workerMs);
    server.addHook('onClose', async () => axcelWorker());
  }

  // Drafts: the OpenCode Go text model when configured, else Pollinations (same generator for the session route and MCP).
  const pollinationsDraft: TextGenerator = async (system, prompt, signal) => (await pollinationsText(
    fetch,
    { prompt, system, model: env.STORY_LLM_MODEL || 'openai', apiKey: env.OPENCREATOR_POLLINATIONS_API_KEY, maxTokens: 6000 },
    options.dataDir,
    { timeoutMs: 120_000, ...(signal ? { signal } : {}) }
  )).text;
  const generateText: TextGenerator = options.stories?.generateText ?? draftTextGenerator(textModel, pollinationsDraft);
  const covers = new CoverService({ dataDir: options.dataDir, flow: flowStore, webDist: options.webDist });
  // OpenRouter prices for spending estimates (story actions and the assistant).
  const actionPrice = {
    usdPerClip: async (model: string) => { try { return (await catalog.find('video', model))?.usdPerClip ?? null; } catch { return null; } },
    usdPerImage: async (model: string) => { try { return (await catalog.find('image', model))?.usdPerImage ?? null; } catch { return null; } }
  };
  const elevenClient = new ElevenLabsClient({ keys: elevenKeys, fetch: dubFetch, ...(options.dub?.baseUrl ? { baseUrl: options.dub.baseUrl } : {}) });
  dubService = new DubService({
    dir: id => stories.storyDir(id),
    board: id => stories.readStoryboard(id),
    markStale: id => stories.markVideoStale(id),
    client: elevenClient,
    queue: dubQueue,
    probe: async file => (await (options.stories?.probe ?? probeClip)(file)).durationSec,
    // Real clip lengths give the dub-fit check its window; a story with no rendered clip yet falls back to the 6 s Flow clip.
    quota: quotaLedger,
    clipSeconds: async id => Object.fromEntries(((await stories.get(id))?.shots ?? []).flatMap(s => (typeof s.durationSec === 'number' && s.durationSec > 0 ? [[s.id, s.durationSec] as const] : [])))
  });
  await registerDubRoutes(server, { userAuthStore, stories, dub: dubService, client: elevenClient, keys: { elevenlabs: elevenKeys, gemini: geminiKeys }, routing: textRouting, fetch: providerFetch });
  // Shots the user already confirmed before a restart are queued again.
  if (options.dub?.resume !== false) void stories.list().then(all => dubService!.resume(all.map(r => r.id))).catch(() => undefined);
  // Reservations whose job/dub no longer exists (a crash between reserve and create) are freed at boot and every 10 minutes.
  {
    const jobLive = FlowGate.isLive(id => flowStore.getJob(id));
    const sweep = () => void quotaLedger.sweep(async key => key.startsWith('job:') ? jobLive(key) : key.startsWith('dub:') ? dubRef().isHoldLive(key) : false)
      .catch(error => server.log.warn({ err: error }, 'quota sweep failed'));
    const first = setTimeout(sweep, 60_000);
    const every = setInterval(sweep, 10 * 60_000);
    first.unref(); every.unref();
    server.addHook('onClose', async () => { clearTimeout(first); clearInterval(every); });
  }
  // Load of the shared queues, for the admin (and for deciding the concurrency limits with numbers).
  server.get('/api/system/load', async (request, reply) => {
    if (!requireAdmin(userAuthStore, request, reply)) return undefined;
    const mem = process.memoryUsage();
    return { assembly: assemblyQueue.stats(), dub: dubQueue.stats(), llm: llmQueue.stats(), process: { rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576), uptimeSec: Math.round(process.uptime()) } };
  });
  await registerStoryRoutes(server, {
    userAuthStore, stories, generateText, covers, media,
    // Project actions (breakdown, sheets): the shared text model and OpenRouter prices for estimates.
    textModel, price: actionPrice
  });
  // Project assistant chat (SSE), history and undo: same text model and prices as the story actions.
  await registerAssistantRoutes(server, { userAuthStore, stories, textModel, price: actionPrice, ...(options.assistant ?? {}) });
  // Remote MCP (`/mcp`, bearer personal tokens) + token routes: the same action layer as the chat.
  await registerMcpRoutes(server, { userAuthStore, dataDir: options.dataDir, tokens: mcpTokens, stories, generateText, textModel, price: actionPrice, version: options.version });
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

  const sweepOnce = serialCleanup(options.dataDir, { jobs: () => flowStore.listJobs(Number.MAX_SAFE_INTEGER) });
  const cleanup = async () => { try { return await sweepOnce(); } finally { storageMeter.invalidate(); } };
  await registerStorageRoutes(server, { userAuthStore, dataDir: options.dataDir, cleanup, meter: storageMeter });
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
