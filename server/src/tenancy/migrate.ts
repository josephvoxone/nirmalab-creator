/**
 * Tenancy migration (audit 06 §C): every project gets an owner. `ensureOwners` runs at boot (and `scripts/tenancy-inventory.mjs`
 * shows what it would do beforehand).
 *
 * What it does — and nothing else:
 *  - a project WITHOUT `createdBy` gets the primary owner (`TENANCY_DEFAULT_OWNER_EMAIL`, else the oldest admin whose email is not
 *    `qa-…`) plus `ownerAssignedBy` / `ownerAssignedAt`. Revision, timestamps and every other byte of the record stay as they were.
 *  - a project whose owner is a live account: untouched. A project whose owner no longer exists (an orphan): untouched, only listed.
 *  - nothing is ever deleted.
 *
 * Safety: the whole run is serialised, each story is re-read under its own lock and only written when it STILL has no owner
 * (compare-and-set), writes go to a temp file then rename, the exact previous bytes are copied to `tenancy/backup-<utc>/` first and a
 * manifest `tenancy/migrations/<utc>.json` records before/after + sha256 so `rollbackMigration` / `scripts/tenancy-rollback.mjs`
 * can undo it. A second run finds nothing to do and writes nothing.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { normalizeEmail } from '../auth/password.js';

export type OwnerUser = { id: string; email: string; isAdmin: boolean; createdAt: string };
export type EnsureOwnersOptions = {
  dataDir: string;
  users: OwnerUser[];
  /** `TENANCY_DEFAULT_OWNER_EMAIL`. */
  defaultOwnerEmail?: string;
  /** Plan only: nothing is written, not even `tenancy/`. */
  dryRun?: boolean;
  /** `TENANCY_ENFORCE=1`: throw (the boot stops) when a project is left without an owner or cannot be read. */
  enforce?: boolean;
  /** The story's mutation lock (`StoryService.lockStory`), so the write never interleaves with the service's own writes. */
  lock?: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  now?: () => Date;
};
export type EnsureOwnersReport = {
  primaryOwner?: { id: string; email: string; via: 'env' | 'oldest-admin' };
  scanned: number;
  assigned: Array<{ id: string; owner: string }>;
  alreadyOwned: number;
  /** Owner no longer exists. Title is included here (and only here): it is the one thing an admin may see of a project that has no living owner. */
  orphans: Array<{ id: string; title: string; ownerId: string }>;
  /** Owned by a leftover QA account (ids only). */
  qaOwned: Array<{ id: string; ownerId: string }>;
  unassigned: string[];
  unreadable: string[];
  manifest?: string;
  dryRun: boolean;
};
export type RollbackResult = { restored: string[]; revertedFields: string[]; skipped: string[] };

export const MIGRATION_ID = 'migrasi-tenancy-1';
const STORY_ID = /^story_[a-f0-9]{16}$/;
const QA_EMAIL = /^qa-/i;

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const noLock = <T>(_id: string, fn: () => Promise<T>) => fn();

/** Temp file in the same directory, then rename: a crash leaves the old file or the new one, never half of one. */
export async function writeFileAtomic(file: string, data: Buffer | string, mode = 0o600): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data, { mode });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function resolvePrimaryOwner(users: OwnerUser[], defaultOwnerEmail?: string): EnsureOwnersReport['primaryOwner'] {
  const wanted = defaultOwnerEmail?.trim();
  if (wanted) {
    const email = normalizeEmail(wanted);
    const user = users.find(u => normalizeEmail(u.email) === email);
    if (!user) throw new Error(`TENANCY_DEFAULT_OWNER_EMAIL (${wanted}) tidak cocok dengan akun mana pun; proyek tanpa pemilik tidak ditetapkan`);
    return { id: user.id, email: user.email, via: 'env' };
  }
  const admin = users
    .map((user, index) => ({ user, index }))
    .filter(({ user }) => user.isAdmin && !QA_EMAIL.test(user.email))
    .sort((a, b) => a.user.createdAt.localeCompare(b.user.createdAt) || a.index - b.index)[0]?.user;
  return admin ? { id: admin.id, email: admin.email, via: 'oldest-admin' } : undefined;
}

