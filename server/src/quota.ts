/** GET /api/quota — what is left to spend, for the sidebar (any signed-in member). */
import type { FastifyInstance } from 'fastify';
import { sessionUser } from './auth/routes.js';
import type { UserAuthStore } from './auth/store.js';
import type { FlowStore } from './flow/store.js';
import { StorageMeter } from './media/storage-meter.js';
import { AuditLedger } from './audit/ledger.js';
import type { OpenRouterBalance } from './providers/client.js';
import { OpenRouterConfigStore } from './providers/config.js';
import type { SpendLedger } from './quota/ledger.js';
import type { LimitsStore } from './quota/limits.js';

export type QuotaRouteOptions = {
  userAuthStore: UserAuthStore;
  dataDir: string;
  flow: FlowStore;
  balance: () => Promise<OpenRouterBalance | null>;
  /** Cached disk scan shared with the storage routes (the janitor invalidates it). Default: a private one. */
  storage?: StorageMeter;
  /** Per-user spend and limits (the caller's own numbers go out as `mine`). */
  quotaLedger?: { ledger: SpendLedger; limits: LimitsStore };
  /**
   * WAVE 4 (ws): `?workspace=<id>` answers the numbers of that workspace. A member may read them (its own project numbers are
   * already visible to it); a non-member gets the same 404 as an unknown workspace.
   */
  workspace?: { roleOf: (userId: string, workspaceId: string) => 'owner' | 'editor' | 'viewer' | undefined; ledger: SpendLedger; limits: LimitsStore };
};

export async function registerQuotaRoutes(server: FastifyInstance, options: QuotaRouteOptions): Promise<void> {
  const config = new OpenRouterConfigStore(options.dataDir);
  // Every member polls this route each minute: the volume is walked once per cache window, not once per call.
  const storageMeter = options.storage ?? new StorageMeter(options.dataDir);
  server.get<{ Querystring: { workspace?: string } }>('/api/quota', async (request, reply) => {
    const me = sessionUser(options.userAuthStore, request);
    if (!me) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Masuk dulu' } });
    const wantedWorkspace = request.query?.workspace;
    if (typeof wantedWorkspace === 'string' && wantedWorkspace) {
      if (!options.workspace) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Workspace tidak ditemukan' } });
      const role = options.workspace.roleOf(me.id, wantedWorkspace);
      if (!role) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Workspace tidak ditemukan' } });
      // Numbers of the workspace only: no name, no member, nothing of a project.
      return {
        workspace: { id: wantedWorkspace, role },
        limits: options.workspace.limits.effectiveWorkspace(wantedWorkspace),
        usage: await options.workspace.ledger.workspaceUsage(wantedWorkspace)
      };
    }
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
      storage: { usedBytes: storage.usedBytes, diskFreeBytes: storage.diskFreeBytes },
      // The caller's own limits and use (ElevenLabs characters, Flow credits, OpenRouter $): never anybody else's.
      ...(options.quotaLedger ? { mine: { limits: options.quotaLedger.limits.effective(me.id), usage: await options.quotaLedger.ledger.usage(me.id) } } : {})
    };
  });
}
