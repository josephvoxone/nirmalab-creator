/**
 * Story pipeline: storyboard → one Flow job per shot (via the existing bridge queue)
 * → QC each clip → automatic re-takes → server-side assembly → final video.
 *
 * Robustness rules:
 * - All state lives on disk (`<dataDir>/stories/<id>/story.json`); any instance can resume.
 * - Every step is idempotent: render/reconcile can be called repeatedly or concurrently.
 * - A bad clip (too short, no voice) or a failed Flow job is re-rendered up to MAX_TAKES.
 * - Assembly runs once per story at a time; a failure is recorded and retryable without re-rendering.
 */
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FlowStore } from '../flow/store.js';
import { CREDITS_PER_SHOT, buildShotPrompt, newShots, validateStoryboard, type Storyboard } from './storyboard.js';

export const MAX_TAKES = 3;
export const MIN_CLIP_SEC = 3;
const STORY_ID = /^story_[a-f0-9]{16}$/;

export type ClipProbe = { durationSec: number; hasAudio: boolean };

export type StoryStatus = 'draft' | 'rendering' | 'assembling' | 'done' | 'failed';
export type ShotStatus = 'pending' | 'queued' | 'done' | 'failed';

export type ShotState = {
  id: string;
  status: ShotStatus;
  /** Failed takes so far (QC rejects + Flow failures). */
  attempts: number;
  jobId?: string;
  promptHash?: string;
  durationSec?: number;
  lastError?: string;
  error?: string;
};

export type StoryRecord = {
  id: string;
  title: string;
  status: StoryStatus;
  createdAtMs: number;
  updatedAtMs: number;
  shots: ShotState[];
  error?: string;
  video?: { bytes: number; finishedAtMs: number };
  events: Array<{ atMs: number; message: string }>;
};

export type StoryDeps = {
  dataDir: string;
  flow: FlowStore;
  probe: (file: string) => Promise<ClipProbe>;
  /** Builds `<dir>/final.mp4` from `<dir>/assemble.json` and the shot clips in `<dir>`. */
  assemble: (dir: string) => Promise<void>;
};

export class StoryError extends Error {
  constructor(public code: 'INVALID' | 'NOT_FOUND' | 'BUSY' | 'BUDGET', message: string) {
    super(message);
  }
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

export class StoryService {
  private locks = new Map<string, Promise<unknown>>();
  private readonly root: string;

  constructor(private deps: StoryDeps) {
    this.root = join(deps.dataDir, 'stories');
  }

  storyDir(id: string): string {
    if (!STORY_ID.test(id)) throw new StoryError('NOT_FOUND', 'Story not found');
    return join(this.root, id);
  }

  videoPath(id: string): string {
    return join(this.storyDir(id), 'final.mp4');
  }

  shotPath(id: string, shotId: string): string {
    return join(this.storyDir(id), `${shotId}.mp4`);
  }

  /** Serialise all mutations of one story (in-process); disk state makes it restart-safe. */
  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(id, next);
    void next.finally(() => { if (this.locks.get(id) === next) this.locks.delete(id); }).catch(() => undefined);
    return next;
  }

