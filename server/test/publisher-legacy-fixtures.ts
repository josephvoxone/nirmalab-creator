import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Token files exactly as the pre-tenancy server wrote them (`writePrivateJsonFile`: 2-space JSON + newline, mode 0600,
 * one per platform directly under `<data>/publisher/`). The values are made up but shaped like the real thing.
 */
export const LEGACY_RECORDS = {
  youtube: {
    version: 1, platform: 'youtube', accessToken: 'ya29.legacy-access-token-AAAA', refreshToken: '1//legacy-refresh-token-BBBB',
    expiresAtMs: 4_102_444_800_000, scopes: 'youtube.upload', accountLabel: 'Lentera Channel', updatedAt: '2026-10-12T08:30:00.000Z'
  },
  tiktok: {
    version: 1, platform: 'tiktok', accessToken: 'act.legacy-tiktok-CCCC', refreshToken: 'rft.legacy-tiktok-DDDD',
    expiresAtMs: 4_102_444_800_000, scopes: 'user.info.basic,video.publish', accountLabel: 'lentera.id', extra: { openId: 'open-123' }, updatedAt: '2026-10-12T08:31:00.000Z'
  },
  meta: {
    version: 1, platform: 'meta', accessToken: 'EAAlegacyMetaEEEE', expiresAtMs: 4_102_444_800_000, accountLabel: 'Lentera Page',
    extra: { pageId: '1001', pageName: 'Lentera Page', pageToken: 'EAApageFFFF', igId: '1784' }, updatedAt: '2026-10-12T08:32:00.000Z'
  }
} as const;

export const LEGACY_SECRET_FRAGMENTS = ['legacy-access-token-AAAA', 'legacy-refresh-token-BBBB', 'legacy-tiktok-CCCC', 'legacy-tiktok-DDDD', 'legacyMetaEEEE', 'pageFFFF'];

export function writeLegacyTokens(dataDir: string, platforms: Array<keyof typeof LEGACY_RECORDS> = ['youtube', 'tiktok', 'meta'], overrides: Partial<Record<keyof typeof LEGACY_RECORDS, unknown>> = {}): Record<string, Buffer> {
  const root = join(dataDir, 'publisher');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const bytes: Record<string, Buffer> = {};
  for (const platform of platforms) {
    const file = join(root, `${platform}.json`);
    const body = Buffer.from(`${JSON.stringify(overrides[platform] ?? LEGACY_RECORDS[platform], null, 2)}\n`, 'utf8');
    writeFileSync(file, body, { mode: 0o600 });
    chmodSync(file, 0o600);
    bytes[platform] = body;
  }
  return bytes;
}
