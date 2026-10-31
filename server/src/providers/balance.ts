/** OpenRouter balance for the quota endpoint and the story budget check (cached 60 s per data dir + key). */
import { createHash } from 'node:crypto';
import { keyBalance, type FetchLike, type OpenRouterBalance } from './client.js';
import { OpenRouterConfigStore } from './config.js';

const CACHE_MS = 60_000;
const cache = new Map<string, { atMs: number; keyHash: string; value: OpenRouterBalance | null }>();

export type BalanceOptions = { fetch?: FetchLike; now?: () => number };

export async function openRouterBalance(dataDir: string, options: BalanceOptions = {}): Promise<OpenRouterBalance | null> {
  const key = await new OpenRouterConfigStore(dataDir).apiKey();
  if (!key) return null;
  const now = (options.now ?? Date.now)();
  const keyHash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const hit = cache.get(dataDir);
  if (hit && hit.keyHash === keyHash && now - hit.atMs < CACHE_MS) return hit.value;
  let value: OpenRouterBalance | null;
  try {
    value = await keyBalance(options.fetch ?? fetch, key);
  } catch {
    value = null;
  }
  cache.set(dataDir, { atMs: now, keyHash, value });
  return value;
}

/** When the cached balance of this data dir was fetched (ms), or undefined when nothing is cached. */
export function openRouterBalanceAt(dataDir: string): number | undefined {
  return cache.get(dataDir)?.atMs;
}
