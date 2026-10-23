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

export class PublisherTokenStore {
  constructor(private readonly root: string) {}

  private path(platform: PublisherPlatform): string {
    return join(this.root, `${platform}.json`);
  }

  async get(platform: PublisherPlatform): Promise<PublisherTokenRecord | undefined> {
    const raw = await readPrivateJsonFile(this.path(platform));
    if (!raw || typeof raw !== 'object') return undefined;
    const record = raw as Partial<PublisherTokenRecord>;
    if (record.version !== 1 || typeof record.accessToken !== 'string') return undefined;
    return record as PublisherTokenRecord;
  }

  async save(platform: PublisherPlatform, record: Omit<PublisherTokenRecord, 'version' | 'platform' | 'updatedAt'> & { platform?: PublisherPlatform }): Promise<PublisherTokenRecord> {
    const full: PublisherTokenRecord = {
      version: 1,
      platform,
      updatedAt: new Date().toISOString(),
      ...record
    };
    await writePrivateJsonFile(this.path(platform), full);
    return full;
  }

  async clear(platform: PublisherPlatform): Promise<void> {
    await deletePrivateJsonFile(this.path(platform));
  }
}
