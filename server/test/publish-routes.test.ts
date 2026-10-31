import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { UserAuthStore } from '../src/auth/store.js';
import { registerPublisherRoutes, type PublisherService } from '../src/publisher/index.js';
import { buildApp } from '../src/app.js';

const DONE_ID = 'story_0123456789abcdef';

async function setup(resolveStoryVideo?: (id: string) => Promise<string | undefined>) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nc-pub-'));
  const userAuthStore = new UserAuthStore(dataDir);
  const admin = await userAuthStore.createUser({ email: 'admin@x.io', password: 'admin-pass-1', isAdmin: true });
  const member = await userAuthStore.createUser({ email: 'member@x.io', password: 'member-pass-1', isAdmin: false });
  const publish = vi.fn(async (platform: string, _input: unknown) => ({ ok: true as const, platform, externalId: 'vid1' }));
  const handleCallback = vi.fn(async (_platform: string, query: { error?: string }) => {
    if (query.error) {
      const { PublisherError } = await import('../src/publisher/types.js');
      throw new PublisherError('OAUTH_DENIED', `Provider refused: ${query.error}`);
    }
    return { accountLabel: 'Chan' };
  });
  const service = { publish, handleCallback } as unknown as PublisherService;
  const server = Fastify();
  await registerPublisherRoutes(server, { service, userAuthStore, env: {}, resolveStoryVideo });
  await server.ready();
  const cookie = (id: string) => `oc_session=${userAuthStore.createSession(id).token}`;
  return { server, publish, adminId: admin.id, adminCookie: cookie(admin.id), memberCookie: cookie(member.id) };
}

const body = { title: 'Kucing Hilang', description: 'desc', visibility: 'public' };

