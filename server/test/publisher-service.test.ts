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

function service(fetchImpl: never) {
  return new PublisherService({ dataDir: mkdtempSync(join(tmpdir(), 'pub-')), env, fetchImpl });
}

describe('publisher service', () => {
  it('reports unconfigured platforms and unconnected youtube', async () => {
    const svc = service(vi.fn() as never);
    const all = await svc.statuses();
    expect(all.find(s => s.platform === 'youtube')).toMatchObject({ configured: true, connected: false });
    expect(all.find(s => s.platform === 'tiktok')).toMatchObject({ configured: false, connected: false });
    expect(all.find(s => s.platform === 'meta')).toMatchObject({ configured: false, connected: false });
  });

  it('connect URL embeds redirect + state; callback rejects bad state', async () => {
    const svc = service(vi.fn() as never);
    const { url, state } = svc.connectUrl('youtube');
    expect(url).toContain('https%3A%2F%2Fcreator.example.com%2Fapi%2Fpublish%2Fyoutube%2Fcallback');
    expect(url).toContain(`state=${state}`);
    await expect(svc.handleCallback('youtube', { code: 'c', state: 'nope' }))
      .rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('youtube callback exchanges, labels, and publishes', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ snippet: { title: 'Chan' } }] }))
      .mockResolvedValueOnce(jsonResponse({}, 200, { location: 'https://sess/1' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'vid1' }));
    const svc = service(fetchImpl as never);
    const { state } = svc.connectUrl('youtube');
    const done = await svc.handleCallback('youtube', { code: 'code1', state });
    expect(done).toEqual({ accountLabel: 'Chan' });
    expect(await svc.getStatus('youtube')).toMatchObject({ connected: true, accountLabel: 'Chan' });
    // Publish via service uses node fs; write a tiny temp file instead.
    const { writeFileSync } = await import('node:fs');
    const tmp = join(mkdtempSync(join(tmpdir(), 'pubvid-')), 'v.mp4');
    writeFileSync(tmp, Buffer.alloc(8));
    const out = await svc.publish('youtube', { filePath: tmp, title: 'T', visibility: 'private' });
    expect(out).toMatchObject({ ok: true, externalId: 'vid1', url: 'https://www.youtube.com/watch?v=vid1' });
  });

  it('publish without connection fails cleanly; unknown platform 404-shape', async () => {
    const svc = service(vi.fn() as never);
    await expect(svc.publish('youtube', { filePath: '/x.mp4', title: 'T' }))
      .rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await expect(svc.publish('tiktok', { filePath: '/x.mp4', title: 'T' }))
      .rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });
});
