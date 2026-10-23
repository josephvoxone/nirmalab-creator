import { stat, readFile } from 'node:fs/promises';
import { getJson, postForm, postJson, readJsonSafe } from './http.js';
import { PublisherError, type FetchLike, type FileReader } from './types.js';

export const YOUTUBE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';

export type YouTubeEnv = {
  clientId?: string;
  clientSecret?: string;
};

export function youtubeEnv(env: NodeJS.ProcessEnv = process.env): YouTubeEnv {
  return {
    clientId: env.OPENCREATOR_PUBLISHER_YOUTUBE_CLIENT_ID?.trim() || undefined,
    clientSecret: env.OPENCREATOR_PUBLISHER_YOUTUBE_CLIENT_SECRET?.trim() || undefined
  };
}

export function youtubeAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: `openid ${YOUTUBE_UPLOAD_SCOPE}`,
    access_type: 'offline',
    prompt: 'consent',
    state: input.state
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

type GoogleTokenPayload = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

export async function youtubeExchangeCode(
  fetchImpl: FetchLike,
  input: { clientId: string; clientSecret: string; redirectUri: string; code: string }
): Promise<{ accessToken: string; refreshToken?: string; expiresAtMs?: number }> {
  const payload = (await postForm(fetchImpl, 'https://oauth2.googleapis.com/token', {
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
    code: input.code
  })) as GoogleTokenPayload;
  if (!payload.access_token) throw new PublisherError('OAUTH_FAILED', 'Google token exchange returned no access token');
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAtMs: typeof payload.expires_in === 'number' ? Date.now() + payload.expires_in * 1000 : undefined
  };
}

export async function youtubeRefreshAccessToken(
  fetchImpl: FetchLike,
  input: { clientId: string; clientSecret: string; refreshToken: string }
): Promise<{ accessToken: string; expiresAtMs?: number }> {
  const payload = (await postForm(fetchImpl, 'https://oauth2.googleapis.com/token', {
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken
  })) as GoogleTokenPayload;
  if (!payload.access_token) throw new PublisherError('REFRESH_FAILED', 'Google refresh returned no access token');
  return {
    accessToken: payload.access_token,
    expiresAtMs: typeof payload.expires_in === 'number' ? Date.now() + payload.expires_in * 1000 : undefined
  };
}

export async function youtubeChannelTitle(fetchImpl: FetchLike, accessToken: string): Promise<string | undefined> {
  const payload = (await getJson(
    fetchImpl,
    'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
    { Authorization: `Bearer ${accessToken}` }
  )) as { items?: Array<{ snippet?: { title?: string } }> };
  return payload.items?.[0]?.snippet?.title;
}

const nodeFileReader: FileReader = {
  async statBytes(path: string): Promise<number> {
    return (await stat(path)).size;
  },
  async readAll(path: string): Promise<Buffer> {
    return readFile(path);
  }
};

export type YouTubeUploadInput = {
  filePath: string;
  title: string;
  description?: string;
  privacyStatus?: 'public' | 'unlisted' | 'private';
  accessToken: string;
};

function contentTypeFor(path: string): string {
  return path.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
}

export async function youtubeUploadVideo(
  fetchImpl: FetchLike,
  input: YouTubeUploadInput,
  files: FileReader = nodeFileReader,
  timeoutMs = 600_000
): Promise<{ videoId: string; url: string }> {
  const title = input.title.trim().slice(0, 100);
  if (!title) throw new PublisherError('INVALID_INPUT', 'Title is required');
  const privacyStatus = input.privacyStatus ?? 'unlisted';
  const size = await files.statBytes(input.filePath);
  if (size <= 0) throw new PublisherError('INVALID_INPUT', 'Video file is empty');
  if (size > 256 * 1024 * 1024 * 1024) throw new PublisherError('INVALID_INPUT', 'Video exceeds the 256 GB YouTube limit');

  const { response } = await postJson(
    fetchImpl,
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      snippet: { title, description: (input.description ?? '').slice(0, 5000) },
      status: { privacyStatus }
    },
    {
      Authorization: `Bearer ${input.accessToken}`,
      'X-Upload-Content-Type': contentTypeFor(input.filePath),
      'X-Upload-Content-Length': String(size)
    },
    30_000
  );
  const sessionUri = response.headers.get('location');
  if (!sessionUri) throw new PublisherError('UPLOAD_FAILED', 'YouTube did not return a resumable session URL');

  const bytes = await files.readAll(input.filePath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const put = await fetchImpl(sessionUri, {
      method: 'PUT',
      headers: {
        'Content-Length': String(bytes.byteLength),
        'Content-Type': contentTypeFor(input.filePath)
      },
      body: bytes as unknown as BodyInit,
      signal: controller.signal
    });
    const payload = (await readJsonSafe(put)) as { id?: string; error?: { message?: string } };
    if (!put.ok) {
      const message = payload?.error?.message ?? `HTTP ${put.status}`;
      throw new PublisherError('UPLOAD_FAILED', `YouTube upload failed: ${message.slice(0, 300)}`);
    }
    if (!payload?.id) throw new PublisherError('UPLOAD_FAILED', 'YouTube upload returned no video id');
    return { videoId: payload.id, url: `https://www.youtube.com/watch?v=${payload.id}` };
  } finally {
    clearTimeout(timer);
  }
}
