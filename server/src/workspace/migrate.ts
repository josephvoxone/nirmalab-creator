/**
 * W3 — the workspace migration (wave 4, audit §C for workspaces). Runs at boot, before any request:
 *
 *  1. every account gets ONE personal workspace (`Ruang kerja <nama depan>`) — idempotent, also for accounts that already
 *     have projects;
 *  2. every project of a living owner gets `workspaceId` = that owner's personal workspace. An orphan (owner removed, or never
 *     stamped) STAYS without a workspace: it is the admin's metadata, nothing more. Nothing is deleted, nothing else is written;
 *  3. the spending ledger: each entry gains `workspaceId` (the personal workspace of its person). `userId` is KEPT — the
 *     ElevenLabs gate is per ORANG and must keep counting the same history; the workspace numbers read `workspaceId`.
 *
 * Safety, same pattern as `tenancy/migrate.ts`: one run at a time per data dir, each story re-read under its own lock and only
 * written when it still has no workspace (compare-and-set), temp file + rename, the exact previous bytes copied under
 * `<dataDir>/tenancy/backup-<utc>/`, a manifest at `<dataDir>/tenancy/migrations/<utc>.json` with before/after sha256, and
 * `rollbackWorkspaceMigration` puts every file back byte-for-byte when it has not moved since. `TENANCY_DRY_RUN=1` writes nothing.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { WorkspaceStore } from './store.js';
import { writeFileAtomic } from '../tenancy/migrate.js';

export const WORKSPACE_MIGRATION_ID = 'migrasi-workspace-1';
const STORY_ID = /^story_[a-f0-9]{16}$/;
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const noLock = <T>(_id: string, fn: () => Promise<T>) => fn();

export type WorkspaceMigrationUser = { id: string; email: string };

export type WorkspaceMigrationOptions = {
  dataDir: string;
  users: WorkspaceMigrationUser[];
  store: WorkspaceStore;
  /** `TENANCY_DRY_RUN=1`: report only, writes nothing (not even the backup folder). */
  dryRun?: boolean;
  /** The story's mutation lock (`StoryService.lockStory`). */
  lock?: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  now?: () => Date;
};

export type WorkspaceMigrationReport = {
  dryRun: boolean;
  /** Personal workspaces: which account, which workspace, whether this run created it. */
  personalWorkspaces: Array<{ userId: string; id: string; name: string; created: boolean }>;
  projectsAssigned: number;
  /** Projects that already had a workspace (a second run finds only these). */
  projectsAlreadyAssigned: number;
  /** Projects whose owner is gone: they stay without a workspace (admin metadata only). */
  orphanProjects: number;
  unreadable: string[];
  /** Ledger entries that gained a workspaceId. */
  ledgerMapped: number;
  ledgerEntriesWithoutOwner: number;
  manifest?: string;
  backupDir?: string;
};

type FileEntry = { file: string; sha256Before: string; sha256After: string; backup: string };
type Manifest = {
  id: string; at: string; dataDir: string; status: 'pending' | 'applied';
  stories: FileEntry[]; ledger?: FileEntry; workspaces: Array<{ userId: string; workspaceId: string }>;
};

const runs = new Map<string, Promise<unknown>>();

/** One run at a time per data dir (a second caller waits and then finds nothing left to do). */
export function ensureWorkspaces(options: WorkspaceMigrationOptions): Promise<WorkspaceMigrationReport> {
  const previous = runs.get(options.dataDir) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => run(options));
  runs.set(options.dataDir, next);
  void next.finally(() => { if (runs.get(options.dataDir) === next) runs.delete(options.dataDir); }).catch(() => undefined);
  return next;
}

function displayNameOf(email: string): string {
  const local = email.split('@')[0] ?? '';
  const first = local.split(/[._-]+/).filter(Boolean)[0] ?? '';
  return first ? first[0]!.toUpperCase() + first.slice(1) : '';
}

