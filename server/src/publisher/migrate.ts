import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveMainOwner, type OwnerCandidate } from './owner.js';
import { isSafeUserId } from './token-store.js';
import type { PublisherPlatform } from './types.js';

/**
 * Pre-tenancy the server kept ONE token file per platform (`<data>/publisher/<platform>.json`). Per-user storage
 * lives in `<data>/publisher/<userId>/<platform>.json`. This moves the old files to the main owner:
 *
 *  1. backup first: byte-identical copy in `.migrations/<id>/backup/` (nothing is ever deleted),
 *  2. write the owner's file atomically (0600), unless the owner already has a DIFFERENT token of their own,
 *  3. retire the legacy file by renaming it `<platform>.json.migrated-bak` (so no global token stays readable),
 *  4. a manifest (`.migrations/<id>/manifest.json`) records sizes + sha256 + paths — never token contents.
 *
 * Idempotent (no legacy file = nothing happens, no manifest), resumable (crash between steps: run again), and
 * reversible (`rollbackLegacyPublisherTokens`).
 */

const PLATFORMS: PublisherPlatform[] = ['youtube', 'tiktok', 'meta'];

export type MigrationOutcome = 'moved' | 'owner-has-own' | 'already-in-place';

export type MigrationEntry = {
  platform: PublisherPlatform;
  /** All paths are relative to `<data>/publisher/`. */
  legacy: string;
  backup: string;
  target: string;
  retiredTo?: string;
  sha256: string;
  bytes: number;
  outcome: MigrationOutcome;
};

export type MigrationManifest = {
  version: 1;
  id: string;
  createdAt: string;
  ownerUserId: string;
  ownerEmail?: string;
  entries: MigrationEntry[];
  skipped: Array<{ platform: PublisherPlatform; reason: string }>;
  rolledBackAt?: string;
  rollback?: Array<{ platform: PublisherPlatform; result: 'restored-backup' | 'restored-current-token' | 'legacy-exists' | 'nothing-to-restore' }>;
};

export type MigrationResult = {
  status: 'nothing-to-migrate' | 'migrated';
  ownerUserId: string;
  moved: PublisherPlatform[];
  ownerKept: PublisherPlatform[];
  skipped: MigrationManifest['skipped'];
  manifestPath?: string;
};

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

