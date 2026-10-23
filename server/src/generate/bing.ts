import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AccountPoolStore } from './accounts.js';
import type { ClipContext, ClipProvider } from './pool.js';
import { FreeGenerateError, type FetchLike, type FreeClipRequest, type FreeClipResult } from './types.js';

/**
 * Bing Image/Video Creator over plain HTTPS (no browser — light).
 * Mirrors the bingart flow: config (IG/Salt) -> submit (302 id) -> poll.
 * Auth = `_U` cookie per pool account, pasted once, rotated every 2-4 weeks.
 */
const BASE = 'https://www.bing.com/images/create';
const ORIGIN = 'https://www.bing.com';
const AUTH_MARKER = 'id="id_a" style="display:none"';
const POLL_MS = 5_000;
const MAX_POLLS = 120;

export type BingSession = {
  cookieU: string;
  ig?: string;
  salt?: string;
  srchhpgusr?: string;
};

export type BingGenerateInput = FreeClipRequest & {
  cookieU: string;
};

function headers(session: BingSession, referer: string): Record<string, string> {
  const jar = [`_U=${session.cookieU}`];
  if (session.srchhpgusr) jar.push(`SRCHHPGUSR=${session.srchhpgusr}`);
  return {
    authority: 'www.bing.com',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'content-type': 'application/x-www-form-urlencoded',
    origin: ORIGIN,
    referer,
    'upgrade-insecure-requests': '1',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    cookie: jar.join('; ')
  };
}

function matchId(url: string): string | undefined {
  const match = /id=([^&"]+)/.exec(url);
  return match?.[1];
}

export async function bingFetchConfig(fetchImpl: FetchLike, cookieU: string): Promise<BingSession> {
  const response = await fetchImpl(BASE, { headers: headers({ cookieU }, BASE) });
  const html = await response.text();
  if (!html.includes(AUTH_MARKER)) {
    throw new FreeGenerateError('BING_AUTH', 'Bing rejected the _U cookie (expired or invalid) — paste a fresh one');
  }
  const ig = /IG:"([^"]+)"/.exec(html)?.[1];
  const salt = /Salt:"([^"]+)"/.exec(html)?.[1];
  const session: BingSession = { cookieU, ig, salt };
  session.srchhpgusr = `SRCHLANG=en&HV=${Math.floor(Date.now() / 1000)}&HVE=${salt ?? ''}&IG=${ig ?? ''}`;
  return session;
}

function submitParams(query: string, session: BingSession, video: boolean, aspect: '9:16' | '16:9'): { url: string; body: string } {
  const params = new URLSearchParams({ q: query, FORM: 'GENCRE' });
  if (session.ig) params.set('IG', session.ig);
  let body: Record<string, string>;
  if (video) {
    params.set('rt', '3');
    params.set('mdl', '0');
    params.set('ar', '1');
    params.set('ctype', 'video');
    params.set('pt', '3');
    params.set('sm', '0');
    body = { q: query, model: 'dalle', aspectRatio: '1:1' };
  } else {
    const landscape = aspect === '16:9';
    params.set('rt', '4');
    params.set('mdl', '1');
    params.set('ar', landscape ? '2' : '3');
    body = { q: query, model: 'gpt4o', aspectRatio: landscape ? '7:4' : '4:7' };
  }
  return { url: `${BASE}?${params.toString()}`, body: new URLSearchParams(body).toString() };
}

export async function bingSubmit(
  fetchImpl: FetchLike,
  session: BingSession,
  query: string,
  video: boolean,
  aspect: '9:16' | '16:9'
): Promise<string> {
  const { url, body } = submitParams(query, session, video, aspect);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: headers(session, video ? `${BASE}?ctype=video` : BASE),
    body,
    redirect: 'manual'
  });
  const location = response.headers.get('location') ?? '';
  const text = response.status === 302 || response.status === 301 ? location : await response.text();
  if (/girer_center block_icon|BlockedByContentPolicy|dq-err="/.test(text)) {
    throw new FreeGenerateError('BING_REJECTED', 'Bing rejected the prompt (content policy)');
  }
  const full = text.startsWith('/') ? `${ORIGIN}${text}` : text;
  const id = matchId(full);
  if (!id) throw new FreeGenerateError('BING_AUTH', 'Bing submit failed (no request id — cookie may be expired)');
  if (response.headers.get('location')) {
    await Promise.resolve(fetchImpl(full, { headers: headers(session, BASE) })).catch(() => undefined);
  }
  return id;
}

export async function bingPollVideo(
  fetchImpl: FetchLike,
  session: BingSession,
  query: string,
  requestId: string,
  maxPolls = MAX_POLLS,
  pollMs = POLL_MS
): Promise<string> {
  const encoded = new URLSearchParams({ q: query }).toString();
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    const url = `${BASE}/async/results/${requestId}?${encoded}&IG=${session.ig ?? ''}&ctype=video&sm=1&girftp=1`;
    const response = await fetchImpl(url, { headers: headers(session, BASE) });
    const text = await response.text();
    if (/girer_center block_icon|BlockedByContentPolicy|dq-err="/.test(text)) {
      throw new FreeGenerateError('BING_REJECTED', 'Bing rejected the prompt (content policy)');
    }
    if (text.includes('errorMessage') && text.includes('Pending')) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      continue;
    }
    if (text.includes('showContent')) {
      try {
        const data = JSON.parse(text) as { showContent?: string };
        if (data.showContent) return data.showContent;
      } catch { /* fall through to regex */ }
    }
    const ourl = /ourl="([^"]+)"/.exec(text)?.[1];
    if (ourl) return ourl;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new FreeGenerateError('GENERATE_TIMEOUT', 'Bing video still pending after 10 min');
}

