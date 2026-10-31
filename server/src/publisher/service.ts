import { join } from 'node:path';
import { publisherCallbackUrl, type PublisherCallbackKey } from '../lib/public-url.js';
import { OAuthStateStore } from './oauth-state.js';
import { PublisherTokenStore } from './token-store.js';
import {
  PublisherError,
  type FetchLike,
  type PublishInput,
  type PublisherPlatform,
  type PublisherStatus,
  type PublishResult
} from './types.js';
import {
  youtubeAuthorizeUrl,
  youtubeChannelTitle,
  youtubeEnv,
  youtubeExchangeCode,
  youtubeRefreshAccessToken,
  youtubeUploadVideo
} from './youtube.js';
import {
  metaAuthorizeUrl,
  metaEnv,
  metaExchangeCode,
  metaInstagramAccountId,
  metaLongLivedToken,
  metaPageList,
  metaPublishFacebookReel,
  metaPublishInstagramReel
} from './meta.js';
import {
  tiktokAuthorizeUrl,
  tiktokCreatorInfo,
  tiktokEnv,
  tiktokExchangeCode,
  tiktokPublishVideo,
  tiktokRefreshAccessToken
} from './tiktok.js';

export type PublisherServiceOptions = {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
};

export class PublisherService {
  private readonly tokens: PublisherTokenStore;
  private readonly states = new OAuthStateStore();
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: FetchLike;