/** One run at a time per data dir (a second caller waits and then finds nothing left to do). */
const runs = new Map<string, Promise<unknown>>();

export function ensureOwners(options: EnsureOwnersOptions): Promise<EnsureOwnersReport> {
  const previous = runs.get(options.dataDir) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => run(options));
  runs.set(options.dataDir, next);
  void next.finally(() => { if (runs.get(options.dataDir) === next) runs.delete(options.dataDir); }).catch(() => undefined);
  return next;
}

async function run(options: EnsureOwnersOptions): Promise<EnsureOwnersReport> {
  const { dataDir, users, dryRun = false } = options;
  const lock = options.lock ?? noLock;
  const now = options.now ?? (() => new Date());
  const primary = resolvePrimaryOwner(users, options.defaultOwnerEmail);
  const alive = new Map(users.map(u => [u.id, u]));
  const report: EnsureOwnersReport = { ...(primary ? { primaryOwner: primary } : {}), scanned: 0, assigned: [], alreadyOwned: 0, orphans: [], qaOwned: [], unassigned: [], unreadable: [], dryRun };

  const root = join(dataDir, 'stories');
  const ids = existsSync(root) ? (await readdir(root)).filter(name => STORY_ID.test(name)).sort() : [];
  const planned: string[] = [];
  for (const id of ids) {
    let record: { title?: unknown; createdBy?: unknown } | undefined;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(root, id, 'story.json'), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      record = parsed as typeof record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      report.unreadable.push(id);
      continue;
    }
    report.scanned += 1;
    const owner = typeof record!.createdBy === 'string' ? record!.createdBy : '';
    if (!owner) { planned.push(id); continue; }
    const user = alive.get(owner);
    if (!user) report.orphans.push({ id, title: typeof record!.title === 'string' ? record!.title : '', ownerId: owner });
    else {
      report.alreadyOwned += 1;
      if (QA_EMAIL.test(user.email)) report.qaOwned.push({ id, ownerId: owner });
    }
  }

  if (!primary) report.unassigned.push(...planned);
  else if (dryRun) report.assigned.push(...planned.map(id => ({ id, owner: primary.id })));
  else if (planned.length) await apply(planned, primary.id, report, { dataDir, root, lock, now });

  if (options.enforce && !dryRun) {
    const problems: string[] = [];
    if (report.unassigned.length) problems.push(`${report.unassigned.length} proyek tanpa pemilik dan tidak bisa ditetapkan (${report.unassigned.slice(0, 5).join(', ')}${report.unassigned.length > 5 ? ', …' : ''}); setel TENANCY_DEFAULT_OWNER_EMAIL`);
    if (report.unreadable.length) problems.push(`${report.unreadable.length} story.json tidak terbaca (${report.unreadable.slice(0, 5).join(', ')})`);
    if (problems.length) throw new Error(`TENANCY_ENFORCE: ${problems.join('; ')}`);
  }
  return report;
}

type Applied = { id: string; file: string; field: 'createdBy'; before: null; after: string; sha256Before: string; sha256After: string; backup: string };

