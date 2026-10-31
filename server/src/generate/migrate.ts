/**
 * Free-generate migration (tenancy T4, audit 06 §C.2): before per-user storage, Studio files lived in
 * `<data>/free-generate/{tts,images,clips}/` with no owner. Only an admin could make them, so they go to the main owner:
 * `<data>/free-generate/users/<owner>/<kind>/`. Same shape as `tenancy/migrate.ts`:
 *  - nothing is deleted: each entry is hard-linked (no extra space) into `tenancy/backup-<utc>-generate/` first, then renamed;
 *  - a manifest `tenancy/migrations/<utc>-generate.json` lists every move (+ sha256 for files) so `rollbackGenerateMigration` can undo it;
 *  - idempotent: a second run finds nothing in the old folders and writes neither manifest nor backup;
 *  - never overwrites: an entry whose target already exists stays where it is (the main owner can still read it from the old folder).
 */
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FREE_KINDS, legacyGenDir, userGenDir, type FreeKind } from './user-files.js';

export const GENERATE_MIGRATION_ID = 'migrasi-generate-1';
export type GenerateMigrationReport = { moved: string[]; conflicts: string[]; manifest?: string; dryRun: boolean };
type Entry = { key: string; kind: FreeKind; name: string; isDir: boolean; from: string; to: string; backup: string; sha256?: string };

const sha256 = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');

async function linkTree(from: string, to: string): Promise<void> {
  const info = await stat(from);
  if (!info.isDirectory()) {
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    try { await link(from, to); } catch { await copyFile(from, to); }
    return;
  }
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const child of await readdir(from)) await linkTree(join(from, child), join(to, child));
}

async function writeManifest(file: string, body: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(body, null, 1), { mode: 0o600 });
  await rename(tmp, file);
}

/** Runs one at a time per data dir (a second caller waits and then finds nothing left to do). */
const runs = new Map<string, Promise<unknown>>();

export function migrateGenerateFiles(options: { dataDir: string; ownerId: string | undefined; dryRun?: boolean; now?: () => Date }): Promise<GenerateMigrationReport> {
  const previous = runs.get(options.dataDir) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => run(options));
  runs.set(options.dataDir, next);
  void next.finally(() => { if (runs.get(options.dataDir) === next) runs.delete(options.dataDir); }).catch(() => undefined);
  return next;
}

async function run(options: { dataDir: string; ownerId: string | undefined; dryRun?: boolean; now?: () => Date }): Promise<GenerateMigrationReport> {
  const { dataDir, ownerId, dryRun = false } = options;
  const now = options.now ?? (() => new Date());
  const report: GenerateMigrationReport = { moved: [], conflicts: [], dryRun };
  if (ownerId !== undefined) userGenDir(dataDir, ownerId, 'tts'); // throws on an id that could leave the folder
  if (!ownerId) return report;

  const stamp = `${now().toISOString().replace(/[-:.]/g, '')}-${randomBytes(2).toString('hex')}`;
  const planned: Entry[] = [];
  for (const kind of FREE_KINDS) {
    const legacy = legacyGenDir(dataDir, kind);
    if (!existsSync(legacy)) continue;
    for (const name of (await readdir(legacy)).sort()) {
      if (name.startsWith('.')) continue;
      const from = join(legacy, name);
      const to = join(userGenDir(dataDir, ownerId, kind), name);
      const key = `${kind}/${name}`;
      if (existsSync(to)) { report.conflicts.push(key); continue; }
      const info = await stat(from);
      planned.push({ key, kind, name, isDir: info.isDirectory(), from, to, backup: join(`backup-${stamp}-generate`, 'free-generate', kind, name) });
    }
  }
  if (dryRun) { report.moved.push(...planned.map(e => e.key)); return report; }
  if (!planned.length) return report;

  const tenancy = join(dataDir, 'tenancy');
  const manifestFile = join(tenancy, 'migrations', `${stamp}-generate.json`);
  await mkdir(join(tenancy, 'migrations'), { recursive: true, mode: 0o700 });
  const header = { id: GENERATE_MIGRATION_ID, at: now().toISOString(), owner: ownerId, dataDir };
  // First, so a crash half way leaves a manifest rollback understands (entries not yet applied are skipped).
  await writeManifest(manifestFile, { ...header, status: 'pending', planned: planned.length, entries: [] as Entry[] });
  const entries: Entry[] = [];
  for (const entry of planned) {
    if (!existsSync(entry.from) || existsSync(entry.to)) continue;
    const sha = entry.isDir ? undefined : await sha256(entry.from);
    await linkTree(entry.from, join(tenancy, entry.backup));
    await mkdir(dirname(entry.to), { recursive: true, mode: 0o700 });
    await rename(entry.from, entry.to);
    entries.push({ ...entry, from: join('free-generate', entry.kind, entry.name), to: join('free-generate', 'users', ownerId, entry.kind, entry.name), ...(sha ? { sha256: sha } : {}) });
    report.moved.push(entry.key);
  }
  if (!entries.length) { await rm(manifestFile, { force: true }); await rm(join(tenancy, `backup-${stamp}-generate`), { recursive: true, force: true }); return report; }
  await writeManifest(manifestFile, { ...header, status: 'applied', entries });
  report.manifest = manifestFile;
  return report;
}

/** Undo a run from its manifest: every entry goes back to the old folder (from the new place, else from the backup). Backups are kept. */
export async function rollbackGenerateMigration(manifestPath: string, options: { dataDir?: string } = {}): Promise<{ restored: string[]; skipped: string[] }> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { id: string; dataDir?: string; entries: Entry[] };
  if (manifest.id !== GENERATE_MIGRATION_ID) throw new Error(`Manifest ${manifest.id} bukan ${GENERATE_MIGRATION_ID}`);
  const dataDir = options.dataDir ?? manifest.dataDir ?? dirname(dirname(dirname(manifestPath)));
  const result = { restored: [] as string[], skipped: [] as string[] };
  for (const entry of manifest.entries) {
    const from = join(dataDir, entry.from);
    const to = join(dataDir, entry.to);
    const backup = join(dataDir, 'tenancy', entry.backup);
    if (existsSync(from)) { result.skipped.push(entry.key); continue; }
    await mkdir(dirname(from), { recursive: true, mode: 0o700 });
    if (existsSync(to)) await rename(to, from);
    else if (existsSync(backup)) await copyTree(backup, from);
    else { result.skipped.push(entry.key); continue; }
    result.restored.push(entry.key);
  }
  return result;
}

async function copyTree(from: string, to: string): Promise<void> {
  const info = await stat(from);
  if (!info.isDirectory()) { await mkdir(dirname(to), { recursive: true }); await copyFile(from, to); return; }
  await mkdir(to, { recursive: true });
  for (const child of await readdir(from)) await copyTree(join(from, child), join(to, child));
}