  constructor(options: PublisherServiceOptions) {
    this.tokens = new PublisherTokenStore(join(options.dataDir, 'publisher'));
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private redirectUri(platform: PublisherCallbackKey): string {
    return publisherCallbackUrl(platform, this.env);
  }

  /** The env var names this server reads for the platform's OAuth app, and which are empty. */
  missingEnv(platform: PublisherPlatform): string[] {
    const names: Record<PublisherPlatform, string[]> = {
      youtube: ['OPENCREATOR_PUBLISHER_YOUTUBE_CLIENT_ID', 'OPENCREATOR_PUBLISHER_YOUTUBE_CLIENT_SECRET'],
      tiktok: ['OPENCREATOR_PUBLISHER_TIKTOK_CLIENT_KEY', 'OPENCREATOR_PUBLISHER_TIKTOK_CLIENT_SECRET'],
      meta: ['OPENCREATOR_PUBLISHER_META_APP_ID', 'OPENCREATOR_PUBLISHER_META_APP_SECRET']
    };
    return names[platform].filter(name => !this.env[name]?.trim());
  }

  isConfigured(platform: PublisherPlatform): boolean {
    if (platform === 'youtube') {
      const env = youtubeEnv(this.env);
      return !!env.clientId && !!env.clientSecret;
    }
    if (platform === 'tiktok') {
      const env = tiktokEnv(this.env);
      return !!env.clientKey && !!env.clientSecret;
    }
    if (platform === 'meta') {
      const env = metaEnv(this.env);
      return !!env.appId && !!env.appSecret;
    }
    return false;
  }

  async getStatus(userId: string, platform: PublisherPlatform): Promise<PublisherStatus> {
    const record = await this.tokens.get(userId, platform);
    const connected = !!record && (record.expiresAtMs === undefined || record.expiresAtMs > Date.now() + 60_000);
    return {
      platform,
      configured: this.isConfigured(platform),
      connected,
      accountLabel: record?.accountLabel,
      expiresAt: record?.expiresAtMs ? new Date(record.expiresAtMs).toISOString() : undefined,
      needsReconnect: !!record && !connected && !record.refreshToken,
      missingEnv: this.missingEnv(platform)
    };
  }

  /** The statuses of ONE user's own connections: nobody else's token is ever read for this answer. */
  async statuses(userId: string): Promise<PublisherStatus[]> {
    return Promise.all((['youtube', 'tiktok', 'meta'] as const).map(p => this.getStatus(userId, p)));
  }

  connectUrl(userId: string, platform: PublisherPlatform): { url: string; state: string } {
    if (platform === 'youtube') {
      const env = youtubeEnv(this.env);
      if (!env.clientId || !env.clientSecret) {
        throw new PublisherError('NOT_CONFIGURED', 'YouTube client id/secret missing (OPENCREATOR_PUBLISHER_YOUTUBE_*)');
      }
      const state = this.states.create(platform, userId);
      return { url: youtubeAuthorizeUrl({ clientId: env.clientId, redirectUri: this.redirectUri('youtube'), state }), state };
    }
    if (platform === 'tiktok') {
      const env = tiktokEnv(this.env);
      if (!env.clientKey || !env.clientSecret) {
        throw new PublisherError('NOT_CONFIGURED', 'TikTok client key/secret missing (OPENCREATOR_PUBLISHER_TIKTOK_*)');
      }
      const state = this.states.create(platform, userId);
      return { url: tiktokAuthorizeUrl({ clientKey: env.clientKey, redirectUri: this.redirectUri('tiktok'), state }), state };
    }
    if (platform === 'meta') {
      const env = metaEnv(this.env);
      if (!env.appId || !env.appSecret) {
        throw new PublisherError('NOT_CONFIGURED', 'Meta app id/secret missing (OPENCREATOR_PUBLISHER_META_*)');
      }
      const state = this.states.create(platform, userId);
      return { url: metaAuthorizeUrl({ appId: env.appId, redirectUri: this.redirectUri('meta'), state }), state };
    }
    throw new PublisherError('NOT_IMPLEMENTED', `${platform} publisher is not wired yet`);
  }

  async handleCallback(platform: PublisherPlatform, query: { code?: string; state?: string; error?: string }): Promise<{ accountLabel?: string }> {
    if (query.error) throw new PublisherError('OAUTH_DENIED', `Provider refused: ${query.error}`.slice(0, 200));
    if (!query.code || !query.state) throw new PublisherError('INVALID_INPUT', 'Missing code/state in callback');
    const record = this.states.consume(query.state, platform);
    if (!record) throw new PublisherError('INVALID_STATE', 'Unknown or expired OAuth state');
    if (platform === 'youtube') {
      const env = youtubeEnv(this.env);
      if (!env.clientId || !env.clientSecret) throw new PublisherError('NOT_CONFIGURED', 'YouTube client id/secret missing');
      const tokens = await youtubeExchangeCode(this.fetchImpl, {
        clientId: env.clientId,
        clientSecret: env.clientSecret,
        redirectUri: this.redirectUri('youtube'),
        code: query.code
      });
      const accountLabel = await youtubeChannelTitle(this.fetchImpl, tokens.accessToken).catch(() => undefined);
      await this.tokens.save(record.userId, 'youtube', { ...tokens, scopes: 'youtube.upload', accountLabel });
      return { accountLabel };
    }
    if (platform === 'tiktok') {
      const env = tiktokEnv(this.env);
      if (!env.clientKey || !env.clientSecret) throw new PublisherError('NOT_CONFIGURED', 'TikTok client key/secret missing');
      const tokens = await tiktokExchangeCode(this.fetchImpl, {
        clientKey: env.clientKey,
        clientSecret: env.clientSecret,
        redirectUri: this.redirectUri('tiktok'),
        code: query.code
      });
      const info = await tiktokCreatorInfo(this.fetchImpl, tokens.accessToken).catch(() => undefined);
      const accountLabel = info?.nickname || info?.username;
      await this.tokens.save(record.userId, 'tiktok', {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAtMs: tokens.expiresAtMs,
        scopes: tokens.scope,
        accountLabel,
        extra: tokens.openId ? { openId: tokens.openId } : undefined
      });
      return { accountLabel };
    }
    if (platform === 'meta') {
      const env = metaEnv(this.env);
      if (!env.appId || !env.appSecret) throw new PublisherError('NOT_CONFIGURED', 'Meta app id/secret missing');
      const short = await metaExchangeCode(this.fetchImpl, {
        appId: env.appId,
        appSecret: env.appSecret,
        redirectUri: this.redirectUri('meta'),
        code: query.code
      });
      const long = await metaLongLivedToken(this.fetchImpl, {
        appId: env.appId,
        appSecret: env.appSecret,
        shortLivedToken: short.accessToken
      });
      const pages = await metaPageList(this.fetchImpl, long.accessToken);
      const page = pages[0];
      if (!page) throw new PublisherError('OAUTH_FAILED', 'Meta account has no Page to publish to');
      const igId = await metaInstagramAccountId(this.fetchImpl, { pageId: page.id, pageAccessToken: page.accessToken }).catch(() => undefined);
      await this.tokens.save(record.userId, 'meta', {
        accessToken: long.accessToken,
        expiresAtMs: long.expiresAtMs,
        accountLabel: page.name ?? page.id,
        extra: {
          pageId: page.id,
          pageName: page.name ?? '',
          pageToken: page.accessToken,
          ...(igId ? { igId } : {})
        }
      });
      return { accountLabel: page.name ?? page.id };
    }
    throw new PublisherError('NOT_IMPLEMENTED', `${platform} publisher is not wired yet`);
  }

  /** Publishes with the token of `userId` (the user who is publishing), never another user's. */
  async publish(userId: string, platform: PublisherPlatform, input: PublishInput): Promise<PublishResult> {
    if (input.publishAt && platform !== 'youtube') {
      throw new PublisherError('INVALID_INPUT', 'Jadwal tayang hanya didukung untuk YouTube');
    }
    if (platform === 'youtube') {
      const accessToken = await this.youtubeAccessToken(userId);
      const out = await youtubeUploadVideo(this.fetchImpl, {
        filePath: input.filePath,
        title: input.title,
        description: input.description,
        privacyStatus: input.visibility ?? 'unlisted',
        ...(input.publishAt ? { publishAt: input.publishAt } : {}),
        accessToken
      });
      return { ok: true, platform, externalId: out.videoId, url: out.url };
    }
    if (platform === 'tiktok') {
      const record = await this.tokens.get(userId, 'tiktok');
      if (!record) throw new PublisherError('NOT_CONNECTED', 'TikTok is not connected');
      const accessToken = await this.tiktokAccessToken(userId, record);
      const out = await tiktokPublishVideo(this.fetchImpl, {
        filePath: input.filePath,
        title: input.description ? `${input.title}\n${input.description}`.slice(0, 2200) : input.title,
        accessToken,
        privacyLevel: input.visibility === 'public' ? 'PUBLIC_TO_EVERYONE' : 'SELF_ONLY'
      });
      return { ok: true, platform, externalId: out.publishId };
    }
    if (platform === 'meta') {
      const record = await this.tokens.get(userId, 'meta');
      if (!record?.extra?.pageId || !record.extra.pageToken) {
        throw new PublisherError('NOT_CONNECTED', 'Meta is not connected');
      }
      const caption = input.description ? `${input.title}\n${input.description}` : input.title;
      if ((input.target ?? 'facebook') === 'instagram') {
        const igId = record.extra.igId
          ?? await metaInstagramAccountId(this.fetchImpl, { pageId: record.extra.pageId, pageAccessToken: record.extra.pageToken });
        if (!igId) throw new PublisherError('NOT_CONNECTED', 'No Instagram business account linked to this Page');
        if (record.extra.igId !== igId) {
          await this.tokens.save(userId, 'meta', { ...record, extra: { ...record.extra, igId } });
        }
        const out = await metaPublishInstagramReel(this.fetchImpl, {
          igUserId: igId,
          accessToken: record.accessToken,
          filePath: input.filePath,
          caption: caption.slice(0, 2200)
        });
        return { ok: true, platform, externalId: out.containerId };
      }
      const out = await metaPublishFacebookReel(this.fetchImpl, {
        pageId: record.extra.pageId,
        pageAccessToken: record.extra.pageToken,
        filePath: input.filePath,
        description: caption.slice(0, 5000)
      });
      return { ok: true, platform, externalId: out.videoId };
    }
    throw new PublisherError('NOT_IMPLEMENTED', `${platform} publisher is not wired yet`);
  }

  private async youtubeAccessToken(userId: string): Promise<string> {
    const record = await this.tokens.get(userId, 'youtube');
    if (!record) throw new PublisherError('NOT_CONNECTED', 'YouTube is not connected');
    if (record.expiresAtMs === undefined || record.expiresAtMs > Date.now() + 60_000) return record.accessToken;
    if (!record.refreshToken) throw new PublisherError('NEEDS_RECONNECT', 'YouTube session expired — reconnect');
    const env = youtubeEnv(this.env);
    if (!env.clientId || !env.clientSecret) throw new PublisherError('NOT_CONFIGURED', 'YouTube client id/secret missing');
    const fresh = await youtubeRefreshAccessToken(this.fetchImpl, {
      clientId: env.clientId,
      clientSecret: env.clientSecret,
      refreshToken: record.refreshToken
    });
    await this.tokens.save(userId, 'youtube', { ...record, accessToken: fresh.accessToken, expiresAtMs: fresh.expiresAtMs });
    return fresh.accessToken;
  }

  private async tiktokAccessToken(userId: string, record: { accessToken: string; expiresAtMs?: number; refreshToken?: string }): Promise<string> {
    if (record.expiresAtMs === undefined || record.expiresAtMs > Date.now() + 60_000) return record.accessToken;
    if (!record.refreshToken) throw new PublisherError('NEEDS_RECONNECT', 'TikTok session expired — reconnect');
    const env = tiktokEnv(this.env);
    if (!env.clientKey || !env.clientSecret) throw new PublisherError('NOT_CONFIGURED', 'TikTok client key/secret missing');
    const fresh = await tiktokRefreshAccessToken(this.fetchImpl, {
      clientKey: env.clientKey,
      clientSecret: env.clientSecret,
      refreshToken: record.refreshToken
    });
    await this.tokens.save(userId, 'tiktok', {
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken ?? record.refreshToken,
      expiresAtMs: fresh.expiresAtMs,
      scopes: fresh.scope,
      extra: fresh.openId ? { openId: fresh.openId } : undefined
    });
    return fresh.accessToken;
  }

  async disconnect(userId: string, platform: PublisherPlatform): Promise<void> {
    await this.tokens.clear(userId, platform);
  }
}
