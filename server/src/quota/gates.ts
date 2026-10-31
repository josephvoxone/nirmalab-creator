/**
 * The money gates that sit on top of the ledger: one for the job queue (Flow credits / OpenRouter USD) and the
 * OpenRouter balance view that subtracts what is already promised. Nothing here runs inside the ledger or the
 * FlowStore queue except plain ledger calls: prices and balances are fetched in `prepare`, before the queue.
 */
import { jobCredits, type CreateJobInput, type FlowJob, type JobGate } from '../flow/store.js';
import type { OpenRouterBalance } from '../providers/client.js';
import type { SpendLedger } from './ledger.js';
import type { LimitResolver } from './limits.js';

/** Owner of a job nobody queued by name (covers, tests, legacy projects): counted, never limited. */
export const UNATTRIBUTED = 'system:unattributed';

export type JobPrices = {
  usdPerClip: (model: string) => Promise<number | null>;
  usdPerImage: (model: string) => Promise<number | null>;
};

type Prepared = { usd?: number; ceiling?: { remaining: number; sinceMs: number } };

export type BalanceSource = {
  /** Cached OpenRouter balance (60 s). */
  balance: () => Promise<OpenRouterBalance | null>;
  /** When that cached balance was fetched (ms), or undefined when unknown. */
  fetchedAtMs: () => number | undefined;
};

export class FlowGate implements JobGate {
  constructor(private readonly deps: { ledger: SpendLedger; prices: JobPrices; balance?: BalanceSource }) {}

  async prepare(input: CreateJobInput): Promise<Prepared> {
    if (input.provider !== 'openrouter' || !input.model) return {};
    const video = (input.kind ?? 'video') === 'video';
    const usd = await (video ? this.deps.prices.usdPerClip(input.model) : this.deps.prices.usdPerImage(input.model)).catch(() => null);
    if (typeof usd !== 'number' || !(usd > 0)) return {}; // unknown price: nothing to reserve (the spend is still recorded when it completes)
    const out: Prepared = { usd };
    if (!input.budgetOverride && this.deps.balance) {
      const balance = await this.deps.balance.balance().catch(() => null);
      const at = this.deps.balance.fetchedAtMs();
      if (typeof balance?.remainingUsd === 'number' && at !== undefined) out.ceiling = { remaining: balance.remainingUsd, sinceMs: at };
    }
    return out;
  }

  async reserve(job: FlowJob, prepared: unknown): Promise<void> {
    const userId = job.createdBy || UNATTRIBUTED;
    const prep = (prepared ?? {}) as Prepared;
    const provider = job.provider ?? 'flow';
    if (provider === 'flow') {
      const credits = jobCredits(job.kind);
      if (credits > 0) await this.deps.ledger.reserve({ key: `job:${job.id}`, userId, kind: 'flowCredits', amount: credits, meta: { job: job.kind } });
      return;
    }
    if (provider === 'openrouter' && prep.usd) {
      await this.deps.ledger.reserve({ key: `job:${job.id}`, userId, kind: 'openrouterUsd', amount: prep.usd, meta: { job: job.kind, model: job.model ?? '' }, ...(prep.ceiling ? { ceiling: prep.ceiling } : {}) });
    }
    // Axcel is paid by its own plan: no ledger kind.
  }

  async settle(job: FlowJob, outcome: 'done' | 'failed'): Promise<void> {
    const key = `job:${job.id}`;
    if (outcome === 'failed') return this.deps.ledger.release(key);
    const userId = job.createdBy || UNATTRIBUTED;
    const provider = job.provider ?? 'flow';
    if (provider === 'openrouter') {
      const actual = typeof job.result?.costUsd === 'number' && Number.isFinite(job.result.costUsd) && job.result.costUsd >= 0 ? job.result.costUsd : undefined;
      // A job queued before the ledger existed (or with an unknown price) has no reservation: its real cost is still counted.
      return this.deps.ledger.commit(key, actual, actual ? { userId, kind: 'openrouterUsd', meta: { job: job.kind } } : undefined);
    }
    return this.deps.ledger.commit(key);
  }

  /** For the sweep: a `job:` reservation is live while its job is still queued or running. */
  static isLive(find: (id: string) => Promise<FlowJob | undefined>): (key: string) => Promise<boolean> {
    return async key => {
      if (!key.startsWith('job:')) return true;
      const job = await find(key.slice(4));
      return job !== undefined && (job.status === 'queued' || job.status === 'running');
    };
  }
}

/**
 * OpenRouter balance as the budget checks should see it: the cached balance minus everything already promised (open
 * reservations of every user) and everything spent since that snapshot. Closes the 60 s cache window between users.
 */
export function committedBalance(ledger: SpendLedger, source: BalanceSource): () => Promise<OpenRouterBalance | null> {
  return async () => {
    const balance = await source.balance();
    if (!balance || typeof balance.remainingUsd !== 'number') return balance;
    const at = source.fetchedAtMs();
    const held = await ledger.inFlight('openrouterUsd', at ?? Date.now());
    return { ...balance, remainingUsd: Math.max(0, Math.round((balance.remainingUsd - held) * 1e6) / 1e6) };
  };
}

/** Estimated cost of one vision audit, held for an owner who has an OpenRouter limit (the real cost replaces it). */
export const AUDIT_ESTIMATE_USD = 0.01;

/** What `StoryService` asks of the quota: a friendly pre-flight of a run, and the hold around one vision audit. */
export function storyQuota(ledger: SpendLedger, limitFor: LimitResolver) {
  return {
    check: async (userId: string | undefined, amounts: Partial<Record<'flowCredits' | 'openrouterUsd', number>>): Promise<void> => {
      if (!userId) return;
      await ledger.precheck((Object.entries(amounts) as Array<['flowCredits' | 'openrouterUsd', number]>).map(([kind, amount], i) => ({ key: `precheck:${i}`, userId, kind, amount })));
    },
    audit: async (userId: string | undefined, key: string): Promise<{ commit: (actualUsd?: number) => Promise<void>; release: () => Promise<void> }> => {
      const owner = userId || UNATTRIBUTED;
      const limit = limitFor(owner, 'openrouterUsd');
      if (limit && (limit.perDay != null || limit.per30d != null)) {
        await ledger.reserve({ key, userId: owner, kind: 'openrouterUsd', amount: AUDIT_ESTIMATE_USD });
        return { commit: a => ledger.commit(key, a), release: () => ledger.release(key) };
      }
      // No limit: nothing to hold, but the real cost is counted (observability).
      return { commit: async a => { if (typeof a === 'number' && a > 0) await ledger.record({ key, userId: owner, kind: 'openrouterUsd', amount: a }); }, release: async () => undefined };
    }
  };
}
