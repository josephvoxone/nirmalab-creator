import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ElevenLabsClient } from '../src/dub/elevenlabs.js';
import { ProviderKeys, SingleKeyError } from '../src/lib/provider-keys.js';
import { ProviderInputError } from '../src/providers/config.js';

let dir: string;
const closers: Array<() => Promise<unknown>> = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nc-sk-')); });
afterEach(async () => { while (closers.length) await closers.pop()!().catch(() => undefined); rmSync(dir, { recursive: true, force: true }); });

const secret = (n: number) => `sk_test_${String(n).padStart(2, '0')}_0123456789abcdef0123456789`;
const file = () => join(dir, 'providers', 'keypool-elevenlabs.json');
const legacyFile = (n: number) => {
  mkdirSync(join(dir, 'providers'), { recursive: true });
  writeFileSync(file(), JSON.stringify({ keys: Array.from({ length: n }, (_, i) => ({ id: `k_${i + 1}`, label: `Key ${i + 1}`, key: secret(i + 1), addedAtMs: 1000 + i })) }), { mode: 0o600 });
};

describe('T6 ProviderKeys: ElevenLabs holds ONE active key', () => {
  it('the second key is refused with SATU_KUNCI and a clear message; the first stays', async () => {
    const keys = new ProviderKeys(dir, 'elevenlabs', { env: {} });
    await keys.load();
    await keys.add({ key: secret(1), label: 'Utama' });
    const error = await keys.add({ key: secret(2) }).catch(e => e);
    expect(error).toBeInstanceOf(SingleKeyError);
    expect(error).toBeInstanceOf(ProviderInputError);
    expect(error.code).toBe('SATU_KUNCI');
    expect(error.message).toBe('ElevenLabs hanya boleh satu kunci: Ketentuan Layanan melarang berbagi atau memutar beberapa akun. Pakai "Ganti kunci" untuk menggantinya.');
    expect(keys.pool.size()).toBe(1);
    expect(keys.view().map(v => v.label)).toEqual(['Utama']);
  });

  it('Gemini keeps its pool of up to 10', async () => {
    const keys = new ProviderKeys(dir, 'gemini', { env: {} });
    await keys.load();
    for (let i = 1; i <= 10; i++) await keys.add({ key: secret(i) });
    expect(keys.pool.size()).toBe(10);
    await expect(keys.add({ key: secret(11) })).rejects.toThrow(/maksimal 10/i);
  });

  it('old data with several keys: the first stays active, the others become dormant — kept on disk, not deleted, not in the pool', async () => {
    legacyFile(3);
    const keys = new ProviderKeys(dir, 'elevenlabs', { env: {} });
    await keys.load();
    expect(keys.pool.size()).toBe(1);
    expect(keys.view().map(v => v.id)).toEqual(['k_1']);
    expect(keys.dormantView().map(v => v.id)).toEqual(['k_2', 'k_3']);
    expect(JSON.stringify(keys.dormantView())).not.toContain(secret(2));
    expect(keys.dormantView()[0]!.keyHint).toBe(`••••${secret(2).slice(-4)}`);
    const onDisk = JSON.parse(readFileSync(file(), 'utf8'));
    expect(onDisk.keys.map((k: { id: string }) => k.id)).toEqual(['k_1']);
    expect(onDisk.dormant.map((k: { key: string }) => k.key)).toEqual([secret(2), secret(3)]);
    // idempotent: a second load changes nothing
    const again = new ProviderKeys(dir, 'elevenlabs', { env: {} });
    await again.load();
    expect(again.view().map(v => v.id)).toEqual(['k_1']);
    expect(again.dormantView().map(v => v.id)).toEqual(['k_2', 'k_3']);
  });

  it('a dormant key never reaches the provider: only the active key appears in xi-api-key', async () => {
    legacyFile(3);
    const keys = new ProviderKeys(dir, 'elevenlabs', { env: {} });
    await keys.load();
    const seen = new Set<string>();
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.add(String((init?.headers as Record<string, string>)['xi-api-key']));
      return new Response(Buffer.alloc(300, 1), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }) as unknown as typeof fetch;
    const client = new ElevenLabsClient({ keys, fetch: fetchImpl });
    for (let i = 0; i < 6; i++) await client.synthesize({ text: 'Halo dunia', voiceId: 'V1', modelId: 'eleven_multilingual_v2', languageCode: 'id' });
    expect([...seen]).toEqual([secret(1)]);
  });

  it('env ELEVENLABS_API_KEYS=a,b: only the first is used, the rest are dormant with a warning', async () => {
    const keys = new ProviderKeys(dir, 'elevenlabs', { env: { ELEVENLABS_API_KEYS: `${secret(7)},${secret(8)}` } });
    await keys.load();
    expect(keys.pool.size()).toBe(1);
    expect(keys.view()[0]).toMatchObject({ source: 'env', keyHint: `••••${secret(7).slice(-4)}` });
    expect(keys.dormantView()).toHaveLength(1);
    expect(keys.dormantView()[0]).toMatchObject({ source: 'env', keyHint: `••••${secret(8).slice(-4)}` });
    expect(keys.warnings().join(' ')).toMatch(/hanya kunci pertama/i);
    expect(JSON.stringify(keys.warnings())).not.toContain(secret(8));
    await expect(keys.add({ key: secret(1) })).rejects.toBeInstanceOf(SingleKeyError);
  });

  it('ELEVENLABS_API_KEY (single) wins over ELEVENLABS_API_KEYS', async () => {
    const keys = new ProviderKeys(dir, 'elevenlabs', { env: { ELEVENLABS_API_KEY: secret(5), ELEVENLABS_API_KEYS: `${secret(7)},${secret(8)}` } });
    await keys.load();
    expect(keys.secretOf(keys.view()[0]!.id)).toBe(secret(5));
    expect(keys.dormantView()).toHaveLength(2);
  });

  it('a stored key is not shadowed forever: if the env key goes away, the stored key is active again', async () => {
    const first = new ProviderKeys(dir, 'elevenlabs', { env: {} });
    await first.load();
    await first.add({ key: secret(1) });
    const withEnv = new ProviderKeys(dir, 'elevenlabs', { env: { ELEVENLABS_API_KEY: secret(5) } });
    await withEnv.load();
    expect(withEnv.view()).toHaveLength(1);
    expect(withEnv.view()[0]!.source).toBe('env');
    const without = new ProviderKeys(dir, 'elevenlabs', { env: {} });
    await without.load();
    expect(without.view().map(v => v.source)).toEqual(['store']);
    expect(without.secretOf(without.view()[0]!.id)).toBe(secret(1));
  });

  it('replaceActive swaps the key atomically; an invalid new key leaves the old one untouched', async () => {
    const keys = new ProviderKeys(dir, 'elevenlabs', { env: {} });
    await keys.load();
    const old = await keys.add({ key: secret(1), label: 'Lama' });
    await expect(keys.replaceActive({ key: 'short' })).rejects.toBeInstanceOf(ProviderInputError);
    expect(keys.view().map(v => v.id)).toEqual([old.id]);
    const next = await keys.replaceActive({ key: secret(2), label: 'Baru' });
    expect(next.label).toBe('Baru');
    expect(keys.view().map(v => v.label)).toEqual(['Baru']);
    expect(keys.pool.size()).toBe(1);
    expect(readFileSync(file(), 'utf8')).not.toContain(secret(1)); // the replaced key is gone
    expect(keys.secretOf(next.id)).toBe(secret(2));
  });

  it('replaceActive with no active key just adds it; with an env key it is refused (managed by the server)', async () => {
    const empty = new ProviderKeys(dir, 'elevenlabs', { env: {} });
    await empty.load();
    expect((await empty.replaceActive({ key: secret(1) })).keyHint).toContain(secret(1).slice(-4));
    const dir2 = mkdtempSync(join(tmpdir(), 'nc-sk2-'));
    try {
      const envKeys = new ProviderKeys(dir2, 'elevenlabs', { env: { ELEVENLABS_API_KEY: secret(5) } });
      await envKeys.load();
      await expect(envKeys.replaceActive({ key: secret(1) })).rejects.toThrow(/environment/i);
    } finally { rmSync(dir2, { recursive: true, force: true }); }
  });

  it('activate swaps a dormant key in; the former active key becomes dormant (nothing is lost)', async () => {
    legacyFile(2);
    const keys = new ProviderKeys(dir, 'elevenlabs', { env: {} });
    await keys.load();
    await keys.activate('k_2');
    expect(keys.view().map(v => v.id)).toEqual(['k_2']);
    expect(keys.dormantView().map(v => v.id)).toEqual(['k_1']);
    expect(keys.secretOf('k_2')).toBe(secret(2));
    const again = new ProviderKeys(dir, 'elevenlabs', { env: {} });
    await again.load();
    expect(again.view().map(v => v.id)).toEqual(['k_2']);
    expect(await keys.activate('nope')).toBe(false);
  });

  it('removing the active key does NOT promote a dormant one silently; removing a dormant key works', async () => {
    legacyFile(3);
    const keys = new ProviderKeys(dir, 'elevenlabs', { env: {} });
    await keys.load();
    expect(await keys.remove('k_1')).toBe(true);
    expect(keys.pool.size()).toBe(0);
    expect(keys.dormantView().map(v => v.id)).toEqual(['k_2', 'k_3']);
    expect(await keys.remove('k_3')).toBe(true);
    expect(keys.dormantView().map(v => v.id)).toEqual(['k_2']);
    const again = new ProviderKeys(dir, 'elevenlabs', { env: {} });
    await again.load();
    expect(again.pool.size()).toBe(0);
    expect(again.dormantView().map(v => v.id)).toEqual(['k_2']);
  });
});

