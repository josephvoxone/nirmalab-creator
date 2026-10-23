import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  metaAuthorizeUrl,
  metaEnv,
  metaExchangeCode,
  metaInstagramAccountId,
  metaLongLivedToken,
  metaMediaStatus,
  metaPageList,
  metaPublishFacebookReel,
  metaPublishInstagramReel
} from '../src/publisher/meta.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeFiles() {
  return {
    statBytes: vi.fn().mockResolvedValue(16),
    readAll: vi.fn().mockResolvedValue(Buffer.alloc(16))
  };
}

afterEach(() => {
  delete process.env.OPENCREATOR_PUBLISHER_META_APP_ID;
  delete process.env.OPENCREATOR_PUBLISHER_META_APP_SECRET;
});

describe('meta publisher', () => {
  it('metaEnv reads app id/secret and trims', () => {
    process.env.OPENCREATOR_PUBLISHER_META_APP_ID = '  app123 ';
    process.env.OPENCREATOR_PUBLISHER_META_APP_SECRET = 'sec ';
    expect(metaEnv()).toEqual({ appId: 'app123', appSecret: 'sec' });
    delete process.env.OPENCREATOR_PUBLISHER_META_APP_ID;
    expect(metaEnv().appId).toBeUndefined();
  });

  it('authorize URL targets facebook oauth with reels scopes', () => {
    const url = new URL(metaAuthorizeUrl({ appId: 'app1', redirectUri: 'https://x/cb', state: 's9' }));
    expect(url.host).toBe('www.facebook.com');
    expect(url.pathname).toContain('/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe('app1');
    expect(url.searchParams.get('state')).toBe('s9');
    expect(url.searchParams.get('scope')).toContain('pages_manage_posts');
    expect(url.searchParams.get('scope')).toContain('instagram_content_publish');
  });

  it('exchange code returns short-lived token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'short', expires_in: 3600 }));
    const out = await metaExchangeCode(fetchImpl as never, {
      appId: 'a',
      appSecret: 's',
      redirectUri: 'https://x/cb',
      code: 'code1'
    });
    expect(out.accessToken).toBe('short');
    expect(out.expiresAtMs).toBeGreaterThan(Date.now());
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('/v21.0/oauth/access_token');
  });

  it('long-lived exchange uses fb_exchange_token grant', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'long', expires_in: 5184000 }));
    const out = await metaLongLivedToken(fetchImpl as never, { appId: 'a', appSecret: 's', shortLivedToken: 'short' });
    expect(out.accessToken).toBe('long');
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('fb_exchange_token');
  });

  it('page list maps id/name/page tokens', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [{ id: 'p1', name: 'Page Satu', access_token: 'ptok' }] }));
    const pages = await metaPageList(fetchImpl as never, 'user-tok');
    expect(pages).toEqual([{ id: 'p1', name: 'Page Satu', accessToken: 'ptok' }]);
  });

  it('instagram account id reads linked business account', async () => {
    const withIg = vi.fn().mockResolvedValue(jsonResponse({ instagram_business_account: { id: 'ig9' } }));
    await expect(metaInstagramAccountId(withIg as never, { pageId: 'p1', pageAccessToken: 'pt' })).resolves.toBe('ig9');
    const withoutIg = vi.fn().mockResolvedValue(jsonResponse({ id: 'p1' }));
    await expect(
      metaInstagramAccountId(withoutIg as never, { pageId: 'p1', pageAccessToken: 'pt' })
    ).resolves.toBeUndefined();
  });

  it('facebook reel runs start → rupload bytes → finish', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ video_id: 'vid1', upload_url: 'https://rupload.facebook.com/up/vid1' }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse({ post_id: 'post7' }));
    const out = await metaPublishFacebookReel(
      fetchImpl as never,
      { pageId: 'p1', pageAccessToken: 'ptok', filePath: '/tmp/r.mp4', description: 'Halo' },
      makeFiles() as never,
      5000
    );
    expect(out).toEqual({ videoId: 'vid1', postId: 'post7' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const uploadCall = fetchImpl.mock.calls[1];
    expect(uploadCall?.[0]).toBe('https://rupload.facebook.com/up/vid1');
    expect((uploadCall?.[1]?.headers as Record<string, string>)?.Authorization).toBe('OAuth ptok');
    const finishBody = String(uploadCall && fetchImpl.mock.calls[2]?.[1]?.body);
    expect(finishBody).toContain('upload_phase=finish');
    expect(finishBody).toContain('video_state=PUBLISHED');
  });

  it('facebook reel throws when start returns no video_id', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({}));
    await expect(
      metaPublishFacebookReel(
        fetchImpl as never,
        { pageId: 'p1', pageAccessToken: 'ptok', filePath: '/tmp/r.mp4', description: 'x' },
        makeFiles() as never
      )
    ).rejects.toMatchObject({ code: 'UPLOAD_FAILED' });
  });

  it('instagram reel runs container → upload → FINISHED → publish', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'cont1', uri: 'https://rupload.facebook.com/ig-api-upload/v21.0/cont1' }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse({ id: 'cont1', status_code: 'FINISHED' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'media5' }));
    const out = await metaPublishInstagramReel(
      fetchImpl as never,
      { igUserId: 'ig9', accessToken: 'atok', filePath: '/tmp/r.mp4', caption: 'Cap' },
      makeFiles() as never,
      { statusPollMs: 0 }
    );
    expect(out).toEqual({ containerId: 'cont1', mediaId: 'media5' });
    const uploadCall = fetchImpl.mock.calls[1];
    expect((uploadCall?.[1]?.headers as Record<string, string>)?.Authorization).toBe('OAuth atok');
    const publishBody = String(fetchImpl.mock.calls[3]?.[1]?.body);
    expect(publishBody).toContain('creation_id=cont1');
  });

  it('instagram reel aborts when processing errors', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'cont2', uri: 'https://rupload.facebook.com/x/cont2' }))
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(jsonResponse({ id: 'cont2', status_code: 'ERROR' }));
    await expect(
      metaPublishInstagramReel(
        fetchImpl as never,
        { igUserId: 'ig9', accessToken: 'atok', filePath: '/tmp/r.mp4' },
        makeFiles() as never,
        { statusPollMs: 0 }
      )
    ).rejects.toMatchObject({ code: 'UPLOAD_FAILED' });
  });

  it('media status returns status_code payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 'cont1', status_code: 'IN_PROGRESS' }));
    const status = await metaMediaStatus(fetchImpl as never, { objectId: 'cont1', accessToken: 'atok' });
    expect(status).toMatchObject({ id: 'cont1', statusCode: 'IN_PROGRESS' });
  });

  it('rejects empty video files', async () => {
    const empty = { statBytes: vi.fn().mockResolvedValue(0), readAll: vi.fn() };
    await expect(
      metaPublishFacebookReel(
        vi.fn() as never,
        { pageId: 'p', pageAccessToken: 't', filePath: '/tmp/e.mp4', description: 'x' },
        empty as never
      )
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      metaPublishInstagramReel(vi.fn() as never, { igUserId: 'i', accessToken: 't', filePath: '/tmp/e.mp4' }, empty as never)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
