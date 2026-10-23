import { stat, readFile } from 'node:fs/promises';
import { getJson, postForm, postJson, readJsonSafe } from './http.js';
import { PublisherError, type FetchLike, type FileReader } from './types.js';

/** Graph API version pinned for all Meta calls. */
export const META_GRAPH_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

export const META_DEFAULT_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'business_management',
  'instagram_basic',
  'instagram_content_publish'
].join(',');

export type MetaEnv = {
  appId?: string;
  appSecret?: string;
};

export function metaEnv(env: NodeJS.ProcessEnv = process.env): MetaEnv {
  return {
    appId: env.OPENCREATOR_PUBLISHER_META_APP_ID?.trim() || undefined,
    appSecret: env.OPENCREATOR_PUBLISHER_META_APP_SECRET?.trim() || undefined
  };
}

export function metaAuthorizeUrl(input: {
  appId: string;
  redirectUri: string;
  state: string;
  scopes?: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.appId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: input.scopes ?? META_DEFAULT_SCOPES,
    state: input.state
  });
  return `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

type MetaTokenPayload = {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
};

function toTokenResult(payload: MetaTokenPayload, missingCode: string, missingMessage: string) {
  if (!payload.access_token) throw new PublisherError(missingCode, missingMessage);
  return {
    accessToken: payload.access_token,
    expiresAtMs: typeof payload.expires_in === 'number' ? Date.now() + payload.expires_in * 1000 : undefined
  };
}

/** Exchange an OAuth `code` for a short-lived user access token (GET, per Meta docs). */
export async function metaExchangeCode(
  fetchImpl: FetchLike,
  input: { appId: string; appSecret: string; redirectUri: string; code: string }
): Promise<{ accessToken: string; expiresAtMs?: number }> {
  const params = new URLSearchParams({
    client_id: input.appId,
    client_secret: input.appSecret,
    redirect_uri: input.redirectUri,
    code: input.code
  });
  const payload = (await getJson(fetchImpl, `${GRAPH}/oauth/access_token?${params.toString()}`)) as MetaTokenPayload;
  return toTokenResult(payload, 'OAUTH_FAILED', 'Meta token exchange returned no access token');
}

/** Swap a short-lived token for a long-lived (~60 day) user token. */
export async function metaLongLivedToken(
  fetchImpl: FetchLike,
  input: { appId: string; appSecret: string; shortLivedToken: string }
): Promise<{ accessToken: string; expiresAtMs?: number }> {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: input.appId,
    client_secret: input.appSecret,
    fb_exchange_token: input.shortLivedToken
  });
  const payload = (await getJson(fetchImpl, `${GRAPH}/oauth/access_token?${params.toString()}`)) as MetaTokenPayload;
  return toTokenResult(payload, 'REFRESH_FAILED', 'Meta long-lived token exchange returned no access token');
}

export type MetaPage = { id: string; name?: string; accessToken: string };

/** List Pages the user can publish to (id + name + page access token). */
export async function metaPageList(fetchImpl: FetchLike, userAccessToken: string): Promise<MetaPage[]> {
  const params = new URLSearchParams({ fields: 'id,name,access_token', access_token: userAccessToken });
  const payload = (await getJson(fetchImpl, `${GRAPH}/me/accounts?${params.toString()}`)) as {
    data?: Array<{ id?: string; name?: string; access_token?: string }>;
  };
  const pages = payload.data ?? [];
  return pages
    .filter((p) => typeof p.id === 'string' && typeof p.access_token === 'string')
    .map((p) => ({ id: p.id as string, name: p.name, accessToken: p.access_token as string }));
}

/** Resolve the Instagram business account linked to a Page (undefined when none). */
export async function metaInstagramAccountId(
  fetchImpl: FetchLike,
  input: { pageId: string; pageAccessToken: string }
): Promise<string | undefined> {
  const params = new URLSearchParams({ fields: 'instagram_business_account', access_token: input.pageAccessToken });
  const payload = (await getJson(fetchImpl, `${GRAPH}/${input.pageId}?${params.toString()}`)) as {
    instagram_business_account?: { id?: string };
  };
  return payload.instagram_business_account?.id;
}

const nodeFileReader: FileReader = {
  async statBytes(path: string): Promise<number> {
    return (await stat(path)).size;
  },
  async readAll(path: string): Promise<Buffer> {
    return readFile(path);
  }
};

function contentTypeFor(path: string): string {
  return path.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
}

async function assertReadableVideo(files: FileReader, filePath: string, maxBytes: number, label: string) {
  const size = await files.statBytes(filePath);
  if (size <= 0) throw new PublisherError('INVALID_INPUT', `${label} file is empty`);
  if (size > maxBytes) throw new PublisherError('INVALID_INPUT', `${label} exceeds the upload size limit`);
  return size;
}

/** POST raw bytes to an rupload.facebook.com session URL (phase 2 of both flows). */
async function uploadBytesToRupload(
  fetchImpl: FetchLike,
  input: { uploadUrl: string; accessToken: string; bytes: Uint8Array; contentType: string; timeoutMs: number }
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetchImpl(input.uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${input.accessToken}`,
        offset: '0',
        file_size: String(input.bytes.byteLength),
        'Content-Type': input.contentType
      },
      body: input.bytes as unknown as BodyInit,
      signal: controller.signal
    });
    const payload = await readJsonSafe(response);
    if (!response.ok) {
      const snippet =
        payload && typeof payload === 'object'
          ? JSON.stringify(payload).slice(0, 300)
          : `HTTP ${response.status}`;
      throw new PublisherError('UPLOAD_FAILED', `Meta upload failed: ${snippet}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export type FacebookReelInput = {
  pageId: string;
  pageAccessToken: string;
  filePath: string;
  description: string;
};

/**
 * Facebook Page Reel, 3-phase:
 * 1. START — POST /{page-id}/video_reels (upload_phase=start) → video_id + upload_url
 * 2. TRANSFER — POST bytes to rupload.facebook.com (Authorization: OAuth, NOT Bearer)
 * 3. FINISH — POST /{page-id}/video_reels (upload_phase=finish, video_state=PUBLISHED)
 */
export async function metaPublishFacebookReel(
  fetchImpl: FetchLike,
  input: FacebookReelInput,
  files: FileReader = nodeFileReader,
  timeoutMs = 600_000
): Promise<{ videoId: string; postId?: string }> {
  if (!input.pageId.trim() || !input.pageAccessToken.trim()) {
    throw new PublisherError('INVALID_INPUT', 'pageId and pageAccessToken are required');
  }
  await assertReadableVideo(files, input.filePath, 10 * 1024 * 1024 * 1024, 'Facebook Reel');

  const started = (await postForm(fetchImpl, `${GRAPH}/${input.pageId}/video_reels`, {
    upload_phase: 'start',
    access_token: input.pageAccessToken
  })) as { video_id?: string | number; upload_url?: string };
  const videoId = started.video_id != null ? String(started.video_id) : undefined;
  if (!videoId) throw new PublisherError('UPLOAD_FAILED', 'Meta did not return a video_id for the Reel upload');
  const uploadUrl = started.upload_url || `https://rupload.facebook.com/video-upload/${META_GRAPH_VERSION}/${videoId}`;

  const bytes = await files.readAll(input.filePath);
  await uploadBytesToRupload(fetchImpl, {
    uploadUrl,
    accessToken: input.pageAccessToken,
    bytes,
    contentType: contentTypeFor(input.filePath),
    timeoutMs
  });

  const finished = (await postForm(fetchImpl, `${GRAPH}/${input.pageId}/video_reels`, {
    upload_phase: 'finish',
    video_id: videoId,
    video_state: 'PUBLISHED',
    description: input.description.slice(0, 5000),
    access_token: input.pageAccessToken
  })) as { id?: string; post_id?: string };
  return { videoId, postId: finished.post_id ?? finished.id };
}

export type InstagramReelInput = {
  igUserId: string;
  accessToken: string;
  filePath: string;
  caption?: string;
};

export type InstagramMediaStatus = {
  id: string;
  statusCode?: string;
  status?: string;
  videoStatus?: unknown;
};

/** Read container/media processing status (poll until status_code is FINISHED before publishing). */
export async function metaMediaStatus(
  fetchImpl: FetchLike,
  input: { objectId: string; accessToken: string }
): Promise<InstagramMediaStatus> {
  const params = new URLSearchParams({ fields: 'id,status_code,status,video_status', access_token: input.accessToken });
  const payload = (await getJson(fetchImpl, `${GRAPH}/${input.objectId}?${params.toString()}`)) as {
    id?: string;
    status_code?: string;
    status?: string;
    video_status?: unknown;
  };
  if (!payload.id) throw new PublisherError('UPLOAD_FAILED', 'Meta media status returned no id');
  return { id: payload.id, statusCode: payload.status_code, status: payload.status, videoStatus: payload.video_status };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Instagram Reel via resumable upload:
 * 1. CREATE — POST /{ig-id}/media (media_type=REELS, upload_type=resumable) → container id + uri
 * 2. TRANSFER — POST bytes to the returned rupload URI
 * 3. WAIT — poll metaMediaStatus until status_code=FINISHED (or ERROR/EXPIRED → throw)
 * 4. PUBLISH — POST /{ig-id}/media_publish (creation_id=container id) → media id
 */
export async function metaPublishInstagramReel(
  fetchImpl: FetchLike,
  input: InstagramReelInput,
  files: FileReader = nodeFileReader,
  options: { timeoutMs?: number; maxStatusAttempts?: number; statusPollMs?: number } = {}
): Promise<{ containerId: string; mediaId: string }> {
  const { timeoutMs = 600_000, maxStatusAttempts = 30, statusPollMs = 2000 } = options;
  if (!input.igUserId.trim() || !input.accessToken.trim()) {
    throw new PublisherError('INVALID_INPUT', 'igUserId and accessToken are required');
  }
  await assertReadableVideo(files, input.filePath, 4 * 1024 * 1024 * 1024, 'Instagram Reel');

  const { payload: created } = await postJson(
    fetchImpl,
    `${GRAPH}/${input.igUserId}/media`,
    {
      media_type: 'REELS',
      upload_type: 'resumable',
      ...(input.caption ? { caption: input.caption.slice(0, 2200) } : {})
    },
    { Authorization: `Bearer ${input.accessToken}` }
  );
  const container = created as { id?: string; uri?: string };
  if (!container.id || !container.uri) {
    throw new PublisherError('UPLOAD_FAILED', 'Meta did not return an IG upload container (id/uri)');
  }

  const bytes = await files.readAll(input.filePath);
  await uploadBytesToRupload(fetchImpl, {
    uploadUrl: container.uri,
    accessToken: input.accessToken,
    bytes,
    contentType: contentTypeFor(input.filePath),
    timeoutMs
  });

  let lastCode: string | undefined;
  for (let attempt = 0; attempt < maxStatusAttempts; attempt += 1) {
    const status = await metaMediaStatus(fetchImpl, { objectId: container.id, accessToken: input.accessToken });
    lastCode = status.statusCode;
    if (lastCode === 'FINISHED') break;
    if (lastCode === 'ERROR' || lastCode === 'EXPIRED') {
      throw new PublisherError('UPLOAD_FAILED', `Meta media processing failed with status ${lastCode}`);
    }
    if (attempt < maxStatusAttempts - 1) await sleep(statusPollMs);
  }
  if (lastCode !== 'FINISHED') {
    throw new PublisherError('UPLOAD_FAILED', `Meta media never reached FINISHED (last status: ${lastCode ?? 'unknown'})`);
  }

  const published = (await postForm(fetchImpl, `${GRAPH}/${input.igUserId}/media_publish`, {
    creation_id: container.id,
    access_token: input.accessToken
  })) as { id?: string };
  if (!published.id) throw new PublisherError('UPLOAD_FAILED', 'Meta media_publish returned no media id');
  return { containerId: container.id, mediaId: published.id };
}
