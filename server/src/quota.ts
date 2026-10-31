/** GET /api/quota — what is left to spend, for the sidebar (any signed-in member). */
import type { FastifyInstance } from 'fastify';
import { sessionUser } from './auth/routes.js';
import type { UserAuthStore } from './auth/store.js';
import type { FlowStore } from './flow/store.js';
import { StorageMeter } from './media/storage-meter.js';
import { AuditLedger } from './audit/ledger.js';
import type { OpenRouterBalance } from './providers/client.js';
import { OpenRouterConfigStore } from './providers/config.js';

export type QuotaRouteOptions = {
  userAuthStore: UserAuthStore;
  dataDir: string;
  flow: FlowStore;
  balance: () => Promise<OpenRouterBalance | null>;
  /** Cached disk scan shared with the storage routes (the janitor invalidates it). Default: a private one. */
  storage?: StorageMeter;
};

export async function registerQuotaRoutes(server: FastifyInstance, options: QuotaRouteOptions): Promise<void> {
  const config = new OpenRouterConfigStore(options.dataDir);
  // Every member polls this route each minute: the volume is walked once per cache window, not once per call.
  const storageMeter = options.storage ?? new StorageMeter(options.dataDir);
  server.get('/api/quota', async (request, reply) => {
    if (!sessionUser(options.userAuthStore, request)) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Masuk dulu' } });
    const accounts = (await options.flow.listAccounts()).filter(a => a.enabled !== false);
    const known = accounts.filter(a => typeof a.credits === 'number');
    const capped = accounts.filter(a => typeof a.dailyCreditCap === 'number');
    const configured = (await config.view()).configured;
    const balance = configured ? await options.balance().catch(() => null) : null;
    const queue = await options.flow.queueStatus();
    const storage = await storageMeter.get().catch(() => ({ usedBytes: 0, diskFreeBytes: null }));
    return {
      flow: {
        credits: known.length ? known.reduce((sum, a) => sum + (a.credits ?? 0), 0) : null,
        usedToday: accounts.reduce((sum, a) => sum + (a.creditsUsedToday ?? 0), 0),
        capToday: capped.length ? capped.reduce((sum, a) => sum + (a.dailyCreditCap ?? 0), 0) : null,
        accounts: accounts.length,
        online: (await options.flow.bridgeStatus()).online,
        // Render status for the sidebar: clips in progress, clips parked until a refill, and when.
        running: queue.running,
        waiting: queue.waitingForCredits,
        resumeAtMs: queue.resumeAtMs,
        pool: queue.accounts.map(a => ({ label: a.label, credits: a.credits, refillAtMs: a.refillAtMs }))
      },
      openrouter: { configured, remainingUsd: balance?.remainingUsd ?? null, usedUsd: balance?.usedUsd ?? null },
      // Vision audit spend of today (spec §9.5) — money only, no prompts.
      audit: await new AuditLedger(options.dataDir).today(),
      storage: { usedBytes: storage.usedBytes, diskFreeBytes: storage.diskFreeBytes }
    };
  });
}
