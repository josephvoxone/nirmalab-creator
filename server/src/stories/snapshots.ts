/**
 * Undo snapshots (spec §9.2): a snapshot is `storyboard.json` (raw bytes) plus the take state of
 * `story.json` — so undoing an edit that re-queued a paid clip brings that clip back to `done`
 * with the same jobId/promptHash instead of leaving it pending.
 *
 * Lifecycle: `take` before a mutation, `commit(undoId, revAfter)` after it; `restore` is allowed
 * only while the story is still at `revAfter` (nothing changed since). Files live under
 * `<root>/<storyId>/snapshots/<undoId>.json`, newest 50 per story.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StoryRecord } from './service.js';

export const MAX_SNAPSHOTS = 50;

/** `u_<story hex>_<ms>_<seq>`: carries its story, sorts by age, safe in a URL and a file name. */
const UNDO_ID = /^u_([a-f0-9]{16})_(\d{13})_(\d{4})$/;
const STORY_ID = /^story_[a-f0-9]{16}$/;

/** The record fields a snapshot brings back; everything else (id, events, video file, owner) stays current. */
export const TAKE_FIELDS = ['title', 'status', 'mode', 'cast', 'shots', 'error', 'videoStale', 'run', 'gate'] as const;
type TakeFields = Partial<Pick<StoryRecord, (typeof TAKE_FIELDS)[number]>>;

export type Snapshot = {
  undoId: string;
  storyId: string;
  label: string;
  atMs: number;
  /** Revision when the snapshot was taken (the state it restores). */
  rev: number;
  /** Revision right after the change it undoes; absent until committed. */
  revAfter?: number;
  /** storyboard.json byte for byte. */
  storyboard: string;
  record: TakeFields;
};

export type RestoreResult = 'ok' | 'stale' | 'missing';

export type SnapshotHooks = {
  /** The story's mutation lock (StoryService.withLock): restores never interleave with edits. */
  lock?: <T>(storyId: string, fn: () => Promise<T>) => Promise<T>;
  /** Runs under the lock before any file is written: may throw (busy story) and re-links media of restored takes. */
  beforeRestore?: (current: StoryRecord, restored: StoryRecord) => Promise<void>;
};

let seq = 0;

export class SnapshotStore {
  /** `root` = `<dataDir>/stories`. */
  constructor(private readonly root: string, private readonly hooks: SnapshotHooks = {}) {}

  private storyDir(storyId: string): string {
    if (!STORY_ID.test(storyId)) throw new Error('invalid story id');
    return join(this.root, storyId);
  }

  private dir(storyId: string): string {
    return join(this.storyDir(storyId), 'snapshots');
  }

  private where(undoId: string): { storyId: string; path: string } | undefined {
    const m = UNDO_ID.exec(typeof undoId === 'string' ? undoId : '');
    if (!m) return undefined;
    const storyId = `story_${m[1]}`;
    return { storyId, path: join(this.dir(storyId), `${undoId}.json`) };
  }

  private locked<T>(storyId: string, fn: () => Promise<T>): Promise<T> {
    return this.hooks.lock ? this.hooks.lock(storyId, fn) : fn();
  }

