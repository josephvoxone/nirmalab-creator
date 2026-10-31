/**
 * F7 — GET /api/quota is polled by every signed-in user every 60 s; each call used to walk the whole data
 * volume (measureStorage: 1.32 s for 20 000 files, 3.58 s for 10 at once). The scan is now cached with a short TTL,
 * shared by concurrent callers, and dropped after the storage janitor ran.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import * as storage from '../src/media/storage.js';

vi.mock('../src/media/storage.js', async importOriginal => {
  const mod = await importOriginal<typeof import('../src/media/storage.js')>();
  return { ...mod, measureStorage: vi.fn(mod.measureStorage) };
});
const measure = vi.mocked(storage.measureStorage);

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];
beforeEach(() => { measure.mockClear(); });
afterEach(async () => { vi.useRealTimers(); while (apps.length) await apps.pop()!.close(); });

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-sec-quota-'));
  const email = `admin-${Math.random().toString(16).slice(2, 10)}@x.io`;
  const server = await buildApp({
    dataDir, env: { OPENCREATOR_ADMIN_EMAIL: email, OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
    stories: { reconcileMs: 0 }, providers: { workerMs: 0 }, media: { cleanupMs: 0 }, dub: { resume: false }
  });
  apps.push(server);
  const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'admin-pass-1' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0]!;
  const quota = async () => (await server.inject({ url: '/api/quota', headers: { cookie } })).json().storage.usedBytes as number;
  const put = (name: string, bytes: number) => {
    mkdirSync(join(dataDir, 'stories', 's1'), { recursive: true });
    writeFileSync(join(dataDir, 'stories', 's1', name), Buffer.alloc(bytes, 1));
  };
  return { server, dataDir, cookie, quota, put };
}

describe('F7 GET /api/quota storage scan', () => {
  it('two calls within seconds scan the volume once', async () => {
    const t = await setup();
    t.put('a.bin', 4000);
    const first = await t.quota();
    const second = await t.quota();
    expect(first).toBeGreaterThanOrEqual(4000);
    expect(second).toBe(first);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('ten simultaneous callers share one scan', async () => {
    const t = await setup();
    t.put('a.bin', 100);
    await Promise.all(Array.from({ length: 10 }, () => t.quota()));
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('the cached figure expires: after the TTL the next call measures again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t = await setup();
    t.put('a.bin', 1000);
    const before = await t.quota();
    t.put('b.bin', 50_000);
    expect(await t.quota()).toBe(before);
    vi.setSystemTime(Date.now() + 61_000);
    expect(await t.quota()).toBeGreaterThanOrEqual(before + 50_000);
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it('the storage janitor (POST /api/storage/cleanup) drops the cached figure, so the sidebar shows the result at once', async () => {
    const t = await setup();
    t.put('a.bin', 1000);
    const before = await t.quota();
    t.put('b.bin', 70_000);
    expect(await t.quota()).toBe(before);                      // still cached
    const cleanup = await t.server.inject({ method: 'POST', url: '/api/storage/cleanup', headers: { cookie: t.cookie } });
    expect(cleanup.statusCode).toBe(200);
    expect(await t.quota()).toBeGreaterThanOrEqual(before + 70_000);
  });

  it('the admin GET /api/storage is always fresh and refreshes the cache', async () => {
    const t = await setup();
    t.put('a.bin', 1000);
    const before = await t.quota();
    t.put('b.bin', 30_000);
    const admin = (await t.server.inject({ url: '/api/storage', headers: { cookie: t.cookie } })).json();
    expect(admin.usedBytes).toBeGreaterThanOrEqual(before + 30_000);
    expect(await t.quota()).toBe(admin.usedBytes);
  });

  it('still needs a session', async () => {
    const t = await setup();
    expect((await t.server.inject('/api/quota')).statusCode).toBe(401);
    expect(measure).not.toHaveBeenCalled();
  });
});
