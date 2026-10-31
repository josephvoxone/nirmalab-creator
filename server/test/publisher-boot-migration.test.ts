import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { UserAuthStore } from '../src/auth/store.js';
import { writeLegacyTokens } from './publisher-legacy-fixtures.js';

const youtubeEnv = {
  OPENCREATOR_PUBLISHER_YOUTUBE_CLIENT_ID: 'yt-id',
  OPENCREATOR_PUBLISHER_YOUTUBE_CLIENT_SECRET: 'yt-secret'
};

async function boot(env: Record<string, string> = {}, seed?: (dataDir: string, auth: UserAuthStore) => Promise<void>) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-pubboot-'));
  const auth = new UserAuthStore(dataDir);
  const joseph = await auth.createUser({ email: 'joseph@example.com', password: 'joseph-pass-1', isAdmin: true });
  const bina = await auth.createUser({ email: 'bina@example.com', password: 'bina-pass-123', isAdmin: true });
  const mira = await auth.createUser({ email: 'mira@example.com', password: 'mira-pass-123', isAdmin: false });
  await seed?.(dataDir, auth);
  const server = await buildApp({ dataDir, env: { ...youtubeEnv, ...env }, stories: { reconcileMs: 0 } });
  const login = async (email: string, password: string) => {
    const res = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    return String(res.headers['set-cookie']).split(';')[0]!;
  };
  const youtube = async (cookie: string) =>
    ((await server.inject({ url: '/api/publish/status', headers: { cookie } })).json() as { publishers: Array<{ platform: string; connected: boolean; accountLabel?: string }> })
      .publishers.find(p => p.platform === 'youtube')!;
  return { dataDir, server, joseph, bina, mira, youtube, joseph$: () => login('joseph@example.com', 'joseph-pass-1'), bina$: () => login('bina@example.com', 'bina-pass-123'), mira$: () => login('mira@example.com', 'mira-pass-123') };
}

describe('T7.2 — the pre-tenancy global token is adopted by the main owner at boot', () => {
  it('Joseph (oldest non-QA admin) still sees his YouTube connection after boot; Bina and Mira do not see it', async () => {
    const w = await boot({}, async dataDir => { writeLegacyTokens(dataDir); });
    expect(await w.youtube(await w.joseph$())).toMatchObject({ connected: true, accountLabel: 'Lentera Channel' });
    expect((await w.youtube(await w.bina$())).connected).toBe(false);
    expect((await w.youtube(await w.mira$())).connected).toBe(false);
  });

  it('TENANCY_DEFAULT_OWNER_EMAIL picks the owner explicitly (here the second admin)', async () => {
    const w = await boot({ TENANCY_DEFAULT_OWNER_EMAIL: 'Bina@Example.com' }, async dataDir => { writeLegacyTokens(dataDir); });
    expect(await w.youtube(await w.bina$())).toMatchObject({ connected: true, accountLabel: 'Lentera Channel' });
    expect((await w.youtube(await w.joseph$())).connected).toBe(false);
  });

  it('an unknown TENANCY_DEFAULT_OWNER_EMAIL migrates nothing: the legacy file stays put, nobody gets the token', async () => {
    const w = await boot({ TENANCY_DEFAULT_OWNER_EMAIL: 'nobody@example.com' }, async dataDir => { writeLegacyTokens(dataDir); });
    for (const who of [w.joseph$, w.bina$, w.mira$]) expect((await w.youtube(await who())).connected).toBe(false);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(w.dataDir, 'publisher', 'youtube.json'))).toBe(true);
  });

  it('booting twice changes nothing the second time', async () => {
    const w = await boot({}, async dataDir => { writeLegacyTokens(dataDir); });
    const { readdirSync } = await import('node:fs');
    const before = readdirSync(join(w.dataDir, 'publisher')).sort();
    const again = await buildApp({ dataDir: w.dataDir, env: youtubeEnv, stories: { reconcileMs: 0 } });
    await again.ready();
    expect(readdirSync(join(w.dataDir, 'publisher')).sort()).toEqual(before);
  });
});