async function run(options: WorkspaceMigrationOptions): Promise<WorkspaceMigrationReport> {
  const { dataDir, users, store, dryRun = false } = options;
  const lock = options.lock ?? noLock;
  const now = options.now ?? (() => new Date());
  const alive = new Map(users.map(user => [user.id, user]));
  const report: WorkspaceMigrationReport = {
    dryRun, personalWorkspaces: [], projectsAssigned: 0, projectsAlreadyAssigned: 0, orphanProjects: 0,
    unreadable: [], ledgerMapped: 0, ledgerEntriesWithoutOwner: 0
  };

  // ---- 1. personal workspaces (planned first: a dry run must not write)
  const personal = new Map<string, string>(); // userId -> workspaceId
  for (const user of users) {
    const existing = store.personalOf(user.id);
    if (existing) { personal.set(user.id, existing.id); continue; }
    if (dryRun) {
      personal.set(user.id, '');
      report.personalWorkspaces.push({ userId: user.id, id: '', name: `Ruang kerja ${displayNameOf(user.email)}`, created: true });
      continue;
    }
    const { workspace, created } = await store.ensurePersonal({ userId: user.id, name: `Ruang kerja ${displayNameOf(user.email)}` });
    personal.set(user.id, workspace.id);
    report.personalWorkspaces.push({ userId: user.id, id: workspace.id, name: workspace.name, created });
  }

  // ---- 2. projects of a living owner
  const root = join(dataDir, 'stories');
  const ids = existsSync(root) ? (await readdir(root)).filter(name => STORY_ID.test(name)).sort() : [];
  const planned: string[] = [];
  for (const id of ids) {
    let record: { createdBy?: unknown; workspaceId?: unknown };
    try {
      record = JSON.parse(await readFile(join(root, id, 'story.json'), 'utf8')) as typeof record;
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('not an object');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      report.unreadable.push(id);
      continue;
    }
    if (typeof record.workspaceId === 'string' && record.workspaceId) { report.projectsAlreadyAssigned += 1; continue; }
    const owner = typeof record.createdBy === 'string' ? record.createdBy : '';
    if (!owner || !alive.has(owner)) { report.orphanProjects += 1; continue; }
    planned.push(id);
  }
  report.projectsAssigned = planned.length;

  // ---- 3. the spending ledger
  const ledgerFile = join(dataDir, 'quota', 'ledger.json');
  let ledgerRaw: Buffer | undefined;
  let ledgerNext: Buffer | undefined;
  if (existsSync(ledgerFile)) {
    ledgerRaw = await readFile(ledgerFile);
    try {
      const doc = JSON.parse(ledgerRaw.toString('utf8')) as { entries?: Array<Record<string, unknown>> };
      const entries = Array.isArray(doc.entries) ? doc.entries : [];
      let changed = 0;
      for (const entry of entries) {
        if (typeof entry.workspaceId === 'string' && entry.workspaceId) continue;
        const userId = typeof entry.userId === 'string' ? entry.userId : '';
        const workspaceId = personal.get(userId);
        if (!userId || workspaceId === undefined) { report.ledgerEntriesWithoutOwner += 1; continue; }
        entry.workspaceId = workspaceId || `ws_${userId}`;
        changed += 1;
      }
      report.ledgerMapped = changed;
      if (changed) ledgerNext = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
    } catch { report.unreadable.push('quota/ledger.json'); }
  }

  if (dryRun) return report;
  if (!planned.length && !ledgerNext) return report;

  // ---- 4. backup + manifest + apply
  const stamp = `${now().toISOString().replace(/[-:.]/g, '')}-${randomBytes(2).toString('hex')}`;
  const tenancy = join(dataDir, 'tenancy');
  const backupDir = join(tenancy, `backup-${stamp}`);
  const manifestFile = join(tenancy, 'migrations', `${stamp}.json`);
  await mkdir(join(tenancy, 'migrations'), { recursive: true, mode: 0o700 });
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const manifest: Manifest = {
    id: WORKSPACE_MIGRATION_ID, at: now().toISOString(), dataDir, status: 'pending', stories: [], workspaces: []
  };
  // Written first: a crash half way leaves a manifest rollback understands (entries it has not applied are skipped).
  await writeFileAtomic(manifestFile, JSON.stringify(manifest, null, 1));

  for (const id of planned) {
    const file = join(root, id, 'story.json');
    await lock(id, async () => {
      let raw: Buffer;
      try { raw = await readFile(file); } catch { return; }
      let record: Record<string, unknown>;
      try { record = JSON.parse(raw.toString('utf8')) as Record<string, unknown>; } catch { report.unreadable.push(id); return; }
      if (typeof record.workspaceId === 'string' && record.workspaceId) { report.projectsAlreadyAssigned += 1; report.projectsAssigned -= 1; return; }
      const owner = typeof record.createdBy === 'string' ? record.createdBy : '';
      const workspaceId = personal.get(owner);
      if (!workspaceId) { report.orphanProjects += 1; report.projectsAssigned -= 1; return; }
      const backup = join(`backup-${stamp}`, 'stories', id, 'story.json');
      await mkdir(dirname(join(tenancy, backup)), { recursive: true, mode: 0o700 });
      await copyFile(file, join(tenancy, backup));
      const next = Buffer.from(JSON.stringify({ ...record, workspaceId, workspaceAssignedBy: WORKSPACE_MIGRATION_ID, workspaceAssignedAt: now().toISOString() }, null, 1));
      await writeFileAtomic(file, next);
      manifest.stories.push({ file: join('stories', id, 'story.json'), sha256Before: sha256(raw), sha256After: sha256(next), backup });
      manifest.workspaces.push({ userId: owner, workspaceId });
    });
  }

  if (ledgerNext && ledgerRaw) {
    const backup = join(`backup-${stamp}`, 'quota', 'ledger.json');
    await mkdir(dirname(join(tenancy, backup)), { recursive: true, mode: 0o700 });
    await copyFile(ledgerFile, join(tenancy, backup));
    await writeFileAtomic(ledgerFile, ledgerNext);
    manifest.ledger = { file: 'quota/ledger.json', sha256Before: sha256(ledgerRaw), sha256After: sha256(ledgerNext), backup };
  }

  if (!manifest.stories.length && !manifest.ledger) {
    await rm(manifestFile, { force: true });
    await rm(backupDir, { recursive: true, force: true });
    return report;
  }
  await writeFileAtomic(manifestFile, JSON.stringify({ ...manifest, status: 'applied' }, null, 1));
  report.manifest = manifestFile;
  report.backupDir = backupDir;
  return report;
}

