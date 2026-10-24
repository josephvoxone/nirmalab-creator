/**
 * Disk usage of the data volume and the daily janitor.
 *
 * Areas: stories/ (story dirs), flow/clips/ (job results), cache/ (thumbnails), covers/, other.
 * A hard-linked file is counted once, in clips (its canonical home).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { link, lstat, readFile, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth/routes.js';
import type { UserAuthStore } from '../auth/store.js';
import { isNoLinkError } from './link.js';

export type StorageAreas = { stories: number; clips: number; cache: number; covers: number; other: number };
export type StorageReport = { usedBytes: number; byArea: StorageAreas; diskFreeBytes: number | null };
export type CleanupResult = { freedBytes: number; linked: number; removed: number };
export type CleanupDeps = {
  /** Every Flow job the store knows (id + status). */
  jobs: () => Promise<Array<{ id: string; status: string }>>;
  now?: () => number;
};

const DAY = 86_400_000;
const CACHE_MAX_AGE = 30 * DAY;
/** A clip younger than this may belong to a job being completed right now. */
const CLIP_GRACE = 60 * 60_000;
const JOB_FILE = /^(job_[a-f0-9]{16})\./;
const JOB_REF = /job_[a-f0-9]{16}/g;
const MEDIA_FILE = /\.(mp4|png|jpe?g|webp|img)$/i;

type Entry = { path: string; st: Stats };
const inode = (st: Stats) => `${st.dev}:${st.ino}`;

async function list(dir: string): Promise<Entry[]> {
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const out: Entry[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      const st = await lstat(path);
      if (st.isFile()) out.push({ path, st });
    } catch { /* vanished */ }
  }
  return out;
}

async function* walk(dir: string, skip?: string): AsyncGenerator<Entry> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (path === skip) continue;
    if (entry.isDirectory()) yield* walk(path, skip);
    else if (entry.isFile()) {
      try { yield { path, st: await lstat(path) }; } catch { /* vanished */ }
    }
  }
}

function areaOf(dataDir: string, file: string): keyof StorageAreas {
  const [top, second] = relative(dataDir, file).split(sep);
  if (top === 'flow' && second === 'clips') return 'clips';
  if (top === 'stories' || top === 'cache' || top === 'covers') return top;
  return 'other';
}

export async function measureStorage(dataDir: string): Promise<StorageReport> {
  const byArea: StorageAreas = { stories: 0, clips: 0, cache: 0, covers: 0, other: 0 };
  const seen = new Set<string>();
  const clips = join(dataDir, 'flow', 'clips');
  // Clips first: a story file linked to a clip is the clip's bytes.
  for (const source of [walk(clips), walk(dataDir, clips)]) {
    for await (const { path, st } of source) {
      if (seen.has(inode(st))) continue;
      seen.add(inode(st));
      byArea[areaOf(dataDir, path)] += st.size;
    }
  }
  let diskFreeBytes: number | null = null;
  try {
    const fs = await statfs(dataDir);
    diskFreeBytes = fs.bavail * fs.bsize;
  } catch { /* no volume */ }
  const usedBytes = Object.values(byArea).reduce((a, b) => a + b, 0);
  return { usedBytes, byArea, diskFreeBytes };
}

