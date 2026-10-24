/**
 * Audit spend per UTC day, at `<dataDir>/providers/audit-spend.json` (0600).
 * Read by GET /api/quota (`audit: { spentUsdToday, shots }`); kept for 14 days, then pruned.
 * Money only — no prompts, no image paths, nothing about the content audited.
 */
import { join } from 'node:path';
import { readPrivateJsonFile, writePrivateJsonFile } from '../lib/private-json-file.js';

export type AuditDay = { usd: number; shots: number };
type Stored = { days?: Record<string, AuditDay> };

const KEEP_DAYS = 14;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export const dayKey = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

export class AuditLedger {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, 'providers', 'audit-spend.json');
  }

  private async read(): Promise<Record<string, AuditDay>> {
    try {
      const raw = (await readPrivateJsonFile(this.path)) as Stored | undefined;
      const days = raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object' ? raw.days : {};
      const clean: Record<string, AuditDay> = {};
      for (const [key, value] of Object.entries(days)) {
        if (!value || typeof value !== 'object') continue;
        const usd = typeof value.usd === 'number' && Number.isFinite(value.usd) ? value.usd : 0;
        const shots = typeof value.shots === 'number' && Number.isFinite(value.shots) ? value.shots : 0;
        clean[key] = { usd: round6(usd), shots };
      }
      return clean;
    } catch {
      return {};
    }
  }

  /** Adds one audited shot (cost is 0 when OpenRouter reports none: the shot still counts). */
  async record(entry: { atMs?: number; costUsd?: number } = {}): Promise<AuditDay> {
    const atMs = entry.atMs ?? Date.now();
    const costUsd = typeof entry.costUsd === 'number' && Number.isFinite(entry.costUsd) && entry.costUsd > 0 ? entry.costUsd : 0;
    const run = this.queue.then(async () => {
      const days = await this.read();
      const key = dayKey(atMs);
      const day = days[key] ?? { usd: 0, shots: 0 };
      const next = { usd: round6(day.usd + costUsd), shots: day.shots + 1 };
      days[key] = next;
      const keys = Object.keys(days).sort();
      for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete days[old];
      await writePrivateJsonFile(this.path, { days } satisfies Stored);
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Spend and shot count of the day `nowMs` falls in (0/0 when nothing was audited). */
  async today(nowMs = Date.now()): Promise<{ spentUsdToday: number; shots: number }> {
    const day = (await this.read())[dayKey(nowMs)];
    return { spentUsdToday: day?.usd ?? 0, shots: day?.shots ?? 0 };
  }
}
