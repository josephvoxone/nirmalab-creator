import { describe, expect, it, vi } from 'vitest';
import {
  youtubeAuthorizeUrl,
  youtubeExchangeCode,
  youtubeRefreshAccessToken,
  youtubeChannelTitle,
  youtubeUploadVideo
} from '../src/publisher/youtube.js';

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

describe('youtube publisher', () => {
  it('authorize URL carries offline consent + upload scope', () => {
    const url = new URL(youtubeAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://x/cb', state: 's' }));
    expect(url.host).toBe('accounts.google.com');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('youtube.upload');
  });

  it('exchange + refresh parse tokens', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'a2', expires_in: 100 }));
    const ex = await youtubeExchangeCode(fetchImpl as never, { clientId: 'c', clientSecret: 's', redirectUri: 'u', code: 'code' });
    expect(ex).toMatchObject({ accessToken: 'a', refreshToken: 'r' });
    const rf = await youtubeRefreshAccessToken(fetchImpl as never, { clientId: 'c', clientSecret: 's', refreshToken: 'r' });
    expect(rf.accessToken).toBe('a2');
  });

  it('channel title reads mine snippet', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ items: [{ snippet: { title: 'MyChan' } }] }));
    await expect(youtubeChannelTitle(fetchImpl as never, 'tok')).resolves.toBe('MyChan');
  });

  it('resumable upload inits session then PUTs bytes', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, 200, { location: 'https://sess/123' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'vid9' }));
    const files = { statBytes: vi.fn().mockResolvedValue(10), readAll: vi.fn().mockResolvedValue(Buffer.alloc(10)) };
    const out = await youtubeUploadVideo(
      fetchImpl as never,
      { filePath: '/tmp/a.mp4', title: 'Hi', accessToken: 'tok', privacyStatus: 'private' },
      files as never,
      5000
    );
    expect(out).toEqual({ videoId: 'vid9', url: 'https://www.youtube.com/watch?v=vid9' });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://sess/123');
    expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe('PUT');
  });

  it('rejects empty title and missing session URL', async () => {
    const files = { statBytes: vi.fn().mockResolvedValue(10), readAll: vi.fn().mockResolvedValue(Buffer.alloc(10)) };
    await expect(youtubeUploadVideo(vi.fn() as never, { filePath: '/t.mp4', title: '  ', accessToken: 't' }, files as never))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const noLoc = vi.fn().mockResolvedValueOnce(jsonResponse({}));
    await expect(youtubeUploadVideo(noLoc as never, { filePath: '/t.mp4', title: 'ok', accessToken: 't' }, files as never))
      .rejects.toMatchObject({ code: 'UPLOAD_FAILED' });
  });
});
