import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openRouterBalance } from '../src/providers/balance.js';
import { OpenRouterConfigStore } from '../src/providers/config.js';

const KEY = 'sk-or-v1-balance-0123456789abcdef1234';

function keyEndpoint(body: unknown, status = 200) {
  const calls: Array<{ url: string; auth?: string }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') ?? undefined });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('openRouterBalance', () => {
  it('is null without a key (and never calls OpenRouter)', async () => {
    const { calls, fetchImpl } = keyEndpoint({});
    expect(await openRouterBalance(mkdtempSync(join(tmpdir(), 'nc-bal-')), { fetch: fetchImpl })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('reads GET /key usage, limit and limit_remaining with the key, cached 60 s', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-bal-'));
    await new OpenRouterConfigStore(dataDir).update({ apiKey: KEY });
    const { calls, fetchImpl } = keyEndpoint({ data: { usage: 1.25, limit: 10, limit_remaining: 8.75 } });
    let now = 5_000_000;
    const opts = { fetch: fetchImpl, now: () => now };
    expect(await openRouterBalance(dataDir, opts)).toEqual({ usedUsd: 1.25, limitUsd: 10, remainingUsd: 8.75 });
    expect(calls).toEqual([{ url: 'https://openrouter.ai/api/v1/key', auth: `Bearer ${KEY}` }]);
    now += 59_000;
    await openRouterBalance(dataDir, opts);
    expect(calls).toHaveLength(1);
    now += 2_000;
    await openRouterBalance(dataDir, opts);
    expect(calls).toHaveLength(2);
  });

  it('maps an unlimited key to null limit/remaining and a rejected key to null', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-bal-'));
    await new OpenRouterConfigStore(dataDir).update({ apiKey: KEY });
    const unlimited = keyEndpoint({ data: { usage: 3, limit: null, limit_remaining: null } });
    expect(await openRouterBalance(dataDir, { fetch: unlimited.fetchImpl, now: () => 1 })).toEqual({ usedUsd: 3, limitUsd: null, remainingUsd: null });
    const rejected = keyEndpoint({ error: { message: 'No auth' } }, 401);
    expect(await openRouterBalance(dataDir, { fetch: rejected.fetchImpl, now: () => 10_000_000 })).toBeNull();
  });
});
