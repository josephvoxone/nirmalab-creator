import { readFile, stat } from 'node:fs/promises';
import { postForm, postJson, readJsonSafe } from './http.js';
import { PublisherError, type FetchLike, type FileReader } from './types.js';

export const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
export const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
export const TIKTOK_CREATOR_INFO_URL = 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/';
export const TIKTOK_VIDEO_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
export const TIKTOK_INBOX_VIDEO_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';
export const TIKTOK_STATUS_FETCH_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';

/** Default chunk size for FILE_UPLOAD PUTs (10 MB, per TikTok media-transfer guide). */
export const TIKTOK_UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024;
/** TikTok FILE_UPLOAD hard limit guard (4 GB). */
export const TIKTOK_MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;

export const TIKTOK_DEFAULT_SCOPES = ['user.info.basic', 'video.upload', 'video.publish'];

export type TikTokEnv = {
  clientKey?: string;
  clientSecret?: string;
};

export function tiktokEnv(env: NodeJS.ProcessEnv = process.env): TikTokEnv {
  return {
    clientKey: env.OPENCREATOR_PUBLISHER_TIKTOK_CLIENT_KEY?.trim() || undefined,
    clientSecret: env.OPENCREATOR_PUBLISHER_TIKTOK_CLIENT_SECRET?.trim() || undefined
  };
}

export function tiktokAuthorizeUrl(input: {
  clientKey: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
}): string {
  const params = new URLSearchParams({
    client_key: input.clientKey,
    scope: (input.scopes?.length ? input.scopes : TIKTOK_DEFAULT_SCOPES).join(','),
    response_type: 'code',
    redirect_uri: input.redirectUri,
    state: input.state
  });
  return `${TIKTOK_AUTHORIZE_URL}?${params.toString()}`;
}

type TikTokTokenPayload = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  open_id?: string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

function tokenError(payload: TikTokTokenPayload): string | undefined {
  if (typeof payload.error === 'string' && payload.error) {
    return payload.error_description ? `${payload.error}: ${payload.error_description}` : payload.error;
  }
  return undefined;
}

export type TikTokTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs?: number;
  openId?: string;
  scope?: string;
};

export async function tiktokExchangeCode(
  fetchImpl: FetchLike,
  input: { clientKey: string; clientSecret: string; redirectUri: string; code: string; codeVerifier?: string }
): Promise<TikTokTokens> {
  const params: Record<string, string> = {
    client_key: input.clientKey,
    client_secret: input.clientSecret,
    code: input.code,
    grant_type: 'authorization_code',
    redirect_uri: input.redirectUri
  };
  if (input.codeVerifier) params.code_verifier = input.codeVerifier;
  const payload = (await postForm(fetchImpl, TIKTOK_TOKEN_URL, params)) as TikTokTokenPayload;
  const failure = tokenError(payload);
  if (failure) throw new PublisherError('OAUTH_FAILED', `TikTok token exchange failed: ${failure}`.slice(0, 300));
  if (!payload.access_token) throw new PublisherError('OAUTH_FAILED', 'TikTok token exchange returned no access token');
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAtMs: typeof payload.expires_in === 'number' ? Date.now() + payload.expires_in * 1000 : undefined,
    openId: payload.open_id,
    scope: payload.scope
  };
}

export async function tiktokRefreshAccessToken(
  fetchImpl: FetchLike,
  input: { clientKey: string; clientSecret: string; refreshToken: string }
): Promise<TikTokTokens> {
  const payload = (await postForm(fetchImpl, TIKTOK_TOKEN_URL, {
    client_key: input.clientKey,
    client_secret: input.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken
  })) as TikTokTokenPayload;
  const failure = tokenError(payload);
  if (failure) throw new PublisherError('REFRESH_FAILED', `TikTok refresh failed: ${failure}`.slice(0, 300));
  if (!payload.access_token) throw new PublisherError('REFRESH_FAILED', 'TikTok refresh returned no access token');
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAtMs: typeof payload.expires_in === 'number' ? Date.now() + payload.expires_in * 1000 : undefined,
    openId: payload.open_id,
    scope: payload.scope
  };
}

type TikTokEnvelope<T> = {
  data?: T;
  error?: { code?: string; message?: string; log_id?: string };
};

function assertTikTokOk(code: string, action: string, payload: TikTokEnvelope<unknown>): void {
  const errCode = payload?.error?.code;
  if (errCode && errCode !== 'ok') {
    const message = payload.error?.message ? `: ${payload.error.message}` : '';
    const logId = payload.error?.log_id ? ` (log_id ${payload.error.log_id})` : '';
    throw new PublisherError(code, `TikTok ${action} failed [${errCode}]${message}${logId}`.slice(0, 300));
  }
}

export type TikTokCreatorInfo = {
  avatarUrl?: string;
  username?: string;
  nickname?: string;
  privacyLevelOptions?: string[];
  commentDisabled?: boolean;
  duetDisabled?: boolean;
  stitchDisabled?: boolean;
  maxVideoPostDurationSec?: number;
};

type TikTokCreatorInfoData = {
  creator_avatar_url?: string;
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
};