async function apply(
  ids: string[], owner: string, report: EnsureOwnersReport,
  ctx: { dataDir: string; root: string; lock: NonNullable<EnsureOwnersOptions['lock']>; now: () => Date }
): Promise<void> {
  const stamp = `${ctx.now().toISOString().replace(/[-:.]/g, '')}-${randomBytes(2).toString('hex')}`;
  const tenancy = join(ctx.dataDir, 'tenancy');
  const backupDir = join(tenancy, `backup-${stamp}`);
  const manifestFile = join(tenancy, 'migrations', `${stamp}.json`);
  await mkdir(join(tenancy, 'migrations'), { recursive: true, mode: 0o700 });
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const header = { id: MIGRATION_ID, at: ctx.now().toISOString(), owner, dataDir: ctx.dataDir };
  // Written first: a crash half way leaves a manifest that rollback understands (entries it has not applied are simply skipped).
  await writeFileAtomic(manifestFile, JSON.stringify({ ...header, status: 'pending', planned: ids.length, entries: [] as Applied[] }, null, 1));
  const entries: Applied[] = [];
  for (const id of ids) {
    const file = join(ctx.root, id, 'story.json');
    await ctx.lock(id, async () => {
      let raw: Buffer;
      try { raw = await readFile(file); } catch { report.unassigned.push(id); return; }
      let record: Record<string, unknown>;
      try { record = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; } catch { report.unassigned.push(id); return; }
      if (typeof record.createdBy === 'string' && record.createdBy) return; // someone gave it an owner meanwhile
      const backup = join(`backup-${stamp}`, 'stories', id, 'story.json');
      await mkdir(dirname(join(tenancy, backup)), { recursive: true, mode: 0o700 });
      await copyFile(file, join(tenancy, backup));
      const next = Buffer.from(JSON.stringify({ ...record, createdBy: owner, ownerAssignedBy: MIGRATION_ID, ownerAssignedAt: ctx.now().toISOString() }, null, 1));
      await writeFileAtomic(file, next);
      entries.push({ id, file: join('stories', id, 'story.json'), field: 'createdBy', before: null, after: owner, sha256Before: sha256(raw), sha256After: sha256(next), backup });
      report.assigned.push({ id, owner });
    });
  }
  if (!entries.length) {
    await rm(manifestFile, { force: true });
    await rm(backupDir, { recursive: true, force: true });
    return;
  }
  await writeFileAtomic(manifestFile, JSON.stringify({ ...header, status: 'applied', entries }, null, 1));
  report.manifest = manifestFile;
}

/**
 * Undo a migration from its manifest. A story.json still byte-for-byte what the migration wrote goes back to the backed-up bytes;
 * one that changed since (the project moved on) only loses the owner fields the migration added. Backups are kept.
 */
export async function rollbackMigration(manifestPath: string, options: { dataDir?: string; lock?: EnsureOwnersOptions['lock']; dryRun?: boolean } = {}): Promise<RollbackResult> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { id: string; dataDir?: string; entries: Applied[] };
  if (manifest.id !== MIGRATION_ID) throw new Error(`Manifest ${manifest.id} bukan ${MIGRATION_ID}`);
  const dataDir = options.dataDir ?? manifest.dataDir ?? dirname(dirname(dirname(manifestPath)));
  const tenancy = join(dataDir, 'tenancy');
  const lock = options.lock ?? noLock;
  const result: RollbackResult = { restored: [], revertedFields: [], skipped: [] };
  for (const entry of manifest.entries) {
    const file = join(dataDir, entry.file);
    await lock(entry.id, async () => {
      let current: Buffer;
      try { current = await readFile(file); } catch { result.skipped.push(entry.id); return; }
      const now = sha256(current);
      if (now === entry.sha256Before) { result.skipped.push(entry.id); return; }
      if (now === entry.sha256After) {
        if (!options.dryRun) await writeFileAtomic(file, await readFile(join(tenancy, entry.backup)));
        result.restored.push(entry.id);
        return;
      }
      const record = JSON.parse(current.toString('utf8')) as Record<string, unknown>;
      if (record.createdBy !== entry.after || record.ownerAssignedBy !== MIGRATION_ID) { result.skipped.push(entry.id); return; }
      delete record.createdBy;
      delete record.ownerAssignedBy;
      delete record.ownerAssignedAt;
      if (!options.dryRun) await writeFileAtomic(file, JSON.stringify(record, null, 1));
      result.revertedFields.push(entry.id);
    });
  }
  return result;
}
