import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  bingFetchConfig,
  bingGenerateVideo,
  bingPollImage,
  bingPollVideo,
  bingSubmit
} from '../src/generate/bing.js';

const CONFIG_HTML = `<html><body><div id="id_a" style="display:none"></div><script>IG:"ABC123XYZ";Salt:"salt9";</script></body></html>`;

function textResponse(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/html', ...headers } });
}

describe('bing worker', () => {
  it('config checks auth marker + extracts IG/Salt', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(textResponse(CONFIG_HTML));
    const session = await bingFetchConfig(fetchImpl as never, 'U123');
    expect(session).toMatchObject({ cookieU: 'U123', ig: 'ABC123XYZ', salt: 'salt9' });
    await expect(bingFetchConfig(vi.fn().mockResolvedValueOnce(textResponse('<html>login</html>')) as never, 'bad'))
      .rejects.toMatchObject({ code: 'BING_AUTH' });
  });

  it('submit reads request id from redirect', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(textResponse('', 302, { location: '/images/create/async/results/1-abc?id=REQID99&foo=1' }));
    const id = await bingSubmit(fetchImpl as never, { cookieU: 'U', ig: 'IG1' }, 'a cat', true, '9:16');
    expect(id).toBe('REQID99');
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('POST');
  });

  it('video poll resolves ourl; image poll resolves OIG urls', async () => {
    const vfetch = vi.fn()
      .mockResolvedValueOnce(textResponse('{"errorMessage":"Pending"}'))
      .mockResolvedValueOnce(textResponse('<div ourl="https://vid/h.mp4"></div>'));
    await expect(bingPollVideo(vfetch as never, { cookieU: 'U', ig: 'I' }, 'cat', 'R1', 3, 10))
      .resolves.toBe('https://vid/h.mp4');
    const ifetch = vi.fn()
      .mockResolvedValueOnce(textResponse('<div>waiting</div>'))
      .mockResolvedValueOnce(textResponse('<style>text/css</style><img src="https://th.bing.com/th/id/OIG.a?x=1"><img src="https://th.bing.com/th/id/OIG.b?x=2">'));
    const urls = await bingPollImage(ifetch as never, { cookieU: 'U', ig: 'I' }, 'cat', 'R2', 3, 10);
    expect(urls).toEqual(['https://th.bing.com/th/id/OIG.a?pid=ImgGn', 'https://th.bing.com/th/id/OIG.b?pid=ImgGn']);
  });

  it('end-to-end video with mocked fetch saves mp4', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(textResponse(CONFIG_HTML))
      .mockResolvedValueOnce(textResponse('', 302, { location: '/x?id=VID1' }))
      .mockResolvedValueOnce(textResponse('<div>waiting</div>'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ showContent: 'https://vid/f.mp4' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array(4096).fill(1), { status: 200 }));
    const outDir = mkdtempSync(join(tmpdir(), 'bing-'));
    const out = await bingGenerateVideo(
      fetchImpl as never,
      { prompt: 'cat piano', aspect: '9:16', cookieU: 'U' },
      outDir,
      () => 5
    );
    expect(out.bytes).toBe(4096);
    expect(readFileSync(out.filePath).byteLength).toBe(4096);
  }, 30_000);
});
