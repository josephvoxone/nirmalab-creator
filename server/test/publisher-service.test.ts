import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PublisherService } from '../src/publisher/service.js';

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const env = {
  OPENCREATOR_PUBLIC_URL: 'https://creator.example.com',
  OPENCREATOR_PUBLISHER_YOUTUBE_CLIENT_ID: 'yt-id',
  OPENCREATOR_PUBLISHER_YOUTUBE_CLIENT_SECRET: 'yt-secret'
} as NodeJS.ProcessEnv;

const U = 'u_tester';

function service(fetchImpl: never) {
  return new PublisherService({ dataDir: mkdtempSync(join(tmpdir(), 'pub-')), env, fetchImpl });
}

describe('publisher service', () => {
  it('reports unconfigured platforms and unconnected youtube', async () => {
    const svc = service(vi.fn() as never);
    const all = await svc.statuses(U);
    expect(all.find(s => s.platform === 'youtube')).toMatchObject({ configured: true, connected: false });
    expect(all.find(s => s.platform === 'tiktok')).toMatchObject({ configured: false, connected: false });
    expect(all.find(s => s.platform === 'meta')).toMatchObject({ configured: false, connected: false });
  });

  it('connect URL embeds redirect + state; callback rejects bad state', async () => {
    const svc = service(vi.fn() as never);
    const { url, state } = svc.connectUrl(U, 'youtube');
    expect(url).toContain('https%3A%2F%2Fcreator.example.com%2Fapi%2Fpublish%2Fyoutube%2Fcallback');
    expect(url).toContain(`state=${state}`);
    await expect(svc.handleCallback('youtube', { code: 'c', state: 'nope' }, U))
      .rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('youtube callback exchanges, labels, and publishes', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ snippet: { title: 'Chan' } }] }))
      .mockResolvedValueOnce(jsonResponse({}, 200, { location: 'https://sess/1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'vid1' }));
    const svc = service(fetchImpl as never);
    const { state } = svc.connectUrl(U, 'youtube');
    const done = await svc.handleCallback('youtube', { code: 'code1', state }, U);
    expect(done).toEqual({ accountLabel: 'Chan' });
    expect(await svc.getStatus(U, 'youtube')).toMatchObject({ connected: true, accountLabel: 'Chan' });
    // Publish via service uses node fs; write a tiny temp file instead.
    const { writeFileSync } = await import('node:fs');
    const tmp = join(mkdtempSync(join(tmpdir(), 'pubvid-')), 'v.mp4');
    writeFileSync(tmp, Buffer.alloc(8));
    const out = await svc.publish(U, 'youtube', { filePath: tmp, title: 'T', visibility: 'private' });
    expect(out).toMatchObject({ ok: true, externalId: 'vid1', url: 'https://www.youtube.com/watch?v=vid1' });
  });

  it('publish without connection fails cleanly; unknown platform 404-shape', async () => {
    const svc = service(vi.fn() as never);
    await expect(svc.publish(U, 'youtube', { filePath: '/x.mp4', title: 'T' }))
      .rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(svc.publish(U, 'tiktok', { filePath: '/x.mp4', title: 'T' }))
      .rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('a scheduled YouTube publish reaches the upload metadata as status.publishAt', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ snippet: { title: 'Chan' } }] }))
      .mockResolvedValueOnce(jsonResponse({}, 200, { location: 'https://sess/1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'vid1' }));
    const svc = service(fetchImpl as never);
    const { state } = svc.connectUrl(U, 'youtube');
    await svc.handleCallback('youtube', { code: 'code1', state }, U);
    const { writeFileSync } = await import('node:fs');
    const tmp = join(mkdtempSync(join(tmpdir(), 'pubvid-')), 'v.mp4');
    writeFileSync(tmp, Buffer.alloc(8));
    await svc.publish(U, 'youtube', { filePath: tmp, title: 'T', visibility: 'public', publishAt: '2031-05-06T07:00:00.000Z' });
    const init = fetchImpl.mock.calls[2]?.[1] as RequestInit;
    expect(String(fetchImpl.mock.calls[2]?.[0])).toContain('/upload/youtube/v3/videos');
    expect(JSON.parse(String(init.body)).status).toEqual({ privacyStatus: 'private', publishAt: '2031-05-06T07:00:00.000Z' });
  });

  it('refuses to schedule on TikTok or Meta', async () => {
    const svc = service(vi.fn() as never);
    for (const platform of ['tiktok', 'meta'] as const) {
      await expect(svc.publish(U, platform, { filePath: '/x.mp4', title: 'T', publishAt: '2031-05-06T07:00:00.000Z' }))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  it('status names the env vars the server still needs for an unconfigured platform', async () => {
    const svc = service(vi.fn() as never);
    const all = await svc.statuses(U);
    expect(all.find(s => s.platform === 'youtube')?.missingEnv).toEqual([]);
    expect(all.find(s => s.platform === 'tiktok')?.missingEnv).toEqual(['OPENCREATOR_PUBLISHER_TIKTOK_CLIENT_KEY', 'OPENCREATOR_PUBLISHER_TIKTOK_CLIENT_SECRET']);
    expect(all.find(s => s.platform === 'meta')?.missingEnv).toEqual(['OPENCREATOR_PUBLISHER_META_APP_ID', 'OPENCREATOR_PUBLISHER_META_APP_SECRET']);
  });
});