  private async atomicWrite(path: string, text: string): Promise<void> {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, path);
  }

  private async read(undoId: string): Promise<Snapshot | undefined> {
    const where = this.where(undoId);
    if (!where) return undefined;
    try {
      return JSON.parse(await readFile(where.path, 'utf8')) as Snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async readRecord(storyId: string): Promise<StoryRecord> {
    const record = JSON.parse(await readFile(join(this.storyDir(storyId), 'story.json'), 'utf8')) as StoryRecord;
    return { ...record, rev: typeof record.rev === 'number' ? record.rev : 1 };
  }

  /** Snapshot the story as it is now. `rev` is the revision to pass to the change (`updateStoryboard(..., { rev })`). */
  async take(storyId: string, label: string): Promise<{ undoId: string; rev: number; revAfter?: number }> {
    return this.locked(storyId, async () => {
      const storyboard = await readFile(join(this.storyDir(storyId), 'storyboard.json'), 'utf8');
      const record = await this.readRecord(storyId);
      const atMs = Date.now();
      seq = (seq + 1) % 10_000;
      const undoId = `u_${storyId.slice('story_'.length)}_${String(atMs).padStart(13, '0')}_${String(seq).padStart(4, '0')}`;
      const takes = Object.fromEntries(TAKE_FIELDS.filter(k => record[k] !== undefined).map(k => [k, record[k]])) as TakeFields;
      const snapshot: Snapshot = { undoId, storyId, label: String(label ?? '').slice(0, 200), atMs, rev: record.rev, storyboard, record: takes };
      await mkdir(this.dir(storyId), { recursive: true, mode: 0o700 });
      await this.atomicWrite(join(this.dir(storyId), `${undoId}.json`), JSON.stringify(snapshot));
      await this.prune(storyId);
      return { undoId, rev: snapshot.rev };
    });
  }

  /** Record the revision right after the change; only committed snapshots can be restored. */
  async commit(undoId: string, revAfter: number): Promise<void> {
    const where = this.where(undoId);
    if (!where) return;
    await this.locked(where.storyId, async () => {
      const snapshot = await this.read(undoId);
      if (snapshot) await this.atomicWrite(where.path, JSON.stringify({ ...snapshot, revAfter }));
    });
  }

  /** Drop a snapshot whose change failed. */
  async discard(undoId: string): Promise<void> {
    const where = this.where(undoId);
    if (where) await rm(where.path, { force: true });
  }

  async get(undoId: string): Promise<Snapshot | undefined> {
    return this.read(undoId);
  }

  /** Newest first. */
  async list(storyId: string): Promise<Snapshot[]> {
    const names = await this.names(storyId);
    const all = await Promise.all(names.reverse().map(n => this.read(n.slice(0, -'.json'.length))));
    return all.filter((s): s is Snapshot => !!s);
  }

  /**
   * Put the board and its takes back. `currentRev` is the revision the caller last saw; both it
   * and the revision on disk must still equal the snapshot's `revAfter`. The restored record gets
   * rev = current + 1 (a restore is a change: open tabs go stale); every take field is the snapshot's.
   */
  async restore(storyId: string, undoId: string, currentRev: number): Promise<RestoreResult> {
    const where = this.where(undoId);
    if (!where || where.storyId !== storyId) return 'missing';
    return this.locked(storyId, async () => {
      const snapshot = await this.read(undoId);
      if (!snapshot || snapshot.storyId !== storyId || typeof snapshot.revAfter !== 'number') return 'missing';
      const current = await this.readRecord(storyId);
      if (currentRev !== snapshot.revAfter || current.rev !== snapshot.revAfter) return 'stale';
      const restored = { ...current } as StoryRecord & Record<string, unknown>;
      for (const key of TAKE_FIELDS) delete restored[key];
      Object.assign(restored, snapshot.record);
      restored.rev = current.rev + 1;
      // A cut assembled after the snapshot plays the state being undone.
      if (current.video && current.video.finishedAtMs > snapshot.atMs) restored.videoStale = true;
      const now = Date.now();
      restored.updatedAtMs = now;
      restored.events = [...(current.events ?? []), { atMs: now, message: `Dibatalkan: ${snapshot.label}` }].slice(-60);
      await this.hooks.beforeRestore?.(current, restored);
      const dir = this.storyDir(storyId);
      await this.atomicWrite(join(dir, 'storyboard.json'), snapshot.storyboard);
      await this.atomicWrite(join(dir, 'story.json'), JSON.stringify(restored, null, 1));
      return 'ok';
    });
  }

  private async names(storyId: string): Promise<string[]> {
    try {
      return (await readdir(this.dir(storyId))).filter(n => n.endsWith('.json') && UNDO_ID.test(n.slice(0, -5))).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async prune(storyId: string): Promise<void> {
    const names = await this.names(storyId);
    for (const name of names.slice(0, Math.max(0, names.length - MAX_SNAPSHOTS))) await rm(join(this.dir(storyId), name), { force: true });
  }
}