  private async readRecord(id: string): Promise<StoryRecord | undefined> {
    try {
      return JSON.parse(await readFile(join(this.storyDir(id), 'story.json'), 'utf8')) as StoryRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 1), { mode: 0o600 });
    await rename(tmp, file);
  }

  private async save(record: StoryRecord, message?: string): Promise<void> {
    record.updatedAtMs = Date.now();
    if (message) record.events = [...record.events, { atMs: record.updatedAtMs, message }].slice(-60);
    await this.writeJson(join(this.storyDir(record.id), 'story.json'), record);
  }

  async readStoryboard(id: string): Promise<Storyboard> {
    return JSON.parse(await readFile(join(this.storyDir(id), 'storyboard.json'), 'utf8')) as Storyboard;
  }

  private assertValid(board: Storyboard): void {
    const errors = validateStoryboard(board);
    if (errors.length) throw new StoryError('INVALID', errors.join('; '));
  }

  async create(board: Storyboard): Promise<StoryRecord> {
    this.assertValid(board);
    const id = `story_${randomBytes(8).toString('hex')}`;
    await mkdir(this.storyDir(id), { recursive: true, mode: 0o700 });
    const now = Date.now();
    const record: StoryRecord = {
      id,
      title: board.title.trim(),
      status: 'draft',
      createdAtMs: now,
      updatedAtMs: now,
      shots: board.shots.map(s => ({ id: s.id, status: 'pending', attempts: 0 })),
      events: []
    };
    await this.writeJson(join(this.storyDir(id), 'storyboard.json'), { ...board, slug: id });
    await this.save(record, 'Storyboard dibuat');
    return record;
  }

  async get(id: string): Promise<StoryRecord | undefined> {
    if (!STORY_ID.test(id)) return undefined;
    return this.readRecord(id);
  }

  async list(): Promise<StoryRecord[]> {
    if (!existsSync(this.root)) return [];
    const ids = (await readdir(this.root)).filter(n => STORY_ID.test(n));
    const records = await Promise.all(ids.map(id => this.readRecord(id)));
    return records.filter((r): r is StoryRecord => !!r).sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  /** Stories with work in progress (the reconciler polls these). */
  async activeIds(): Promise<string[]> {
    return (await this.list()).filter(r => r.status === 'rendering' || r.status === 'assembling').map(r => r.id);
  }

  async updateStoryboard(id: string, board: Storyboard): Promise<StoryRecord> {
    this.assertValid(board);
    return this.withLock(id, async () => {
      const record = await this.require(id);
      if (record.status === 'rendering' || record.status === 'assembling') {
        throw new StoryError('BUSY', 'Story sedang dirender; tunggu selesai atau gagal dulu');
      }
      const previous = new Map(record.shots.map(s => [s.id, s]));
      record.title = board.title.trim();
      record.shots = board.shots.map(shot => {
        const old = previous.get(shot.id);
        const promptHash = shot.reuse ? hash(JSON.stringify(shot.reuse)) : hash(buildShotPrompt(board, shot));
        if (old && old.status === 'done' && old.promptHash === promptHash) return old;
        return { id: shot.id, status: 'pending', attempts: 0 };
      });
      record.error = undefined;
      record.status = 'draft';
      await this.writeJson(join(this.storyDir(id), 'storyboard.json'), { ...board, slug: id });
      await this.save(record, 'Storyboard diubah');
      return record;
    });
  }

  private async require(id: string): Promise<StoryRecord> {
    const record = await this.get(id);
    if (!record) throw new StoryError('NOT_FOUND', 'Story not found');
    return record;
  }

  private async knownCredits(): Promise<number | undefined> {
    const accounts = (await this.deps.flow.listAccounts()).filter(a => typeof a.credits === 'number');
    return accounts.length ? accounts.reduce((sum, a) => sum + (a.credits ?? 0), 0) : undefined;
  }

  private async queueShot(record: StoryRecord, board: Storyboard, shotId: string): Promise<void> {
    const shot = board.shots.find(s => s.id === shotId)!;
    const state = record.shots.find(s => s.id === shotId)!;
    const prompt = buildShotPrompt(board, shot);
    const job = await this.deps.flow.createJob({
      prompt,
      technique: `story:${record.id}/${shot.id}`,
      aspect: board.aspect ?? '9:16',
      durationSec: 6
    });
    state.jobId = job.id;
    state.promptHash = hash(prompt);
    state.status = 'queued';
    state.error = undefined;
  }

  async render(id: string, options: { force?: boolean } = {}): Promise<StoryRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      if (record.status === 'assembling') throw new StoryError('BUSY', 'Story sedang dirakit');
      const board = await this.readStoryboard(id);
      const reuseIds = new Set(board.shots.filter(s => s.reuse).map(s => s.id));
      const todo = record.shots.filter(s => !reuseIds.has(s.id) && (s.status === 'pending' || s.status === 'failed'));
      const credits = await this.knownCredits();
      const needed = todo.length * CREDITS_PER_SHOT;
      if (!options.force && credits !== undefined && needed > credits) {
        throw new StoryError('BUDGET', `Butuh ±${needed} credits untuk ${todo.length} shot, tersisa ${credits} credits di akun Flow`);
      }
      for (const state of todo) await this.queueShot(record, board, state.id);
      record.status = 'rendering';
      record.error = undefined;
      await this.save(record, todo.length ? `${todo.length} shot masuk antrean Flow` : undefined);
      return record;
    });
  }

  async retry(id: string): Promise<StoryRecord> {
    const record = await this.withLock(id, async () => {
      const r = await this.require(id);
      for (const s of r.shots) if (s.status === 'failed') { s.status = 'pending'; s.attempts = 0; s.error = undefined; }
      r.error = undefined;
      r.status = r.shots.every(s => s.status === 'done') ? 'assembling' : 'draft';
      await this.save(r, 'Diulang');
      return r;
    });
    return record.status === 'assembling' ? record : this.render(id, { force: true });
  }

  private async rejectTake(state: ShotState, reason: string): Promise<'requeue' | 'failed'> {
    state.attempts += 1;
    state.lastError = reason;
    if (state.attempts >= MAX_TAKES) {
      state.status = 'failed';
      state.error = `${reason} (setelah ${state.attempts} take)`;
      return 'failed';
    }
    return 'requeue';
  }

  private async collect(record: StoryRecord, board: Storyboard): Promise<boolean> {
    let changed = false;
    for (const state of record.shots) {
      const shot = board.shots.find(s => s.id === state.id);
      if (!shot || state.status === 'done' || state.status === 'failed') continue;
      if (shot.reuse) {
        const job = await this.deps.flow.getJob(shot.reuse.jobId);
        if (job?.status === 'done' && job.resultPath && existsSync(job.resultPath)) {
          await copyFile(job.resultPath, this.shotPath(record.id, shot.id));
          state.status = 'done';
          state.promptHash = hash(JSON.stringify(shot.reuse));
        } else {
          state.status = 'failed';
          state.error = `Klip ${shot.reuse.jobId} tidak tersedia untuk dipakai ulang`;
        }
        changed = true;
        continue;
      }
      if (state.status !== 'queued' || !state.jobId) continue;
      const job = await this.deps.flow.getJob(state.jobId);
      if (!job) {
        if ((await this.rejectTake(state, 'Job Flow hilang')) === 'requeue') await this.queueShot(record, board, state.id);
        changed = true;
        continue;
      }
      if (job.status === 'failed') {
        if ((await this.rejectTake(state, job.error ?? 'Flow gagal')) === 'requeue') await this.queueShot(record, board, state.id);
        changed = true;
        continue;
      }
      if (job.status !== 'done' || !job.resultPath) continue;
      const target = this.shotPath(record.id, state.id);
      await copyFile(job.resultPath, target);
      const reason = await this.qc(target, !!shot.silent);
      if (reason) {
        await rm(target, { force: true });
        if ((await this.rejectTake(state, reason)) === 'requeue') await this.queueShot(record, board, state.id);
      } else {
        state.status = 'done';
        state.durationSec = (await this.deps.probe(target)).durationSec;
        state.lastError = undefined;
      }
      changed = true;
    }
    return changed;
  }

  /** Returns the QC failure reason, or undefined when the clip is usable. */
  private async qc(file: string, silent: boolean): Promise<string | undefined> {
    let probe: ClipProbe;
    try {
      if ((await stat(file)).size < 1024) return 'Klip kosong/rusak';
      probe = await this.deps.probe(file);
    } catch (error) {
      return `Klip tidak bisa dibaca: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
    }
    if (!(probe.durationSec >= MIN_CLIP_SEC)) return `Klip terlalu pendek / too short (${probe.durationSec?.toFixed?.(1) ?? '?'} s)`;
    if (!silent && !probe.hasAudio) return 'Klip tanpa suara narasi (no audio)';
    return undefined;
  }

  private async writeAssemblyPlan(record: StoryRecord, board: Storyboard): Promise<void> {
    const dir = this.storyDir(record.id);
    const plan = {
      ...board,
      slug: 'final',
      shots: board.shots.map(s => (s.reuse ? { ...s, reuse: { file: join(dir, `${s.id}.mp4`), start: s.reuse.start ?? 0 } } : s))
    };
    await this.writeJson(join(dir, 'assemble.json'), plan);
  }

  /** Advance one story as far as possible. Safe to call any time, any number of times. */
  async reconcile(id: string): Promise<StoryRecord | undefined> {
    return this.withLock(id, async () => {
      const record = await this.get(id);
      if (!record || (record.status !== 'rendering' && record.status !== 'assembling')) return record;
      const board = await this.readStoryboard(id);
      if (record.status === 'rendering') {
        const changed = await this.collect(record, board);
        const failed = record.shots.filter(s => s.status === 'failed');
        const open = record.shots.filter(s => s.status === 'queued' || s.status === 'pending');
        if (failed.length && !open.length) {
          record.status = 'failed';
          record.error = failed.map(s => `${s.id}: ${s.error ?? 'gagal'}`).join('; ');
          await this.save(record, 'Gagal: ' + record.error);
          return record;
        }
        if (!record.shots.every(s => s.status === 'done')) {
          if (changed) await this.save(record, `${record.shots.filter(s => s.status === 'done').length}/${record.shots.length} shot siap`);
          return record;
        }
        record.status = 'assembling';
        await this.save(record, 'Semua shot siap, merakit video');
      }
      try {
        await this.writeAssemblyPlan(record, board);
        await rm(this.videoPath(id), { force: true });
        await this.deps.assemble(this.storyDir(id));
        const info = await stat(this.videoPath(id));
        record.status = 'done';
        record.video = { bytes: info.size, finishedAtMs: Date.now() };
        record.error = undefined;
        await this.save(record, 'Video selesai');
      } catch (error) {
        record.status = 'failed';
        record.error = `Perakitan gagal: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600);
        await this.save(record, record.error);
      }
      return record;
    });
  }

  async reconcileAll(): Promise<void> {
    for (const id of await this.activeIds()) {
      try { await this.reconcile(id); } catch (error) { console.error(`[stories] reconcile ${id}:`, error); }
    }
  }

  async remove(id: string): Promise<boolean> {
    return this.withLock(id, async () => {
      if (!(await this.get(id))) return false;
      await rm(this.storyDir(id), { recursive: true, force: true });
      return true;
    });
  }
}
