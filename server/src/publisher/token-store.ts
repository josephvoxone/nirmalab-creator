import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  deletePrivateJsonFile,
  readPrivateJsonFile,
  writePrivateJsonFile
} from '../lib/private-json-file.js';
import type { PublisherPlatform } from './types.js';

export type PublisherTokenRecord = {
  version: 1;
  platform: PublisherPlatform;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires (if known). */
  expiresAtMs?: number;
  scopes?: string;
  accountLabel?: string;
  /** Platform-specific extras (page id, open_id, ig id, ...). */
  extra?: Record<string, string>;
  updatedAt: string;
};

/** Account ids look like `u_<token>`. Anything else (dots, slashes, empty) never reaches the filesystem. */
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeUserId(userId: unknown): userId is string {
  return typeof userId === 'string' && USER_ID.test(userId);
}

const ALL_PLATFORMS: PublisherPlatform[] = ['youtube', 'tiktok', 'meta'];

/**
 * OAuth tokens, one private file per (user, platform): `<root>/<userId>/<platform>.json` (file 0600, dir 0700,
 * written atomically via tmp+rename). There is no platform-wide token: every read and write names its owner.
 */
export class PublisherTokenStore {
  constructor(private readonly root: string) {}

  private userDir(userId: string): string {
    if (!isSafeUserId(userId)) throw new Error('Invalid user id for the publisher token store');
    return join(this.root, userId);
  }

  private path(userId: string, platform: PublisherPlatform): string {
    return join(this.userDir(userId), `${platform}.json`);
  }

  async get(userId: string, platform: PublisherPlatform): Promise<PublisherTokenRecord | undefined> {
    const raw = await readPrivateJsonFile(this.path(userId, platform));
    if (!raw || typeof raw !== 'object') return undefined;
    const record = raw as Partial<PublisherTokenRecord>;
    if (record.version !== 1 || typeof record.accessToken !== 'string') return undefined;
    return record as PublisherTokenRecord;
  }

  async save(userId: string, platform: PublisherPlatform, record: Omit<PublisherTokenRecord, 'version' | 'platform' | 'updatedAt'> & { platform?: PublisherPlatform }): Promise<PublisherTokenRecord> {
    const full: PublisherTokenRecord = {
      version: 1,
      platform,
      updatedAt: new Date().toISOString(),
      ...record
    };
    await writePrivateJsonFile(this.path(userId, platform), full);
    return full;
  }

  async clear(userId: string, platform: PublisherPlatform): Promise<void> {
    await deletePrivateJsonFile(this.path(userId, platform));
  }

  /** The platforms this user currently has a token file for. */
  async platformsFor(userId: string): Promise<PublisherPlatform[]> {
    const present: PublisherPlatform[] = [];
    for (const platform of ALL_PLATFORMS) {
      if (await this.get(userId, platform).catch(() => undefined)) present.push(platform);
    }
    return present;
  }

  /** Removes every token of this user (account removal). Safe to call twice; returns what was there. */
  async revokeAllFor(userId: string): Promise<PublisherPlatform[]> {
    const dir = this.userDir(userId);
    const had = await this.platformsFor(userId);
    await rm(dir, { recursive: true, force: true });
    return had;
  }
}