export async function tiktokCreatorInfo(fetchImpl: FetchLike, accessToken: string): Promise<TikTokCreatorInfo> {
  const { payload } = await postJson(fetchImpl, TIKTOK_CREATOR_INFO_URL, {}, { Authorization: `Bearer ${accessToken}` });
  const envelope = payload as TikTokEnvelope<TikTokCreatorInfoData>;
  assertTikTokOk('FETCH_FAILED', 'creator_info query', envelope);
  const data = envelope.data ?? {};
  return {
    avatarUrl: data.creator_avatar_url,
    username: data.creator_username,
    nickname: data.creator_nickname,
    privacyLevelOptions: data.privacy_level_options,
    commentDisabled: data.comment_disabled,
    duetDisabled: data.duet_disabled,
    stitchDisabled: data.stitch_disabled,
    maxVideoPostDurationSec: data.max_video_post_duration_sec
  };
}

/** Privacy levels accepted by the DIRECT_POST video init endpoint. */
export type TikTokPrivacyLevel =
  | 'PUBLIC_TO_EVERYONE'
  | 'MUTUAL_FOLLOW_FRIENDS'
  | 'FOLLOWER_OF_CREATOR'
  | 'SELF_ONLY';

const nodeFileReader: FileReader = {
  async statBytes(path: string): Promise<number> {
    return (await stat(path)).size;
  },
  async readAll(path: string): Promise<Uint8Array> {
    return readFile(path);
  }
};

function contentTypeFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.webm')) return 'video/webm';
  return 'video/mp4';
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export type TikTokUploadOptions = {
  chunkSizeBytes?: number;
  putTimeoutMs?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

async function putFileChunks(
  fetchImpl: FetchLike,
  uploadUrl: string,
  bytes: Uint8Array,
  contentType: string,
  chunkSize: number,
  putTimeoutMs: number
): Promise<void> {
  const total = bytes.byteLength;
  const totalChunks = Math.max(1, Math.ceil(total / chunkSize));
  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, total) - 1;
    const chunk = bytes.subarray(start, end + 1);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), putTimeoutMs);
    try {
      const response = await fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(chunk.byteLength),
          'Content-Range': `bytes ${start}-${end}/${total}`
        },
        body: chunk as unknown as BodyInit,
        signal: controller.signal
      });
      if (!response.ok) {
        const payload = await readJsonSafe(response);
        const detail =
          payload && typeof payload === 'object'
            ? JSON.stringify(payload).slice(0, 200)
            : `HTTP ${response.status}`;
        throw new PublisherError('UPLOAD_FAILED', `TikTok chunk ${index + 1}/${totalChunks} upload failed: ${detail}`);
      }
      // Drain body so mocked/keep-alive responses do not leak.
      try {
        await response.arrayBuffer();
      } catch {
        // Body already consumed or empty — not fatal.
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

type TikTokStatusData = {
  status?: string;
  fail_reason?: string;
  public_video_id?: string;
  uploaded_bytes?: number;
};

async function pollPublishStatus(
  fetchImpl: FetchLike,
  accessToken: string,
  publishId: string,
  successStatuses: string[],
  options: Required<Pick<TikTokUploadOptions, 'pollIntervalMs' | 'pollTimeoutMs'>>
): Promise<string> {
  const deadline = Date.now() + options.pollTimeoutMs;
  for (;;) {
    const { payload } = await postJson(
      fetchImpl,
      TIKTOK_STATUS_FETCH_URL,
      { publish_id: publishId },
      authHeaders(accessToken)
    );
    const envelope = payload as TikTokEnvelope<TikTokStatusData>;
    assertTikTokOk('UPLOAD_FAILED', 'status fetch', envelope);
    const status = envelope.data?.status ?? '';
    if (successStatuses.includes(status)) return status;
    if (status === 'FAILED') {
      const reason = envelope.data?.fail_reason ? `: ${envelope.data.fail_reason}` : '';
      throw new PublisherError('UPLOAD_FAILED', `TikTok publish ${publishId} failed${reason}`.slice(0, 300));
    }
    if (Date.now() >= deadline) {
      throw new PublisherError('UPLOAD_FAILED', `Timed out waiting for TikTok publish ${publishId} (last status: ${status || 'unknown'})`);
    }
    await sleep(options.pollIntervalMs);
  }
}

function resolveUploadPlan(size: number, chunkSizeBytes?: number): { chunkSize: number; totalChunkCount: number } {
  const chunkSize = chunkSizeBytes ?? TIKTOK_UPLOAD_CHUNK_SIZE;
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) throw new PublisherError('INVALID_INPUT', 'chunkSizeBytes must be positive');
  return { chunkSize, totalChunkCount: Math.max(1, Math.ceil(size / chunkSize)) };
}

async function loadVideoBytes(files: FileReader, filePath: string, size: number): Promise<Uint8Array> {
  if (size <= 0) throw new PublisherError('INVALID_INPUT', 'Video file is empty');
  if (size > TIKTOK_MAX_VIDEO_BYTES) throw new PublisherError('INVALID_INPUT', 'Video exceeds the 4 GB TikTok limit');
  const bytes = await files.readAll(filePath);
  if (bytes.byteLength === 0) throw new PublisherError('INVALID_INPUT', 'Video file is empty');
  return bytes;
}