describe('publish route with storyId', () => {
  it('publishes a done story by resolving its final video path', async () => {
    const resolve = vi.fn(async (id: string) => (id === DONE_ID ? '/data/stories/story_0123456789abcdef/final.mp4' : undefined));
    const { server, publish, adminCookie, adminId } = await setup(resolve);
    const res = await server.inject({ method: 'POST', url: '/api/publish/youtube/publish', headers: { cookie: adminCookie }, payload: { ...body, storyId: DONE_ID } });
    expect(res.statusCode).toBe(200);
    expect(resolve).toHaveBeenCalledWith(DONE_ID);
    expect(publish).toHaveBeenCalledWith(adminId, 'youtube', {
      filePath: '/data/stories/story_0123456789abcdef/final.mp4',
      title: 'Kucing Hilang',
      description: 'desc',
      visibility: 'public'
    });
  });

  it('answers 404 for an unknown or unfinished story and does not publish', async () => {
    const { server, publish, adminCookie } = await setup(async () => undefined);
    const res = await server.inject({ method: 'POST', url: '/api/publish/youtube/publish', headers: { cookie: adminCookie }, payload: { ...body, storyId: 'story_ffffffffffffffff' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects a malformed storyId with 400 before resolving', async () => {
    const resolve = vi.fn(async () => '/etc/passwd');
    const { server, publish, adminCookie } = await setup(resolve);
    const res = await server.inject({ method: 'POST', url: '/api/publish/youtube/publish', headers: { cookie: adminCookie }, payload: { ...body, storyId: '../../etc/passwd' } });
    expect(res.statusCode).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('ignores a browser filePath when a storyId is given', async () => {
    const { server, publish, adminCookie } = await setup(async () => '/data/final.mp4');
    await server.inject({ method: 'POST', url: '/api/publish/youtube/publish', headers: { cookie: adminCookie }, payload: { ...body, storyId: DONE_ID, filePath: '/etc/passwd' } });
    expect(publish.mock.calls[0]?.[2]).toMatchObject({ filePath: '/data/final.mp4' });
  });

  it('refuses a raw filePath from a non-admin caller', async () => {
    const { server, publish, memberCookie } = await setup(async () => undefined);
    const res = await server.inject({ method: 'POST', url: '/api/publish/youtube/publish', headers: { cookie: memberCookie }, payload: { ...body, filePath: '/etc/passwd' } });
    expect(res.statusCode).toBe(403);
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses a raw filePath even from an admin: only finished stories can be published', async () => {
    const { server, publish, adminCookie } = await setup(async () => undefined);
    const res = await server.inject({ method: 'POST', url: '/api/publish/youtube/publish', headers: { cookie: adminCookie }, payload: { ...body, filePath: '/etc/passwd' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/storyId/);
    expect(publish).not.toHaveBeenCalled();
  });

  it('OAuth callback success returns to Settings → Koneksi with ?connected=PLATFORM', async () => {
    const { server } = await setup(undefined);
    const res = await server.inject({ url: '/api/publish/tiktok/callback?code=c&state=s' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://creator.nirmalab.com/pengaturan/koneksi?connected=tiktok');
  });

  it('OAuth callback failure returns to Settings → Koneksi with a plain ?error message', async () => {
    const { server } = await setup(undefined);
    const res = await server.inject({ url: '/api/publish/youtube/callback?error=access_denied&state=x' });
    expect(res.statusCode).toBe(302);
    const location = new URL(String(res.headers.location));
    expect(location.origin + location.pathname).toBe('https://creator.nirmalab.com/pengaturan/koneksi');
    expect(location.searchParams.get('platform')).toBe('youtube');
    expect(location.searchParams.get('connected')).toBeNull();
    expect(location.searchParams.get('error')).toMatch(/izin.*ditolak/i);
    expect(String(res.headers.location)).not.toContain('#/');
  });

  it('passes a future publishAt to YouTube as an ISO string', async () => {
    const { server, publish, adminCookie } = await setup(async () => '/data/final.mp4');
    const at = new Date(Date.now() + 3 * 86_400_000);
    const res = await server.inject({ method: 'POST', url: '/api/publish/youtube/publish', headers: { cookie: adminCookie }, payload: { ...body, storyId: DONE_ID, publishAt: at.toISOString() } });
    expect(res.statusCode).toBe(200);
    expect(publish.mock.calls[0]?.[2]).toMatchObject({ publishAt: at.toISOString() });
  });

  it('omits publishAt when none is sent', async () => {
    const { server, publish, adminCookie } = await setup(async () => '/data/final.mp4');
    await server.inject({ method: 'POST', url: '/api/publish/youtube/publish', headers: { cookie: adminCookie }, payload: { ...body, storyId: DONE_ID } });
    expect(publish.mock.calls[0]?.[2]).not.toHaveProperty('publishAt');
  });

  it('rejects a publishAt in the past or unparseable with 400', async () => {
    const { server, publish, adminCookie } = await setup(async () => '/data/final.mp4');
    for (const publishAt of [new Date(Date.now() - 60_000).toISOString(), 'besok sore', 12345]) {
      const res = await server.inject({ method: 'POST', url: '/api/publish/youtube/publish', headers: { cookie: adminCookie }, payload: { ...body, storyId: DONE_ID, publishAt } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_INPUT');
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects publishAt for TikTok and Meta: only YouTube can schedule', async () => {
    const { server, publish, adminCookie } = await setup(async () => '/data/final.mp4');
    const publishAt = new Date(Date.now() + 86_400_000).toISOString();
    for (const platform of ['tiktok', 'meta']) {
      const res = await server.inject({ method: 'POST', url: `/api/publish/${platform}/publish`, headers: { cookie: adminCookie }, payload: { ...body, storyId: DONE_ID, publishAt } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/youtube/i);
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it('answers 404 for storyId when no resolver is configured', async () => {
    const { server, publish, adminCookie } = await setup(undefined);
    const res = await server.inject({ method: 'POST', url: '/api/publish/youtube/publish', headers: { cookie: adminCookie }, payload: { ...body, storyId: DONE_ID } });
    expect(res.statusCode).toBe(404);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('buildApp wires publish storyId to the story service', () => {
  async function appWithAdmin() {
    const dataDir = mkdtempSync(join(tmpdir(), 'nc-pubapp-'));
    const server = await buildApp({
      dataDir,
      env: { OPENCREATOR_ADMIN_EMAIL: 'admin@x.io', OPENCREATOR_ADMIN_PASSWORD: 'admin-pass-1' },
      stories: { reconcileMs: 0, probe: async () => ({ durationSec: 6, hasAudio: true }), assemble: async dir => writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(10)) }
    });
    const res = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@x.io', password: 'admin-pass-1' } });
    return { server, dataDir, cookie: String(res.headers['set-cookie']).split(';')[0]! };
  }

  it('404 for a story that does not exist, 404 for a draft story, reaches the publisher for a done story', async () => {
    const { server, dataDir, cookie } = await appWithAdmin();
    const missing = await server.inject({ method: 'POST', url: '/api/publish/youtube/publish', headers: { cookie }, payload: { ...body, storyId: DONE_ID } });
    expect(missing.statusCode).toBe(404);

    const board = { title: 'T', audio: 'Audio: "{line}"', shots: [{ id: '00-a', silent: true, prompt: 'Wide shot of a valley.' }] };
    const story = (await server.inject({ method: 'POST', url: '/api/stories', headers: { cookie }, payload: { storyboard: board } })).json().story;
    const draft = await server.inject({ method: 'POST', url: '/api/publish/youtube/publish', headers: { cookie }, payload: { ...body, storyId: story.id } });
    expect(draft.statusCode).toBe(404);

    // Mark the story done on disk; the publisher (not connected) must then be reached → 409 NOT_CONNECTED.
    const recordPath = join(dataDir, 'stories', story.id, 'story.json');
    const { readFileSync } = await import('node:fs');
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    writeFileSync(recordPath, JSON.stringify({ ...record, status: 'done' }));
    const done = await server.inject({ method: 'POST', url: '/api/publish/youtube/publish', headers: { cookie }, payload: { ...body, storyId: story.id } });
    expect(done.json().error.code).toMatch(/NOT_CONNECTED|NOT_CONFIGURED/);
  });
});