describe('T6 app: one-key concurrency, routes', () => {
  async function boot(options: { legacy?: number; env?: Record<string, string>; queues?: { dub?: number } } = {}) {
    if (options.legacy) legacyFile(options.legacy);
    const probes: string[] = []; const used = new Set<string>();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const key = String((init?.headers as Record<string, string> | undefined)?.['xi-api-key'] ?? '');
      if (url.endsWith('/v1/user/subscription')) {
        probes.push(key);
        return new Response(JSON.stringify(key.includes('REJECTME') ? { detail: { status: 'invalid_api_key' } } : { tier: 'creator', character_count: 1, character_limit: 100000 }), { status: key.includes('REJECTME') ? 401 : 200, headers: { 'content-type': 'application/json' } });
      }
      used.add(key);
      return new Response(JSON.stringify({ voices: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const server = await buildApp({
      dataDir: dir, env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1', ...(options.env ?? {}) },
      stories: { reconcileMs: 0 }, providers: { fetch: fetchImpl, workerMs: 0 }, dub: { fetch: fetchImpl, resume: false }, ...(options.queues ? { queues: options.queues } : {})
    });
    closers.push(() => server.close());
    const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => server.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
    return { server, req, probes, used };
  }

  it('dubQueue concurrency drops to what one key can carry (2), whatever DUB_CONCURRENCY says', async () => {
    const a = await boot();
    expect((await a.req('GET', '/api/system/load')).json().dub.concurrency).toBe(2);
    await a.server.close(); closers.pop();
    rmSync(join(dir, 'providers'), { recursive: true, force: true });
    const b = await boot({ env: { DUB_CONCURRENCY: '1' } });
    expect((await b.req('GET', '/api/system/load')).json().dub.concurrency).toBe(1);
  });

  it('POST a second key: 409 SATU_KUNCI, and ElevenLabs is not even asked to check it', async () => {
    const t = await boot();
    expect((await t.req('POST', '/api/providers/keypool/elevenlabs', { key: secret(1) })).statusCode).toBe(201);
    const before = t.probes.length;
    const second = await t.req('POST', '/api/providers/keypool/elevenlabs', { key: secret(2) });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('SATU_KUNCI');
    expect(second.json().error.message).toMatch(/hanya boleh satu kunci/);
    expect(t.probes).toHaveLength(before);
  });

  it('GET lists the single key, max 1, and the dormant ones (masked); the old pool of 3 is migrated at boot', async () => {
    const t = await boot({ legacy: 3 });
    const list = (await t.req('GET', '/api/providers/keypool')).json();
    expect(list.elevenlabs.max).toBe(1);
    expect(list.elevenlabs.keys).toHaveLength(1);
    expect(list.elevenlabs.dormant).toHaveLength(2);
    expect(JSON.stringify(list)).not.toContain('sk_test_');
    expect(list.gemini.max).toBe(10);
    const dub = await t.req('GET', '/api/dub/voices');
    expect(dub.statusCode).toBe(200);
    expect([...t.used]).toEqual([secret(1)]);
  });

  it('PUT /active: probes the new key first; refused keys change nothing; accepted keys replace the old one', async () => {
    const t = await boot();
    await t.req('POST', '/api/providers/keypool/elevenlabs', { key: secret(1) });
    const bad = await t.req('PUT', '/api/providers/keypool/elevenlabs/active', { key: 'REJECTME_0123456789abcdef0123456789' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_KEY');
    expect((await t.req('GET', '/api/providers/keypool')).json().elevenlabs.keys).toHaveLength(1);
    expect(readFileSync(file(), 'utf8')).toContain(secret(1));
    const ok = await t.req('PUT', '/api/providers/keypool/elevenlabs/active', { key: secret(2), label: 'Baru' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().key.label).toBe('Baru');
    expect(readFileSync(file(), 'utf8')).not.toContain(secret(1));
    expect((await t.req('GET', '/api/providers/keypool')).json().elevenlabs.keys).toHaveLength(1);
  });

  it('POST /:id/activate swaps a dormant key in; DELETE removes a dormant key; both admin only', async () => {
    const t = await boot({ legacy: 2 });
    const list = (await t.req('GET', '/api/providers/keypool')).json().elevenlabs;
    const dormantId = list.dormant[0].id as string;
    const activated = await t.req('POST', `/api/providers/keypool/elevenlabs/${dormantId}/activate`);
    expect(activated.statusCode).toBe(200);
    const after = (await t.req('GET', '/api/providers/keypool')).json().elevenlabs;
    expect(after.keys.map((k: { id: string }) => k.id)).toEqual([dormantId]);
    expect(after.dormant).toHaveLength(1);
    expect((await t.req('POST', '/api/providers/keypool/elevenlabs/nope/activate')).statusCode).toBe(404);
    expect((await t.req('DELETE', `/api/providers/keypool/elevenlabs/${after.dormant[0].id}`)).statusCode).toBe(200);
    expect((await t.req('GET', '/api/providers/keypool')).json().elevenlabs.dormant).toHaveLength(0);
    const anon = await t.server.inject({ method: 'POST', url: `/api/providers/keypool/elevenlabs/${dormantId}/activate` });
    expect(anon.statusCode).toBe(401);
  });

  it('env keys: the first is active, the rest are listed as dormant with a warning for the UI', async () => {
    const t = await boot({ env: { ELEVENLABS_API_KEYS: `${secret(7)},${secret(8)}` } });
    const list = (await t.req('GET', '/api/providers/keypool')).json().elevenlabs;
    expect(list.keys).toHaveLength(1);
    expect(list.dormant).toHaveLength(1);
    expect(list.warnings.join(' ')).toMatch(/hanya kunci pertama/i);
  });
});
