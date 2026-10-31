import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateLegacyPublisherTokens, migratePublisherTokensAtBoot, rollbackLegacyPublisherTokens } from '../src/publisher/migrate.js';
import { resolveMainOwner } from '../src/publisher/owner.js';
import { PublisherService } from '../src/publisher/service.js';
import { PublisherTokenStore } from '../src/publisher/token-store.js';
import { LEGACY_RECORDS, LEGACY_SECRET_FRAGMENTS, writeLegacyTokens } from './publisher-legacy-fixtures.js';
import { fakeGoogle, publisherEnv } from './publisher-world.js';

const OWNER = 'u_ownerJoseph01';
const dataDir = () => mkdtempSync(join(tmpdir(), 'nc-pubmig-'));
const tree = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`); else out.push(`${prefix}${name}`);
    }
  };
  walk(root, '');
  return out;
};

describe('migrateLegacyPublisherTokens', () => {
  it('moves each legacy file to the owner (byte-identical, 0600), retires the global file, backs up, records a manifest', async () => {
    const dir = dataDir();
    const original = writeLegacyTokens(dir);
    const result = await migrateLegacyPublisherTokens({ dataDir: dir, ownerUserId: OWNER, ownerEmail: 'joseph@nirmalab.com', now: () => new Date('2026-11-01T02:00:00Z') });
    expect(result).toMatchObject({ status: 'migrated', moved: ['youtube', 'tiktok', 'meta'], ownerKept: [], skipped: [] });
    const root = join(dir, 'publisher');
    for (const platform of ['youtube', 'tiktok', 'meta'] as const) {
      const target = join(root, OWNER, `${platform}.json`);
      expect(readFileSync(target).equals(original[platform]!)).toBe(true);
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(existsSync(join(root, `${platform}.json`))).toBe(false); // no global token stays readable
      expect(readFileSync(join(root, `${platform}.json.migrated-bak`)).equals(original[platform]!)).toBe(true);
      expect(readFileSync(join(root, '.migrations', '20261101T020000Z', 'backup', `${platform}.json`)).equals(original[platform]!)).toBe(true);
    }
    expect(statSync(join(root, OWNER)).mode & 0o777).toBe(0o700);
    const manifestText = readFileSync(result.manifestPath!, 'utf8');
    for (const secret of LEGACY_SECRET_FRAGMENTS) expect(manifestText).not.toContain(secret);
    const manifest = JSON.parse(manifestText);
    expect(manifest).toMatchObject({ version: 1, id: '20261101T020000Z', ownerUserId: OWNER, ownerEmail: 'joseph@nirmalab.com' });
    expect(manifest.entries.map((e: { platform: string; outcome: string; bytes: number }) => [e.platform, e.outcome, e.bytes])).toEqual([
      ['youtube', 'moved', original.youtube!.length], ['tiktok', 'moved', original.tiktok!.length], ['meta', 'moved', original.meta!.length]
    ]);
  });

  it('the migrated tokens work: the owner can use them through the per-user store, nobody else sees them', async () => {
    const dir = dataDir();
    writeLegacyTokens(dir);
    await migrateLegacyPublisherTokens({ dataDir: dir, ownerUserId: OWNER });
    const store = new PublisherTokenStore(join(dir, 'publisher'));
    expect(await store.get(OWNER, 'youtube')).toMatchObject(LEGACY_RECORDS.youtube);
    expect(await store.get(OWNER, 'tiktok')).toMatchObject({ extra: { openId: 'open-123' } });
    expect(await store.get(OWNER, 'meta')).toMatchObject({ extra: { pageId: '1001', pageToken: 'EAApageFFFF', igId: '1784' } });
    expect(await store.get('u_someoneElse1', 'youtube')).toBeUndefined();
  });

  it('an expired legacy YouTube token still refreshes and uploads for the owner after migration (real service, fake Google)', async () => {
    const dir = dataDir();
    writeLegacyTokens(dir, ['youtube'], { youtube: { ...LEGACY_RECORDS.youtube, expiresAtMs: Date.now() - 5000 } });
    await migrateLegacyPublisherTokens({ dataDir: dir, ownerUserId: OWNER });
    const google = fakeGoogle();
    const service = new PublisherService({ dataDir: dir, env: publisherEnv, fetchImpl: google.fetchImpl as never });
    const video = join(mkdtempSync(join(tmpdir(), 'nc-v-')), 'f.mp4');
    writeFileSync(video, Buffer.alloc(8));
    const out = await service.publish(OWNER, 'youtube', { filePath: video, title: 'Lentera', visibility: 'private' });
    expect(out.ok).toBe(true);
    expect(google.refreshes).toEqual(['1//legacy-refresh-token-BBBB']);
    expect(google.uploads[0]?.authorization).toBe('Bearer fresh-of-1//legacy-refresh-token-BBBB');
    await expect(service.publish('u_someoneElse1', 'youtube', { filePath: video, title: 'x' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('is idempotent: a second run writes nothing — no new manifest, no changed file', async () => {
    const dir = dataDir();
    writeLegacyTokens(dir);
    await migrateLegacyPublisherTokens({ dataDir: dir, ownerUserId: OWNER, now: () => new Date('2026-11-01T02:00:00Z') });
    const before = tree(join(dir, 'publisher'));
    const bytes = before.map(f => readFileSync(join(dir, 'publisher', f)));
    const again = await migrateLegacyPublisherTokens({ dataDir: dir, ownerUserId: OWNER, now: () => new Date('2026-11-01T03:00:00Z') });
    expect(again.status).toBe('nothing-to-migrate');
    expect(tree(join(dir, 'publisher'))).toEqual(before);
    expect(before.map(f => readFileSync(join(dir, 'publisher', f)).equals(bytes[before.indexOf(f)]!))).toEqual(before.map(() => true));
  });

  it('with no publisher directory at all it does nothing and creates nothing', async () => {
    const dir = dataDir();
    expect((await migrateLegacyPublisherTokens({ dataDir: dir, ownerUserId: OWNER })).status).toBe('nothing-to-migrate');
    expect(existsSync(join(dir, 'publisher'))).toBe(false);
  });

  it('resumes after a crash between "owner file written" and "legacy retired" (no error, no duplicate)', async () => {
    const dir = dataDir();
    const original = writeLegacyTokens(dir, ['youtube']);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'publisher', OWNER), { recursive: true });
    writeFileSync(join(dir, 'publisher', OWNER, 'youtube.json'), original.youtube!, { mode: 0o600 });
    const result = await migrateLegacyPublisherTokens({ dataDir: dir, ownerUserId: OWNER });
    expect(result).toMatchObject({ status: 'migrated', moved: ['youtube'] });
    expect(JSON.parse(readFileSync(result.manifestPath!, 'utf8')).entries[0].outcome).toBe('already-in-place');
    expect(existsSync(join(dir, 'publisher', 'youtube.json'))).toBe(false);
    expect(readFileSync(join(dir, 'publisher', OWNER, 'youtube.json')).equals(original.youtube!)).toBe(true);
  });

  it('never overwrites a token the owner connected on their own; the stale global one is retired and backed up', async () => {
    const dir = dataDir();
    const original = writeLegacyTokens(dir, ['youtube']);
    const own = { ...LEGACY_RECORDS.youtube, accessToken: 'ya29.OWN-new-connection', accountLabel: 'Joseph reconnected' };
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'publisher', OWNER), { recursive: true });
    writeFileSync(join(dir, 'publisher', OWNER, 'youtube.json'), `${JSON.stringify(own, null, 2)}\n`, { mode: 0o600 });
    const result = await migrateLegacyPublisherTokens({ dataDir: dir, ownerUserId: OWNER, now: () => new Date('2026-11-01T02:00:00Z') });
    expect(result).toMatchObject({ status: 'migrated', moved: [], ownerKept: ['youtube'] });
    expect(JSON.parse(readFileSync(join(dir, 'publisher', OWNER, 'youtube.json'), 'utf8')).accountLabel).toBe('Joseph reconnected');
    expect(readFileSync(join(dir, 'publisher', '.migrations', '20261101T020000Z', 'backup', 'youtube.json')).equals(original.youtube!)).toBe(true);
    expect(existsSync(join(dir, 'publisher', 'youtube.json'))).toBe(false);
  });

  it('a corrupt or unrecognised legacy file is left exactly where it is and reported; the others still migrate', async () => {
    const dir = dataDir();
    writeLegacyTokens(dir, ['youtube', 'meta']);
    writeFileSync(join(dir, 'publisher', 'tiktok.json'), '{"version":1,"accessToken":"half-writ', { mode: 0o600 });
    const result = await migrateLegacyPublisherTokens({ dataDir: dir, ownerUserId: OWNER });
    expect(result.moved).toEqual(['youtube', 'meta']);
    expect(result.skipped).toEqual([{ platform: 'tiktok', reason: 'unreadable-left-in-place' }]);
    expect(readFileSync(join(dir, 'publisher', 'tiktok.json'), 'utf8')).toBe('{"version":1,"accessToken":"half-writ');
  });

  it('refuses an unsafe owner id before touching anything', async () => {
    const dir = dataDir();
    writeLegacyTokens(dir);
    await expect(migrateLegacyPublisherTokens({ dataDir: dir, ownerUserId: '../evil' })).rejects.toThrow(/owner user id/);
    expect(existsSync(join(dir, 'publisher', 'youtube.json'))).toBe(true);
  });
});

describe('rollbackLegacyPublisherTokens', () => {
  it('restores the legacy files byte-identical and removes what the migration created', async () => {
    const dir = dataDir();
    const original = writeLegacyTokens(dir);
    const before = tree(join(dir, 'publisher'));
    const migrated = await migrateLegacyPublisherTokens({ dataDir: dir, ownerUserId: OWNER, now: () => new Date('2026-11-01T02:00:00Z') });
    const out = await rollbackLegacyPublisherTokens({ dataDir: dir, manifest: migrated.manifestPath! });
    expect(out).toEqual({ status: 'rolled-back', restored: ['youtube', 'tiktok', 'meta'], skipped: [] });
    for (const platform of ['youtube', 'tiktok', 'meta'] as const) {
      expect(readFileSync(join(dir, 'publisher', `${platform}.json`)).equals(original[platform]!)).toBe(true);
      expect(statSync(join(dir, 'publisher', `${platform}.json`)).mode & 0o777).toBe(0o600);
    }
    const after = tree(join(dir, 'publisher')).filter(f => !f.startsWith('.migrations/'));
    expect(after).toEqual(before);
    expect(existsSync(join(dir, 'publisher', OWNER))).toBe(false);
    expect(JSON.parse(readFileSync(migrated.manifestPath!, 'utf8')).rolledBackAt).toBeTruthy();
  });

  it('is idempotent and accepts a run id instead of a path', async () => {
    const dir = dataDir();
    writeLegacyTokens(dir);
    await migrateLegacyPublisherTokens({ dataDir: dir, ownerUserId: OWNER, now: () => new Date('2026-11-01T02:00:00Z') });
    expect((await rollbackLegacyPublisherTokens({ dataDir: dir, manifest: '20261101T020000Z' })).status).toBe('rolled-back');
    const snapshot = tree(join(dir, 'publisher'));
    expect((await rollbackLegacyPublisherTokens({ dataDir: dir, manifest: '20261101T020000Z' })).status).toBe('already-rolled-back');
    expect(tree(join(dir, 'publisher'))).toEqual(snapshot);
  });

  it('puts back the owner\'s CURRENT token when it was refreshed after migrating (TikTok rotates refresh tokens)', async () => {
    const dir = dataDir();
    writeLegacyTokens(dir, ['tiktok']);
    const migrated = await migrateLegacyPublisherTokens({ dataDir: dir, ownerUserId: OWNER });
    const store = new PublisherTokenStore(join(dir, 'publisher'));
    await store.save(OWNER, 'tiktok', { ...LEGACY_RECORDS.tiktok, accessToken: 'act.ROTATED', refreshToken: 'rft.ROTATED' });
    await rollbackLegacyPublisherTokens({ dataDir: dir, manifest: migrated.manifestPath! });
    expect(JSON.parse(readFileSync(join(dir, 'publisher', 'tiktok.json'), 'utf8'))).toMatchObject({ accessToken: 'act.ROTATED', refreshToken: 'rft.ROTATED' });
    expect(JSON.parse(readFileSync(migrated.manifestPath!, 'utf8')).rollback).toEqual([{ platform: 'tiktok', result: 'restored-current-token' }]);
  });

  it('leaves the owner\'s own token alone when the migration had not replaced it, and does not clobber a legacy file that reappeared', async () => {
    const dir = dataDir();
    writeLegacyTokens(dir, ['youtube', 'meta']);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'publisher', OWNER), { recursive: true });
    writeFileSync(join(dir, 'publisher', OWNER, 'youtube.json'), `${JSON.stringify({ ...LEGACY_RECORDS.youtube, accessToken: 'ya29.OWN' }, null, 2)}\n`, { mode: 0o600 });
    const migrated = await migrateLegacyPublisherTokens({ dataDir: dir, ownerUserId: OWNER });
    writeFileSync(join(dir, 'publisher', 'meta.json'), JSON.stringify({ version: 1, platform: 'meta', accessToken: 'newer-global' }), { mode: 0o600 });
    const out = await rollbackLegacyPublisherTokens({ dataDir: dir, manifest: migrated.manifestPath! });
    expect(out).toEqual({ status: 'rolled-back', restored: ['youtube'], skipped: ['meta'] });
    expect(JSON.parse(readFileSync(join(dir, 'publisher', OWNER, 'youtube.json'), 'utf8')).accessToken).toBe('ya29.OWN');
    expect(JSON.parse(readFileSync(join(dir, 'publisher', 'youtube.json'), 'utf8')).accessToken).toBe('ya29.legacy-access-token-AAAA');
    expect(JSON.parse(readFileSync(join(dir, 'publisher', 'meta.json'), 'utf8')).accessToken).toBe('newer-global');
  });

  it('the operator CLI rolls back from a manifest path (real process, no network)', async () => {
    const dir = dataDir();
    const original = writeLegacyTokens(dir, ['youtube']);
    const migrated = await migrateLegacyPublisherTokens({ dataDir: dir, ownerUserId: OWNER });
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'server/src/publisher/migrate-cli.ts', 'rollback', dir, migrated.manifestPath!], { encoding: 'utf8', timeout: 60_000 });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('rolled-back: restored [youtube]');
    expect(readFileSync(join(dir, 'publisher', 'youtube.json')).equals(original.youtube!)).toBe(true);
    const bad = spawnSync(process.execPath, ['--import', 'tsx', 'server/src/publisher/migrate-cli.ts'], { encoding: 'utf8', timeout: 60_000 });
    expect(bad.status).toBe(2);
  }, 90_000);
});

describe('resolveMainOwner + boot helper', () => {
  const users = [
    { id: 'u_qa', email: 'qa-admin@nirmalab.local', isAdmin: true, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'u_member', email: 'mira@x.io', isAdmin: false, createdAt: '2026-01-02T00:00:00.000Z' },
    { id: 'u_joseph', email: 'Joseph@Nirmalab.com', isAdmin: true, createdAt: '2026-03-01T00:00:00.000Z' },
    { id: 'u_bina', email: 'bina@x.io', isAdmin: true, createdAt: '2026-05-01T00:00:00.000Z' }
  ];
  it('oldest admin that is not a QA account; members never; an explicit email wins; an unknown explicit email is NOT a silent fallback', () => {
    expect(resolveMainOwner(users, {}).owner).toMatchObject({ user: { id: 'u_joseph' }, reason: 'oldest-admin' });
    expect(resolveMainOwner(users, { TENANCY_DEFAULT_OWNER_EMAIL: ' BINA@x.io ' }).owner).toMatchObject({ user: { id: 'u_bina' }, reason: 'configured' });
    expect(resolveMainOwner(users, { TENANCY_DEFAULT_OWNER_EMAIL: 'mira@x.io' }).owner?.user.id).toBe('u_member');
    expect(resolveMainOwner(users, { TENANCY_DEFAULT_OWNER_EMAIL: 'ghost@x.io' })).toEqual({ missing: 'configured-owner-not-found' });
    expect(resolveMainOwner([users[0]!, users[1]!], {})).toEqual({ missing: 'no-admin' });
  });

  it('the boot helper never throws: no owner => legacy files untouched + an error line', async () => {
    const dir = dataDir();
    writeLegacyTokens(dir);
    const lines: string[] = [];
    const log = { info: (m: string) => lines.push(`I ${m}`), error: (m: string) => lines.push(`E ${m}`) };
    expect(await migratePublisherTokensAtBoot({ dataDir: dir, users: [], env: {}, log })).toBeUndefined();
    expect(existsSync(join(dir, 'publisher', 'youtube.json'))).toBe(true);
    expect(lines.join('\n')).toMatch(/E publisher: legacy global tokens left untouched.*no-admin/);
    // A broken target (a FILE where the owner directory must go) must not crash boot and must keep the legacy file.
    writeFileSync(join(dir, 'publisher', 'u_joseph'), 'not a directory');
    const out = await migratePublisherTokensAtBoot({ dataDir: dir, users: users as never, env: {}, log });
    expect(out).toBeUndefined();
    expect(existsSync(join(dir, 'publisher', 'youtube.json'))).toBe(true);
    expect(lines.at(-1)).toMatch(/^E publisher: token migration failed, legacy files kept/);
    for (const secret of LEGACY_SECRET_FRAGMENTS) expect(lines.join('\n')).not.toContain(secret);
  });
});