export type TikTokPublishVideoInput = {
  filePath: string;
  title: string;
  accessToken: string;
  privacyLevel?: TikTokPrivacyLevel;
  disableDuet?: boolean;
  disableComment?: boolean;
  disableStitch?: boolean;
  coverTimestampMs?: number;
};

export type TikTokPublishResult = {
  publishId: string;
  status: string;
};

/**
 * DIRECT_POST: init video post with FILE_UPLOAD, PUT 10 MB chunks to the
 * returned upload_url, then poll status until PUBLISH_COMPLETE.
 */
export async function tiktokPublishVideo(
  fetchImpl: FetchLike,
  input: TikTokPublishVideoInput,
  files: FileReader = nodeFileReader,
  options: TikTokUploadOptions = {}
): Promise<TikTokPublishResult> {
  const title = input.title.trim().slice(0, 2200);
  if (!title) throw new PublisherError('INVALID_INPUT', 'Title is required');
  const size = await files.statBytes(input.filePath);
  const { chunkSize, totalChunkCount } = resolveUploadPlan(size, options.chunkSizeBytes);
  const bytes = await loadVideoBytes(files, input.filePath, size);

  const body: Record<string, unknown> = {
    post_info: {
      title,
      privacy_level: input.privacyLevel ?? 'SELF_ONLY',
      disable_duet: input.disableDuet ?? false,
      disable_comment: input.disableComment ?? false,
      disable_stitch: input.disableStitch ?? false,
      ...(input.coverTimestampMs !== undefined ? { video_cover_timestamp_ms: input.coverTimestampMs } : {})
    },
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: bytes.byteLength,
      chunk_size: chunkSize,
      total_chunk_count: totalChunkCount
    }
  };
  const { payload } = await postJson(fetchImpl, TIKTOK_VIDEO_INIT_URL, body, authHeaders(input.accessToken));
  const envelope = payload as TikTokEnvelope<{ publish_id?: string; upload_url?: string }>;
  assertTikTokOk('UPLOAD_FAILED', 'video init', envelope);
  const publishId = envelope.data?.publish_id;
  const uploadUrl = envelope.data?.upload_url;
  if (!publishId || !uploadUrl) throw new PublisherError('UPLOAD_FAILED', 'TikTok video init returned no publish_id/upload_url');

  await putFileChunks(fetchImpl, uploadUrl, bytes, contentTypeFor(input.filePath), chunkSize, options.putTimeoutMs ?? 300_000);
  const status = await pollPublishStatus(fetchImpl, input.accessToken, publishId, ['PUBLISH_COMPLETE'], {
    pollIntervalMs: options.pollIntervalMs ?? 2000,
    pollTimeoutMs: options.pollTimeoutMs ?? 600_000
  });
  return { publishId, status };
}

export type TikTokUploadOnlyVideoInput = {
  filePath: string;
  accessToken: string;
};

/**
 * Inbox (upload-only) variant: init via /inbox/video/init (no post_info),
 * PUT 10 MB chunks, then poll until SEND_TO_USER_INBOX (or PUBLISH_COMPLETE).
 */
export async function tiktokUploadOnlyVideo(
  fetchImpl: FetchLike,
  input: TikTokUploadOnlyVideoInput,
  files: FileReader = nodeFileReader,
  options: TikTokUploadOptions = {}
): Promise<TikTokPublishResult> {
  const size = await files.statBytes(input.filePath);
  const { chunkSize, totalChunkCount } = resolveUploadPlan(size, options.chunkSizeBytes);
  const bytes = await loadVideoBytes(files, input.filePath, size);

  const { payload } = await postJson(
    fetchImpl,
    TIKTOK_INBOX_VIDEO_INIT_URL,
    {
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: bytes.byteLength,
        chunk_size: chunkSize,
        total_chunk_count: totalChunkCount
      }
    },
    authHeaders(input.accessToken)
  );
  const envelope = payload as TikTokEnvelope<{ publish_id?: string; upload_url?: string }>;
  assertTikTokOk('UPLOAD_FAILED', 'inbox video init', envelope);
  const publishId = envelope.data?.publish_id;
  const uploadUrl = envelope.data?.upload_url;
  if (!publishId || !uploadUrl) throw new PublisherError('UPLOAD_FAILED', 'TikTok inbox init returned no publish_id/upload_url');

  await putFileChunks(fetchImpl, uploadUrl, bytes, contentTypeFor(input.filePath), chunkSize, options.putTimeoutMs ?? 300_000);
  const status = await pollPublishStatus(fetchImpl, input.accessToken, publishId, ['SEND_TO_USER_INBOX', 'PUBLISH_COMPLETE'], {
    pollIntervalMs: options.pollIntervalMs ?? 2000,
    pollTimeoutMs: options.pollTimeoutMs ?? 600_000
  });
  return { publishId, status };
}
