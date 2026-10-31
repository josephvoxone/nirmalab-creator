import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ElevenLabsClient } from '../src/dub/elevenlabs.js';
import { ProviderKeys } from '../src/lib/provider-keys.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'elbal-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sub = (used: number, limit: number) => json(200, { tier: 'creator', character_count: used, character_limit: limit });
const KEYS = ['sk_balance_key_number_one_0001', 'sk_balance_key_number_two_0002'];

let seq = 0;
async function client(answer: (key: string) => Response | Promise<Response>, keys = KEYS) {
  // These tests exercise the pool's rotation across keys (429 -> next key). ElevenLabs itself is limited to ONE key in the app
  // (see eleven-single-key.test.ts); `maxKeys: 10` here lifts that on purpose so the rotation machinery stays covered.
  const pool = new ProviderKeys(join(dir, `p${seq++}`), 'elevenlabs', { env: {}, maxKeys: 10 });
  await pool.load();
  for (const key of keys) await pool.add({ key });
  const fetch = (async (_url: unknown, init?: RequestInit) => answer((init?.headers as Record<string, string>)['xi-api-key']!)) as unknown as typeof globalThis.fetch;
  return new ElevenLabsClient({ keys: pool, fetch });
}

describe('ElevenLabsClient.balance (free calls)', () => {
  it('sums what every key can still spend', async () => {
    const c = await client(key => (key === KEYS[0] ? sub(1_000, 10_000) : sub(500, 2_500)));
    expect(await c.balance()).toBe(9_000 + 2_000);
  });
  it('a key the provider refuses counts for nothing; the others still decide', async () => {
    const c = await client(key => (key === KEYS[0] ? json(401, { detail: { status: 'invalid_api_key' } }) : sub(0, 3_000)));
    expect(await c.balance()).toBe(3_000);
  });
  it('unknown when any key hides its balance (text-to-speech-only key) or cannot be asked: never a reason to refuse', async () => {
    const hidden = await client(key => (key === KEYS[0] ? json(401, { detail: { status: 'missing_permissions' } }) : sub(0, 3_000)));
    expect(await hidden.balance()).toBeUndefined();
    const down = await client(key => (key === KEYS[0] ? Promise.reject(new Error('offline')) : sub(0, 3_000)));
    expect(await down.balance()).toBeUndefined();
    expect(await (await client(() => sub(0, 1), [])).balance()).toBeUndefined();
  });
});