async function readBytes(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeBytesAtomic(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, bytes, { flag: 'wx', mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseRecord(bytes: Buffer, platform: PublisherPlatform): boolean {
  try {
    const record = JSON.parse(bytes.toString('utf8')) as { version?: unknown; accessToken?: unknown; platform?: unknown };
    return record.version === 1 && typeof record.accessToken === 'string' && record.accessToken.length > 0 && (record.platform === undefined || record.platform === platform);
  } catch {
    return false;
  }
}

async function nextRunId(migrationsDir: string, now: Date): Promise<string> {
  const base = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const taken = new Set(await readdir(migrationsDir).catch(() => [] as string[]));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

const manifestFile = (root: string, id: string): string => join(root, '.migrations', id, 'manifest.json');

async function writeManifest(root: string, manifest: MigrationManifest): Promise<string> {
  const path = manifestFile(root, manifest.id);
  await writeBytesAtomic(path, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  return path;
}

export async function migrateLegacyPublisherTokens(options: { dataDir: string; ownerUserId: string; ownerEmail?: string; now?: () => Date }): Promise<MigrationResult> {
  const { ownerUserId } = options;
  if (!isSafeUserId(ownerUserId)) throw new Error('Invalid owner user id for the publisher token migration');
  const root = join(options.dataDir, 'publisher');
  const found: Array<{ platform: PublisherPlatform; bytes: Buffer }> = [];
  const skipped: MigrationManifest['skipped'] = [];
  for (const platform of PLATFORMS) {
    const bytes = await readBytes(join(root, `${platform}.json`));
    if (!bytes) continue;
    if (!parseRecord(bytes, platform)) { skipped.push({ platform, reason: 'unreadable-left-in-place' }); continue; }
    found.push({ platform, bytes });
  }
  if (found.length === 0) return { status: 'nothing-to-migrate', ownerUserId, moved: [], ownerKept: [], skipped };

  const now = options.now?.() ?? new Date();
  const id = await nextRunId(join(root, '.migrations'), now);
  const manifest: MigrationManifest = {
    version: 1, id, createdAt: now.toISOString(), ownerUserId,
    ...(options.ownerEmail ? { ownerEmail: options.ownerEmail } : {}),
    entries: [], skipped
  };
  const entries: MigrationEntry[] = found.map(({ platform, bytes }) => ({
    platform,
    legacy: `${platform}.json`,
    backup: join('.migrations', id, 'backup', `${platform}.json`),
    target: join(ownerUserId, `${platform}.json`),
    sha256: sha(bytes),
    bytes: bytes.length,
    outcome: 'moved' as MigrationOutcome
  }));
  manifest.entries = entries;
  await writeManifest(root, manifest); // before the first mutation: a crash leaves a trail

  for (const [index, entry] of entries.entries()) {
    const bytes = found[index]!.bytes;
    await writeBytesAtomic(join(root, entry.backup), bytes); // 1. backup
    const existing = await readBytes(join(root, entry.target));
    if (existing && sha(existing) === entry.sha256) entry.outcome = 'already-in-place';
    else if (existing) entry.outcome = 'owner-has-own';
    else await writeBytesAtomic(join(root, entry.target), bytes); // 2. owner's own file
    let retired = `${entry.legacy}.migrated-bak`;
    if (await readBytes(join(root, retired))) retired = `${retired}.${id}`;
    await rename(join(root, entry.legacy), join(root, retired)); // 3. retire the global file
    entry.retiredTo = retired;
  }
  const manifestPath = await writeManifest(root, manifest); // 4. final record
  return {
    status: 'migrated',
    ownerUserId,
    moved: entries.filter(e => e.outcome !== 'owner-has-own').map(e => e.platform),
    ownerKept: entries.filter(e => e.outcome === 'owner-has-own').map(e => e.platform),
    skipped,
    manifestPath
  };
}

export type RollbackResult = { status: 'rolled-back' | 'already-rolled-back'; restored: PublisherPlatform[]; skipped: PublisherPlatform[] };

/**
 * Puts the legacy global files back and removes what the migration created. If the owner's token was refreshed since
 * (TikTok rotates refresh tokens), the CURRENT token is what goes back, not the stale backup. Idempotent.
 * `manifest` is a manifest path or a run id under `.migrations/`.
 */
export async function rollbackLegacyPublisherTokens(options: { dataDir: string; manifest: string; now?: () => Date }): Promise<RollbackResult> {
  const root = join(options.dataDir, 'publisher');
  const path = isAbsolute(options.manifest) || options.manifest.includes('/') ? resolve(options.manifest) : manifestFile(root, options.manifest);
  const raw = await readBytes(path);
  if (!raw) throw new Error(`Migration manifest not found: ${path}`);
  const manifest = JSON.parse(raw.toString('utf8')) as MigrationManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) throw new Error('Unrecognised migration manifest');
  if (manifest.rolledBackAt) return { status: 'already-rolled-back', restored: [], skipped: [] };

  const log: NonNullable<MigrationManifest['rollback']> = [];
  const restored: PublisherPlatform[] = [];
  const skipped: PublisherPlatform[] = [];
  for (const entry of manifest.entries) {
    const legacyPath = join(root, entry.legacy);
    if (await readBytes(legacyPath)) { log.push({ platform: entry.platform, result: 'legacy-exists' }); skipped.push(entry.platform); continue; }
    const backup = await readBytes(join(root, entry.backup));
    const current = entry.outcome === 'owner-has-own' ? undefined : await readBytes(join(root, entry.target));
    const source = current && parseRecord(current, entry.platform) ? current : backup;
    if (!source) { log.push({ platform: entry.platform, result: 'nothing-to-restore' }); skipped.push(entry.platform); continue; }
    await writeBytesAtomic(legacyPath, source);
    log.push({ platform: entry.platform, result: source === backup ? 'restored-backup' : 'restored-current-token' });
    restored.push(entry.platform);
    if (entry.outcome !== 'owner-has-own') {
      await rm(join(root, entry.target), { force: true });
      await rmdir(dirname(join(root, entry.target))).catch(() => undefined); // only succeeds when empty
    }
    if (entry.retiredTo) {
      const retired = await readBytes(join(root, entry.retiredTo));
      if (retired && backup && sha(retired) === sha(backup)) await rm(join(root, entry.retiredTo), { force: true });
    }
  }
  manifest.rolledBackAt = (options.now?.() ?? new Date()).toISOString();
  manifest.rollback = log;
  await writeBytesAtomic(path, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
  return { status: 'rolled-back', restored, skipped };
}

export type BootLogger = { info(message: string): void; error(message: string): void };

/**
 * Called once at boot. Cheap when there is nothing to do. Never throws (a problem here must not take the whole
 * server down; the legacy files are only retired after their backup and the owner's copy are written, so a failed
 * run leaves everything recoverable and the next boot tries again).
 */
export async function migratePublisherTokensAtBoot(options: { dataDir: string; users: readonly OwnerCandidate[]; env?: NodeJS.ProcessEnv; log: BootLogger }): Promise<MigrationResult | undefined> {
  const root = join(options.dataDir, 'publisher');
  try {
    const present = await Promise.all(PLATFORMS.map(async p => !!(await readBytes(join(root, `${p}.json`)))));
    if (!present.some(Boolean)) return undefined;
    const lookup = resolveMainOwner(options.users, options.env ?? process.env);
    if (!lookup.owner) {
      options.log.error(`publisher: legacy global tokens left untouched — no owner to adopt them (${lookup.missing}). Set TENANCY_DEFAULT_OWNER_EMAIL to an existing account.`);
      return undefined;
    }
    const result = await migrateLegacyPublisherTokens({ dataDir: options.dataDir, ownerUserId: lookup.owner.user.id, ownerEmail: lookup.owner.user.email });
    options.log.info(`publisher: moved legacy global tokens (${result.moved.join(', ') || 'none'}; kept owner's own: ${result.ownerKept.join(', ') || 'none'}; unreadable: ${result.skipped.map(s => s.platform).join(', ') || 'none'}) to ${lookup.owner.user.email} [${lookup.owner.reason}]; manifest ${result.manifestPath ?? '-'}`);
    return result;
  } catch (error) {
    options.log.error(`publisher: token migration failed, legacy files kept (${error instanceof Error ? error.message : 'unknown error'})`);
    return undefined;
  }
}