export async function bingPollImage(
  fetchImpl: FetchLike,
  session: BingSession,
  query: string,
  requestId: string,
  maxPolls = MAX_POLLS,
  pollMs = POLL_MS
): Promise<string[]> {
  const encoded = new URLSearchParams({ q: query }).toString();
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    const url = `${BASE}/async/results/${requestId}?${encoded}&IG=${session.ig ?? ''}&IID=images.as`;
    const response = await fetchImpl(url, { headers: headers(session, BASE) });
    const text = await response.text();
    if (/girer_center block_icon|BlockedByContentPolicy|dq-err="/.test(text)) {
      throw new FreeGenerateError('BING_REJECTED', 'Bing rejected the prompt (content policy)');
    }
    if (!text.includes('text/css')) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      continue;
    }
    const urls = [...text.matchAll(/src="(https:\/\/th\.bing\.com\/th\/id\/OIG[^"]+)"/g)].map(m => {
      const base = m[1]!.split('?')[0]!;
      return `${base}?pid=ImgGn`;
    });
    if (urls.length > 0) return [...new Set(urls)].slice(0, 4);
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new FreeGenerateError('GENERATE_TIMEOUT', 'Bing images still pending after 10 min');
}

async function downloadBytes(fetchImpl: FetchLike, url: string): Promise<Uint8Array> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new FreeGenerateError('GENERATE_FAILED', `Bing download failed (HTTP ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function bingGenerateVideo(
  fetchImpl: FetchLike,
  input: BingGenerateInput,
  outDir: string,
  now: () => number = Date.now
): Promise<{ filePath: string; bytes: number; videoUrl: string }> {
  const session = await bingFetchConfig(fetchImpl, input.cookieU);
  const requestId = await bingSubmit(fetchImpl, session, input.prompt.trim(), true, input.aspect ?? '9:16');
  const videoUrl = await bingPollVideo(fetchImpl, session, input.prompt.trim(), requestId);
  const bytes = await downloadBytes(fetchImpl, videoUrl);
  if (bytes.byteLength < 1024) throw new FreeGenerateError('GENERATE_FAILED', 'Bing returned empty video');
  await mkdir(outDir, { recursive: true });
  const filePath = join(outDir, `bing-${now()}-${Math.floor(Math.random() * 1e6)}.mp4`);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(filePath, bytes);
  return { filePath, bytes: bytes.byteLength, videoUrl };
}

export async function bingGenerateImage(
  fetchImpl: FetchLike,
  input: BingGenerateInput,
  outDir: string,
  now: () => number = Date.now
): Promise<{ filePaths: string[]; imageUrls: string[] }> {
  const session = await bingFetchConfig(fetchImpl, input.cookieU);
  const requestId = await bingSubmit(fetchImpl, session, input.prompt.trim(), false, input.aspect ?? '9:16');
  const imageUrls = await bingPollImage(fetchImpl, session, input.prompt.trim(), requestId);
  await mkdir(outDir, { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  const filePaths: string[] = [];
  for (const [index, imageUrl] of imageUrls.entries()) {
    const bytes = await downloadBytes(fetchImpl, imageUrl);
    const filePath = join(outDir, `bing-${now()}-${index}.jpg`);
    await writeFile(filePath, bytes);
    filePaths.push(filePath);
  }
  return { filePaths, imageUrls };
}

export function createBingProvider(pools: AccountPoolStore, fetchImpl: FetchLike = fetch): ClipProvider {
  return {
    name: 'bing',
    dailyCapPerAccount: 10,
    async generate(request: FreeClipRequest, ctx: ClipContext): Promise<FreeClipResult> {
      const store = ctx.pools ?? pools;
      const account = await store.pick('bing', 10);
      if (!account) throw new FreeGenerateError('NO_ACCOUNT', 'No Bing accounts in pool — paste a _U cookie first');
      const cookieU = await store.readSecret('bing', account.id);
      if (!cookieU) throw new FreeGenerateError('NO_ACCOUNT', `Bing account ${account.id} has no cookie`);
      try {
        const out = await bingGenerateVideo(fetchImpl, {
          prompt: request.prompt,
          aspect: request.aspect,
          cookieU
        }, join(ctx.outDir, 'bing'));
        await store.markUsed('bing', account.id);
        return { ok: true, filePath: out.filePath, provider: 'bing' };
      } catch (error) {
        if (error instanceof FreeGenerateError && error.code === 'BING_AUTH') {
          await store.markCooldown('bing', account.id, 24 * 3600 * 1000);
        }
        throw error;
      }
    }
  };
}