async function sha1(file: string): Promise<string> {
  const hash = createHash('sha1');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const unchanged = (a: Stats, b: Stats) => a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs;

/**
 * Remove final.mp4.prev (not while assembling), image cache files older than 30 days and
 * clips of jobs that are gone or failed (never one a story references or links), then turn
 * byte-identical story copies of clips into hard links.
 */
export async function cleanupStorage(dataDir: string, deps: CleanupDeps): Promise<CleanupResult> {
  const now = deps.now?.() ?? Date.now();
  // Read jobs before touching anything: a failed read must not half-run the janitor.
  const jobs = new Map((await deps.jobs()).map(j => [j.id, j.status]));
  const result: CleanupResult = { freedBytes: 0, linked: 0, removed: 0 };
  const remove = async ({ path, st }: Entry) => {
    await rm(path, { force: true });
    result.removed++;
    if (st.nlink <= 1) result.freedBytes += st.size;
  };

  // Stories: references (job ids in story/storyboard json, linked inodes) and stale backups.
  const refs = new Set<string>();
  const storyInodes = new Set<string>();
  const storyFiles: Entry[] = [];
  const storiesDir = join(dataDir, 'stories');
  let storyDirs: string[] = [];
  try { storyDirs = await readdir(storiesDir); } catch { /* none */ }
  for (const name of storyDirs) {
    const dir = join(storiesDir, name);
    let status: string | undefined;
    for (const json of ['story.json', 'storyboard.json']) {
      try {
        const text = await readFile(join(dir, json), 'utf8');
        for (const id of text.match(JOB_REF) ?? []) refs.add(id);
        if (json === 'story.json') status = (JSON.parse(text) as { status?: string }).status;
      } catch { /* missing/corrupt: keep everything of this story */ }
    }
    for (const entry of await list(dir)) {
      const name = entry.path.slice(dir.length + 1);
      // The backup is the restore point of a running assembly; unknown status = keep.
      if (name === 'final.mp4.prev' && status !== undefined && status !== 'assembling') { await remove(entry); continue; }
      storyInodes.add(inode(entry.st));
      if (MEDIA_FILE.test(name)) storyFiles.push(entry);
    }
  }

  for (const entry of await list(join(dataDir, 'cache', 'img'))) {
    if (entry.st.mtimeMs < now - CACHE_MAX_AGE) await remove(entry);
  }

  // Trend cache: entries live 30 minutes in use, so anything this old is dead weight.
  for (const entry of await list(join(dataDir, 'trends', 'cache'))) {
    if (entry.st.mtimeMs < now - CACHE_MAX_AGE) await remove(entry);
  }

  // Orphan clips. An empty job list means "could not tell" (fresh or unreadable flow.json): delete nothing.
  const clips: Entry[] = [];
  for (const entry of await list(join(dataDir, 'flow', 'clips'))) {
    const id = entry.path.slice(entry.path.lastIndexOf(sep) + 1).match(JOB_FILE)?.[1];
    const status = id ? jobs.get(id) : undefined;
    const orphan = !!id && jobs.size > 0 && (status === undefined || status === 'failed')
      && !refs.has(id) && !storyInodes.has(inode(entry.st)) && entry.st.mtimeMs < now - CLIP_GRACE;
    if (orphan) await remove(entry);
    else clips.push(entry);
  }

  // Byte-identical story copies → hard links to the clip.
  const bySize = new Map<number, Entry[]>();
  for (const clip of clips) bySize.set(clip.st.size, [...(bySize.get(clip.st.size) ?? []), clip]);
  const hashes = new Map<string, string>();
  const hashOf = async (e: Entry) => hashes.get(e.path) ?? hashes.set(e.path, await sha1(e.path)).get(e.path)!;
  for (const file of storyFiles) {
    const candidates = (bySize.get(file.st.size) ?? []).filter(c => inode(c.st) !== inode(file.st));
    if (!candidates.length || file.st.size === 0) continue;
    const own = await hashOf(file);
    for (const clip of candidates) {
      if ((await hashOf(clip)) !== own) continue;
      const tmp = `${file.path}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        await link(clip.path, tmp);
        // Collect may have replaced the story file meanwhile: only swap the bytes we hashed.
        if (!unchanged(await stat(file.path), file.st)) break;
        await rename(tmp, file.path);
        result.linked++;
        if (file.st.nlink <= 1) result.freedBytes += file.st.size;
      } catch (error) {
        if (!isNoLinkError(error)) throw error;
      } finally {
        await rm(tmp, { force: true });
      }
      break;
    }
  }
  return result;
}

export async function registerStorageRoutes(
  server: FastifyInstance,
  options: { userAuthStore: UserAuthStore; dataDir: string; cleanup: () => Promise<CleanupResult> }
): Promise<void> {
  server.get('/api/storage', async (request, reply) => {
    if (!requireAdmin(options.userAuthStore, request, reply)) return undefined;
    return measureStorage(options.dataDir);
  });

  server.post('/api/storage/cleanup', async (request, reply) => {
    if (!requireAdmin(options.userAuthStore, request, reply)) return undefined;
    return options.cleanup();
  });
}

/** One janitor run at a time per process (the daily timer and the admin button share it). */
export function serialCleanup(dataDir: string, deps: CleanupDeps): () => Promise<CleanupResult> {
  let running: Promise<CleanupResult> | undefined;
  return () => {
    running ??= cleanupStorage(dataDir, deps).finally(() => { running = undefined; });
    return running;
  };
}
