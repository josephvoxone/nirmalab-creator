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
import { CREDITS_PER_SHOT, buildShotPrompt, castOf, characterSheetPrompt, framePrompt, shotCast, validateStoryboard, type Storyboard } from './storyboard.js';

const MIN_IMAGE_BYTES = 10_000;

export const MAX_TAKES = 3;
export const MIN_CLIP_SEC = 3;
const STORY_ID = /^story_[a-f0-9]{16}$/;

export type ClipProbe = { durationSec: number; hasAudio: boolean };

export type StoryStatus = 'draft' | 'casting' | 'framing' | 'review' | 'rendering' | 'assembling' | 'done' | 'failed';
export type ShotStatus = 'pending' | 'queued' | 'done' | 'failed';

/** One attempt-tracked Flow artefact (character sheet or keyframe). */
export type TakeState = {
  status: ShotStatus;
  attempts: number;
  jobId?: string;
  mediaId?: string;
  caption?: string;
  promptHash?: string;
  lastError?: string;
  error?: string;
};

export type CastState = TakeState & { token: string; name: string; flowCharacterId?: string };

export type ShotState = {
  id: string;
  /** konsisten mode: the approved still this shot is animated from. */
  frame?: TakeState;
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
  mode?: 'konsisten' | 'cepat';
  cast?: CastState[];
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
  /** Pixel size of a keyframe (QC: 9:16 stories need portrait frames). */
  imageSize?: (file: string) => Promise<{ width: number; height: number }>;
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

  framePath(id: string, shotId: string): string {
    return join(this.storyDir(id), `frame-${shotId}.png`);
  }

  castPath(id: string, token: string): string {
    return join(this.storyDir(id), `cast-${token}.png`);
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
      mode: board.mode === 'konsisten' ? 'konsisten' : 'cepat',
      ...(board.mode === 'konsisten' ? { cast: castOf(board).map(c => ({ token: c.token, name: c.name, status: 'pending' as const, attempts: 0 })) } : {}),
      shots: board.shots.map(s => ({
        id: s.id, status: 'pending', attempts: 0,
        ...(board.mode === 'konsisten' && !s.reuse ? { frame: { status: 'pending' as const, attempts: 0 } } : {})
      })),
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
    return (await this.list()).filter(r => ['casting', 'framing', 'rendering', 'assembling'].includes(r.status)).map(r => r.id);
  }

  async updateStoryboard(id: string, board: Storyboard): Promise<StoryRecord> {
    this.assertValid(board);
    return this.withLock(id, async () => {
      const record = await this.require(id);
      if (['casting', 'framing', 'rendering', 'assembling'].includes(record.status)) {
        throw new StoryError('BUSY', 'Story sedang diproses; tunggu selesai atau gagal dulu');
      }
      const previous = new Map(record.shots.map(s => [s.id, s]));
      const konsisten = board.mode === 'konsisten';
      record.mode = konsisten ? 'konsisten' : 'cepat';
      const oldCast = new Map((record.cast ?? []).map(c => [c.token, c]));
      record.cast = konsisten ? castOf(board).map(c => {
        const old = oldCast.get(c.token);
        const h = hash(characterSheetPrompt(c, board));
        return old && old.status === 'done' && old.promptHash === h ? old : { token: c.token, name: c.name, status: 'pending' as const, attempts: 0 };
      }) : undefined;
      const castChanged = new Set((record.cast ?? []).filter(c => c.status !== 'done').map(c => c.token));
      record.title = board.title.trim();
      record.shots = board.shots.map(shot => {
        const old = previous.get(shot.id);
        const promptHash = shot.reuse ? hash(JSON.stringify(shot.reuse)) : hash(buildShotPrompt(board, shot));
        const frameHash = konsisten && !shot.reuse ? hash(framePrompt(board, shot)) : undefined;
        const keepFrame = konsisten && old?.frame?.status === 'done' && old.frame.promptHash === frameHash
          && !shotCast(board, shot).some(c => castChanged.has(c.token));
        const frame = konsisten && !shot.reuse ? (keepFrame ? old!.frame : { status: 'pending' as const, attempts: 0 }) : undefined;
        if (old && old.status === 'done' && old.promptHash === promptHash && (!konsisten || keepFrame || shot.reuse)) return { ...old, ...(frame ? { frame } : {}) };
        return { id: shot.id, status: 'pending', attempts: 0, ...(frame ? { frame } : {}) };
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
    const konsisten = record.mode === 'konsisten';
    const job = await this.deps.flow.createJob({
      prompt,
      technique: `story:${record.id}/${shot.id}`,
      aspect: board.aspect ?? '9:16',
      durationSec: 6,
      kind: 'video',
      ...(konsisten ? {
        group: record.id,
        characters: shotCast(board, shot).map(c => ({ name: c.name, look: c.look })),
        ...(state.frame?.mediaId ? { startFrame: { mediaId: state.frame.mediaId, caption: state.frame.caption ?? '' } } : {})
      } : {})
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
      if (record.mode === 'konsisten' && record.shots.some(s => s.frame && s.frame.status !== 'done')) {
        throw new StoryError('INVALID', 'Buat dan review keyframe dulu sebelum render video');
      }
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
      const prepFailed = (r.cast ?? []).some(c => c.status === 'failed') || r.shots.some(s => s.frame?.status === 'failed');
      for (const c of r.cast ?? []) if (c.status === 'failed') Object.assign(c, { status: 'pending', attempts: 0, error: undefined });
      for (const s of r.shots) if (s.frame?.status === 'failed') Object.assign(s.frame, { status: 'pending', attempts: 0, error: undefined });
      if (prepFailed) {
        r.error = undefined;
        r.status = 'draft';
        await this.save(r, 'Diulang (karakter/keyframe)');
        return r;
      }
      r.error = undefined;
      r.status = r.shots.every(s => s.status === 'done') ? 'assembling' : 'draft';
      await this.save(r, 'Diulang');
      return r;
    });
    if (record.status === 'assembling') return record;
    if (record.mode === 'konsisten' && record.shots.some(s => s.frame && s.frame.status !== 'done')) return this.prepare(id);
    return this.render(id, { force: true });
  }

  private async rejectTake(state: TakeState | ShotState, reason: string): Promise<'requeue' | 'failed'> {
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
      if (!record || !['casting', 'framing', 'rendering', 'assembling'].includes(record.status)) return record;
      const board = await this.readStoryboard(id);
      if (record.status === 'casting' || record.status === 'framing') return this.advancePrep(record, board);
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

  // ------------------------------------------------------------------ konsisten: cast + keyframes

  /** Character sheets, then keyframes. Free in Flow; ends in 'review' for the user to approve. */
  async prepare(id: string): Promise<StoryRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      if (record.mode !== 'konsisten') throw new StoryError('INVALID', 'Keyframe hanya untuk mode konsisten');
      if (['casting', 'framing', 'rendering', 'assembling'].includes(record.status)) throw new StoryError('BUSY', 'Story sedang diproses');
      const board = await this.readStoryboard(id);
      record.error = undefined;
      const todo = (record.cast ?? []).filter(c => c.status === 'pending' || c.status === 'failed');
      for (const c of todo) await this.queueCast(record, board, c);
      if ((record.cast ?? []).every(c => c.status === 'done')) {
        await this.queueFrames(record, board);
        record.status = 'framing';
        await this.save(record, 'Membuat keyframe');
      } else {
        record.status = 'casting';
        await this.save(record, `Membuat lembar karakter (${todo.length})`);
      }
      return record;
    });
  }

  /** Review step: draw one frame again (free), optionally with a new shot prompt. */
  async redrawFrame(id: string, shotId: string, prompt?: string): Promise<StoryRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      if (!['review', 'failed', 'draft', 'done'].includes(record.status)) throw new StoryError('BUSY', 'Story sedang diproses');
      const board = await this.readStoryboard(id);
      const shot = board.shots.find(s => s.id === shotId);
      const state = record.shots.find(s => s.id === shotId);
      if (!shot || !state?.frame) throw new StoryError('NOT_FOUND', 'Shot tidak ditemukan');
      if (prompt !== undefined) {
        shot.prompt = prompt.trim();
        this.assertValid(board);
        await this.writeJson(join(this.storyDir(id), 'storyboard.json'), board);
        Object.assign(state, { status: 'pending', attempts: 0, error: undefined });
      }
      state.frame = { status: 'pending', attempts: 0 };
      if ((record.cast ?? []).some(c => c.status !== 'done')) throw new StoryError('INVALID', 'Lembar karakter belum siap');
      await this.queueFrame(record, board, shotId);
      record.status = 'framing';
      record.error = undefined;
      await this.save(record, `Gambar ulang keyframe ${shotId}`);
      return record;
    });
  }

  private async queueCast(record: StoryRecord, board: Storyboard, cast: CastState): Promise<void> {
    const member = castOf(board).find(c => c.token === cast.token)!;
    const prompt = characterSheetPrompt(member, board);
    const job = await this.deps.flow.createJob({
      prompt, kind: 'character', group: record.id, aspect: '16:9', durationSec: 6,
      technique: `story:${record.id}/cast:${cast.token}`,
      characters: [{ name: member.name, look: member.look }]
    });
    Object.assign(cast, { jobId: job.id, status: 'queued', promptHash: hash(prompt), error: undefined });
  }

  private async queueFrame(record: StoryRecord, board: Storyboard, shotId: string): Promise<void> {
    const shot = board.shots.find(s => s.id === shotId)!;
    const state = record.shots.find(s => s.id === shotId)!;
    const prompt = framePrompt(board, shot);
    const job = await this.deps.flow.createJob({
      prompt, kind: 'image', group: record.id, aspect: board.aspect ?? '9:16', durationSec: 6,
      technique: `story:${record.id}/frame:${shot.id}`,
      characters: shotCast(board, shot).map(c => ({ name: c.name, look: c.look }))
    });
    state.frame = { ...(state.frame ?? { attempts: 0 }), status: 'queued', jobId: job.id, promptHash: hash(prompt), error: undefined } as TakeState;
  }

  private async queueFrames(record: StoryRecord, board: Storyboard): Promise<void> {
    for (const s of record.shots) if (s.frame && (s.frame.status === 'pending' || s.frame.status === 'failed')) await this.queueFrame(record, board, s.id);
  }

  /** Collect one take; returns true when state changed. */
  private async collectTake(take: TakeState, target: string, qc: (file: string) => Promise<string | undefined>, requeue: () => Promise<void>): Promise<boolean> {
    if (take.status !== 'queued' || !take.jobId) return false;
    const job = await this.deps.flow.getJob(take.jobId);
    if (!job || job.status === 'failed') {
      if ((await this.rejectTake(take, job?.error ?? 'Job Flow hilang')) === 'requeue') await requeue();
      return true;
    }
    if (job.status !== 'done' || !job.resultPath) return false;
    await copyFile(job.resultPath, target);
    const reason = await qc(target);
    if (reason) {
      await rm(target, { force: true });
      if ((await this.rejectTake(take, reason)) === 'requeue') await requeue();
      return true;
    }
    Object.assign(take, { status: 'done', lastError: undefined, mediaId: job.result?.mediaId, caption: job.result?.caption });
    if (job.result?.flowCharacterId) (take as CastState).flowCharacterId = job.result.flowCharacterId;
    return true;
  }

  private async imageQc(file: string, board: Storyboard): Promise<string | undefined> {
    try {
      if ((await stat(file)).size < MIN_IMAGE_BYTES) return 'Gambar kosong/rusak';
      if (this.deps.imageSize && (board.aspect ?? '9:16') === '9:16') {
        const { width, height } = await this.deps.imageSize(file);
        if (!(height > width)) return `Keyframe bukan 9:16 portrait (${width}×${height})`;
      }
    } catch (error) {
      return `Gambar tidak bisa dibaca: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
    }
    return undefined;
  }

  private async advancePrep(record: StoryRecord, board: Storyboard): Promise<StoryRecord> {
    let changed = false;
    if (record.status === 'casting') {
      for (const c of record.cast ?? []) {
        changed = (await this.collectTake(c, this.castPath(record.id, c.token),
          async f => ((await stat(f)).size < MIN_IMAGE_BYTES ? 'Lembar karakter kosong/rusak' : undefined),
          () => this.queueCast(record, board, c))) || changed;
      }
      const cast = record.cast ?? [];
      const failed = cast.filter(c => c.status === 'failed');
      if (failed.length && !cast.some(c => c.status === 'queued')) {
        record.status = 'failed';
        record.error = failed.map(c => `${c.name}: ${c.error ?? 'gagal'}`).join('; ');
        await this.save(record, 'Gagal: ' + record.error);
        return record;
      }
      if (!cast.every(c => c.status === 'done')) {
        if (changed) await this.save(record, `${cast.filter(c => c.status === 'done').length}/${cast.length} karakter siap`);
        return record;
      }
      await this.queueFrames(record, board);
      record.status = 'framing';
      await this.save(record, 'Karakter siap, membuat keyframe');
      changed = false;
    }
    for (const s of record.shots) {
      if (!s.frame) continue;
      changed = (await this.collectTake(s.frame, this.framePath(record.id, s.id), f => this.imageQc(f, board),
        () => this.queueFrame(record, board, s.id))) || changed;
    }
    const frames = record.shots.filter(s => s.frame).map(s => s.frame!);
    const failed = record.shots.filter(s => s.frame?.status === 'failed');
    if (failed.length && !frames.some(f => f.status === 'queued')) {
      record.status = 'failed';
      record.error = failed.map(s => `${s.id}: ${s.frame!.error ?? 'gagal'}`).join('; ');
      await this.save(record, 'Gagal: ' + record.error);
      return record;
    }
    if (frames.every(f => f.status === 'done')) {
      record.status = 'review';
      await this.save(record, 'Keyframe siap untuk direview');
    } else if (changed) {
      await this.save(record, `${frames.filter(f => f.status === 'done').length}/${frames.length} keyframe siap`);
    }
    return record;
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
