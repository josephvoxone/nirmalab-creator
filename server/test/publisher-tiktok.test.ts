import { describe, expect, it, vi } from 'vitest';
import {
  TIKTOK_DEFAULT_SCOPES,
  tiktokAuthorizeUrl,
  tiktokCreatorInfo,
  tiktokEnv,
  tiktokExchangeCode,
  tiktokPublishVideo,
  tiktokRefreshAccessToken,
  tiktokUploadOnlyVideo
} from '../src/publisher/tiktok.js';

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function okEnvelope(data: unknown): Record<string, unknown> {
  return { data, error: { code: 'ok', message: '', log_id: 'log1' } };
}

const filesFor = (bytes: Buffer) => ({
  statBytes: vi.fn().mockResolvedValue(bytes.byteLength),
  readAll: vi.fn().mockResolvedValue(bytes)
});

describe('tiktok publisher', () => {
  it('env reads client key/secret', () => {
    const env = tiktokEnv({
      OPENCREATOR_PUBLISHER_TIKTOK_CLIENT_KEY: ' key1 ',
      OPENCREATOR_PUBLISHER_TIKTOK_CLIENT_SECRET: 'sec1'
    } as NodeJS.ProcessEnv);
    expect(env).toEqual({ clientKey: 'key1', clientSecret: 'sec1' });
    expect(tiktokEnv({} as NodeJS.ProcessEnv)).toEqual({ clientKey: undefined, clientSecret: undefined });
  });

  it('authorize URL points at Login Kit with code flow + scopes', () => {
    const url = new URL(tiktokAuthorizeUrl({ clientKey: 'ck', redirectUri: 'https://x/cb', state: 's1' }));
    expect(`${url.origin}${url.pathname}`).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(url.searchParams.get('client_key')).toBe('ck');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://x/cb');
    expect(url.searchParams.get('state')).toBe('s1');
    for (const scope of TIKTOK_DEFAULT_SCOPES) {
      expect(url.searchParams.get('scope')).toContain(scope);
    }
  });

  it('exchange + refresh parse tokens with open_id', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600, open_id: 'oid', scope: 'user.info.basic' }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'a2', refresh_token: 'r2', expires_in: 100, open_id: 'oid' }));
    const ex = await tiktokExchangeCode(fetchImpl as never, { clientKey: 'k', clientSecret: 's', redirectUri: 'u', code: 'code' });
    expect(ex).toMatchObject({ accessToken: 'a', refreshToken: 'r', openId: 'oid' });
    expect(ex.expiresAtMs).toBeGreaterThan(Date.now());
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init?.method).toBe('POST');
    expect(String(init?.body)).toContain('grant_type=authorization_code');
    const rf = await tiktokRefreshAccessToken(fetchImpl as never, { clientKey: 'k', clientSecret: 's', refreshToken: 'r' });
    expect(rf).toMatchObject({ accessToken: 'a2', refreshToken: 'r2' });
    const [, rinit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(String(rinit?.body)).toContain('grant_type=refresh_token');
  });

  it('exchange surfaces TikTok oauth errors and missing tokens', async () => {
    const errFetch = vi.fn().mockResolvedValue(jsonResponse({ error: 'invalid_grant', error_description: 'bad code' }));
    await expect(tiktokExchangeCode(errFetch as never, { clientKey: 'k', clientSecret: 's', redirectUri: 'u', code: 'c' }))
      .rejects.toMatchObject({ code: 'OAUTH_FAILED' });
    const emptyFetch = vi.fn().mockResolvedValue(jsonResponse({ expires_in: 10 }));
    await expect(tiktokExchangeCode(emptyFetch as never, { clientKey: 'k', clientSecret: 's', redirectUri: 'u', code: 'c' }))
      .rejects.toMatchObject({ code: 'OAUTH_FAILED' });
    const emptyRefresh = vi.fn().mockResolvedValue(jsonResponse({}));
    await expect(tiktokRefreshAccessToken(emptyRefresh as never, { clientKey: 'k', clientSecret: 's', refreshToken: 'r' }))
      .rejects.toMatchObject({ code: 'REFRESH_FAILED' });
  });

  it('creator info maps snake_case to camelCase', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(okEnvelope({
      creator_avatar_url: 'https://x/a.png',
      creator_username: 'handle',
      creator_nickname: 'Nick',
      privacy_level_options: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'],
      comment_disabled: false,
      duet_disabled: true,
      stitch_disabled: false,
      max_video_post_duration_sec: 600
    })));
    const info = await tiktokCreatorInfo(fetchImpl as never, 'tok');
    expect(info).toMatchObject({ username: 'handle', nickname: 'Nick', duetDisabled: true, maxVideoPostDurationSec: 600 });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/creator_info/query/');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('creator info raises on non-ok error code', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: {}, error: { code: 'access_token_invalid', message: 'bad token', log_id: 'l1' } }));
    await expect(tiktokCreatorInfo(fetchImpl as never, 'tok')).rejects.toMatchObject({ code: 'FETCH_FAILED' });
  });

  it('DIRECT_POST inits FILE_UPLOAD, PUTs 10MB chunks with Content-Range, polls to PUBLISH_COMPLETE', async () => {
    const bytes = Buffer.alloc(25, 7);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(okEnvelope({ publish_id: 'pub1', upload_url: 'https://up/t1' })))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse(okEnvelope({ status: 'PROCESSING_UPLOAD' })))
      .mockResolvedValueOnce(jsonResponse(okEnvelope({ status: 'PUBLISH_COMPLETE' })));
    const out = await tiktokPublishVideo(
      fetchImpl as never,
      { filePath: '/tmp/a.mp4', title: 'Hello #fyp', accessToken: 'tok', privacyLevel: 'SELF_ONLY' },
      filesFor(bytes) as never,
      { chunkSizeBytes: 10, pollIntervalMs: 1, pollTimeoutMs: 5000, putTimeoutMs: 5000 }
    );
    expect(out).toEqual({ publishId: 'pub1', status: 'PUBLISH_COMPLETE' });
    const [initUrl, initReq] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(initUrl).toContain('/post/publish/video/init/');
    const initBody = JSON.parse(String(initReq?.body)) as { post_info: Record<string, unknown>; source_info: Record<string, unknown> };
    expect(initBody.post_info.title).toBe('Hello #fyp');
    expect(initBody.source_info).toMatchObject({ source: 'FILE_UPLOAD', video_size: 25, chunk_size: 10, total_chunk_count: 3 });
    const ranges = [1, 2, 3].map(i => (fetchImpl.mock.calls[i]?.[1] as RequestInit)?.headers as Record<string, string>);
    expect(ranges[0]).toMatchObject({ 'Content-Range': 'bytes 0-9/25', 'Content-Length': '10' });
    expect(ranges[1]).toMatchObject({ 'Content-Range': 'bytes 10-19/25' });
    expect(ranges[2]).toMatchObject({ 'Content-Range': 'bytes 20-24/25', 'Content-Length': '5' });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://up/t1');
    expect(fetchImpl.mock.calls[1]?.[1]?.method).toBe('PUT');
    const [statusUrl, statusReq] = fetchImpl.mock.calls[4] as [string, RequestInit];
    expect(statusUrl).toContain('/status/fetch/');
    expect(JSON.parse(String(statusReq?.body))).toMatchObject({ publish_id: 'pub1' });
  });

  it('rejects empty title and empty file', async () => {
    const files = filesFor(Buffer.alloc(10));
    await expect(tiktokPublishVideo(vi.fn() as never, { filePath: '/t.mp4', title: '   ', accessToken: 't' }, files as never))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const emptyFiles = filesFor(Buffer.alloc(0));
    await expect(tiktokPublishVideo(vi.fn() as never, { filePath: '/t.mp4', title: 'ok', accessToken: 't' }, emptyFiles as never, { chunkSizeBytes: 10 }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('init API error and FAILED status surface UPLOAD_FAILED', async () => {
    const initErr = vi.fn().mockResolvedValue(jsonResponse({ data: {}, error: { code: 'quota_exceeded', message: 'nope', log_id: 'l' } }));
    await expect(tiktokPublishVideo(
      initErr as never,
      { filePath: '/t.mp4', title: 'ok', accessToken: 't' },
      filesFor(Buffer.alloc(5)) as never,
      { chunkSizeBytes: 10, pollIntervalMs: 1 }
    )).rejects.toMatchObject({ code: 'UPLOAD_FAILED' });

    const failed = vi.fn()
      .mockResolvedValueOnce(jsonResponse(okEnvelope({ publish_id: 'p9', upload_url: 'https://up/x' })))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse(okEnvelope({ status: 'FAILED', fail_reason: 'transcode error' })));
    await expect(tiktokPublishVideo(
      failed as never,
      { filePath: '/t.mp4', title: 'ok', accessToken: 't' },
      filesFor(Buffer.alloc(5)) as never,
      { chunkSizeBytes: 10, pollIntervalMs: 1 }
    )).rejects.toMatchObject({ code: 'UPLOAD_FAILED' });
  });

  it('inbox variant uses /inbox/ init and SEND_TO_USER_INBOX success', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(okEnvelope({ publish_id: 'inbox1', upload_url: 'https://up/in1' })))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse(okEnvelope({ status: 'SEND_TO_USER_INBOX' })));
    const out = await tiktokUploadOnlyVideo(
      fetchImpl as never,
      { filePath: '/tmp/b.mp4', accessToken: 'tok' },
      filesFor(Buffer.alloc(8)) as never,
      { chunkSizeBytes: 10, pollIntervalMs: 1, pollTimeoutMs: 5000, putTimeoutMs: 5000 }
    );
    expect(out).toEqual({ publishId: 'inbox1', status: 'SEND_TO_USER_INBOX' });
    const [initUrl, initReq] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(initUrl).toContain('/post/publish/inbox/video/init/');
    const initBody = JSON.parse(String(initReq?.body)) as Record<string, unknown>;
    expect(initBody).not.toHaveProperty('post_info');
    expect(initBody.source_info).toMatchObject({ source: 'FILE_UPLOAD', video_size: 8, total_chunk_count: 1 });
  });

  it('chunk PUT failure aborts with UPLOAD_FAILED', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(okEnvelope({ publish_id: 'p5', upload_url: 'https://up/x' })))
      .mockResolvedValueOnce(jsonResponse({ error: 'x' }, 500));
    await expect(tiktokUploadOnlyVideo(
      fetchImpl as never,
      { filePath: '/tmp/b.mp4', accessToken: 'tok' },
      filesFor(Buffer.alloc(8)) as never,
      { chunkSizeBytes: 10, pollIntervalMs: 1 }
    )).rejects.toMatchObject({ code: 'UPLOAD_FAILED' });
  });
});