export type WorkspaceRollbackResult = { restored: string[]; skipped: string[] };

/**
 * Undo the migration from its manifest: a file still byte-for-byte what the migration wrote goes back to the backed-up bytes;
 * one that changed since (the project moved on) is skipped, never clobbered. Backups are kept.
 */
export async function rollbackWorkspaceMigration(
  manifestPath: string,
  options: { dataDir?: string; lock?: WorkspaceMigrationOptions['lock']; dryRun?: boolean } = {}
): Promise<WorkspaceRollbackResult> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  if (manifest.id !== WORKSPACE_MIGRATION_ID) throw new Error(`Manifest ${manifest.id} bukan ${WORKSPACE_MIGRATION_ID}`);
  const dataDir = options.dataDir ?? manifest.dataDir ?? dirname(dirname(dirname(manifestPath)));
  const tenancy = join(dataDir, 'tenancy');
  const lock = options.lock ?? noLock;
  const result: WorkspaceRollbackResult = { restored: [], skipped: [] };
  const entries: FileEntry[] = [...manifest.stories, ...(manifest.ledger ? [manifest.ledger] : [])];
  for (const entry of entries) {
    const file = join(dataDir, entry.file);
    const id = entry.file.split('/')[1] ?? entry.file;
    await lock(id, async () => {
      let current: Buffer;
      try { current = await readFile(file); } catch { result.skipped.push(entry.file); return; }
      const hash = sha256(current);
      if (hash === entry.sha256Before) { result.skipped.push(entry.file); return; }
      if (hash !== entry.sha256After) { result.skipped.push(entry.file); return; }
      if (!options.dryRun) await writeFileAtomic(file, await readFile(join(tenancy, entry.backup)));
      result.restored.push(entry.file);
    });
  }
  return result;
}
