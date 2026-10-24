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
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FlowStore } from '../flow/store.js';
import { linkOrCopy } from '../media/link.js';
import { CREDITS_PER_SHOT, buildShotPrompt, castOf, characterSheetPrompt, framePrompt, normalizeScenes, shotCast, validateStoryboard, type Storyboard } from './storyboard.js';

import { composeStyle, resolveLook } from './looks.js';
import { usdLabel } from '../providers/catalog.js';

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
  /** A final video exists but the storyboard changed after it (order or content). */
  videoStale?: boolean;
  /** Shots of the current/last prepare or render run (partial runs per scene or shot). */
  run?: { shots: string[] };
  events: Array<{ atMs: number; message: string }>;
  /** User id that created the story; every Flow job it queues is attributed to them. */
  createdBy?: string;
};

export type StoryDeps = {
  dataDir: string;
  flow: FlowStore;
  probe: (file: string) => Promise<ClipProbe>;
  /** Builds `<dir>/final.mp4` from `<dir>/assemble.json` and the shot clips in `<dir>`. */
  assemble: (dir: string) => Promise<void>;
  /** Pixel size of a keyframe (QC: 9:16 stories need portrait frames). */
  imageSize?: (file: string) => Promise<{ width: number; height: number }>;
  /** OpenRouter price + balance for the budget check of an OpenRouter video engine (unknown = no check). */
  openRouter?: {
    usdPerClip: (model: string) => Promise<number | null>;
    balance: () => Promise<{ remainingUsd: number | null } | null>;
  };
};

export class StoryError extends Error {
  constructor(public code: 'INVALID' | 'NOT_FOUND' | 'BUSY' | 'BUDGET', message: string) {
    super(message);
  }
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const BUSY_STATUSES: StoryStatus[] = ['casting', 'framing', 'rendering', 'assembling'];

/** Key-order independent JSON (detects real storyboard changes, not re-serialisation). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter(k => (value as Record<string, unknown>)[k] !== undefined).sort()
      .map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Where a story rests after an edit or a partial run. */
export function idleStatus(record: StoryRecord): StoryStatus {
  // Every clip done: finished, or (no/stale cut) ready to review and assemble.
  if (record.shots.every(s => s.status === 'done')) return record.video && !record.videoStale ? 'done' : 'review';
  if (record.mode === 'konsisten' && record.shots.every(s => !s.frame || s.frame.status === 'done')) return 'review';
  return 'draft';
}

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
    return normalizeScenes(JSON.parse(await readFile(join(this.storyDir(id), 'storyboard.json'), 'utf8')) as Storyboard);
  }

  private assertValid(board: Storyboard): void {
    const errors = validateStoryboard(board);
    if (errors.length) throw new StoryError('INVALID', errors.join('; '));
  }

  async create(input: Storyboard, options: { createdBy?: string } = {}): Promise<StoryRecord> {
    this.assertValid(input);
    const board = normalizeScenes(input);
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
      events: [],
      ...(options.createdBy ? { createdBy: options.createdBy } : {})
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

  async updateStoryboard(id: string, input: Storyboard): Promise<StoryRecord> {
    this.assertValid(input);
    const board = normalizeScenes(input);
    return this.withLock(id, async () => {
      const record = await this.require(id);
      if (BUSY_STATUSES.includes(record.status)) {
        throw new StoryError('BUSY', 'Story sedang diproses; tunggu selesai atau gagal dulu');
      }
      const before = await this.readStoryboard(id).catch(() => undefined);
      const changed = !before || canonical({ ...before, slug: id }) !== canonical({ ...board, slug: id });
      const previous = new Map(record.shots.map(s => [s.id, s]));
      const konsisten = board.mode === 'konsisten';
      record.mode = konsisten ? 'konsisten' : 'cepat';
      const oldCast = new Map((record.cast ?? []).map(c => [c.token, c]));
      // A take is kept when its prompt is unchanged. "Unchanged" also means: the same prompt the previous
      // storyboard builds today — legacy/imported records have no promptHash, and a builder upgrade
      // must not throw away paid clips because the stored hash came from an older builder.
      const beforeShots = new Map((before?.shots ?? []).map(s => [s.id, s]));
      const beforeCast = new Map(before ? castOf(before).map(c => [c.token, c]) : []);
      const clipHash = (b: Storyboard, shot: Storyboard['shots'][number]) => (shot.reuse ? hash(JSON.stringify(shot.reuse)) : hash(buildShotPrompt(b, shot)));
      const same = (stored: string | undefined, now: string, was: () => string | undefined) => stored === now || was() === now;
      record.cast = konsisten ? castOf(board).map(c => {
        const old = oldCast.get(c.token);
        const h = hash(characterSheetPrompt(c, board));
        const was = () => { const bc = beforeCast.get(c.token); return bc && before ? hash(characterSheetPrompt(bc, before)) : undefined; };
        return old && old.status === 'done' && same(old.promptHash, h, was) ? { ...old, promptHash: h } : { token: c.token, name: c.name, status: 'pending' as const, attempts: 0 };
      }) : undefined;
      const castChanged = new Set((record.cast ?? []).filter(c => c.status !== 'done').map(c => c.token));
      record.title = board.title.trim();
      record.shots = board.shots.map(shot => {
        const old = previous.get(shot.id);
        const prev = beforeShots.get(shot.id);
        const promptHash = clipHash(board, shot);
        const frameHash = konsisten && !shot.reuse ? hash(framePrompt(board, shot)) : undefined;
        const keepFrame = konsisten && old?.frame?.status === 'done' && frameHash !== undefined
          && same(old.frame.promptHash, frameHash, () => (prev && before && !prev.reuse ? hash(framePrompt(before, prev)) : undefined))
          && !shotCast(board, shot).some(c => castChanged.has(c.token));
        const frame = konsisten && !shot.reuse ? (keepFrame ? { ...old!.frame!, promptHash: frameHash } : { status: 'pending' as const, attempts: 0 }) : undefined;
        const keepClip = old?.status === 'done' && same(old.promptHash, promptHash, () => (prev && before ? clipHash(before, prev) : undefined));
        if (old && keepClip && (!konsisten || keepFrame || shot.reuse)) return { ...old, promptHash, ...(frame ? { frame } : {}) };
        return { id: shot.id, status: 'pending', attempts: 0, ...(frame ? { frame } : {}) };
      });
      record.error = undefined;
      record.run = undefined;
      // The cut is stale only when what plays changes (order or a take), not scene titles/splits.
      const cut = (shots: ShotState[]) => shots.map(s => `${s.id}:${s.status}:${s.jobId ?? ''}`).join('|');
      if (record.video && changed && cut(record.shots) !== cut([...previous.values()])) record.videoStale = true;
      record.status = idleStatus(record);
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

  private owner(record: StoryRecord): { createdBy?: string } {
    return record.createdBy ? { createdBy: record.createdBy } : {};
  }

  /** Job fields for the storyboard's engine of this kind ({} = Flow, today's behaviour). */
  private engine(board: Storyboard, kind: 'image' | 'video'): { provider?: 'openrouter'; model?: string } {
    const engine = board.engine?.[kind];
    return engine?.provider === 'openrouter' ? { provider: 'openrouter', model: engine.model } : {};
  }

  /** OpenRouter video engine: clips × usdPerClip vs the known balance (unknown price or balance = no check). */
  private async openRouterBudget(model: string, clips: number): Promise<void> {
    if (!clips || !this.deps.openRouter) return;
    const [usdPerClip, balance] = await Promise.all([this.deps.openRouter.usdPerClip(model), this.deps.openRouter.balance()]);
    const remaining = balance?.remainingUsd;
    if (usdPerClip === null || remaining === null || remaining === undefined) return;
    const needed = clips * usdPerClip;
    if (needed > remaining) throw new StoryError('BUDGET', `Butuh ±${usdLabel(needed)}, saldo OpenRouter ${usdLabel(remaining)}`);
  }

  private async queueShot(record: StoryRecord, board: Storyboard, shotId: string): Promise<void> {
    const shot = board.shots.find(s => s.id === shotId)!;
    const state = record.shots.find(s => s.id === shotId)!;
    const prompt = buildShotPrompt(board, shot);
    const konsisten = record.mode === 'konsisten';
    const engine = this.engine(board, 'video');
    const job = await this.deps.flow.createJob({
      prompt,
      technique: `story:${record.id}/${shot.id}`,
      aspect: board.aspect ?? '9:16',
      durationSec: 6,
      kind: 'video',
      ...this.owner(record),
      ...engine,
      ...(konsisten ? {
        group: record.id,
        characters: shotCast(board, shot).map(c => ({ name: c.name, look: c.look })),
        // OpenRouter animates the approved keyframe file (first_frame); Flow animates its own media.
        ...(engine.provider === 'openrouter'
          ? (state.frame?.status === 'done' ? { startImage: this.framePath(record.id, shot.id) } : {})
          : state.frame?.mediaId ? { startFrame: { mediaId: state.frame.mediaId, caption: state.frame.caption ?? '' } } : {})
      } : {})
    });
    state.jobId = job.id;
    state.promptHash = hash(prompt);
    state.status = 'queued';
    state.error = undefined;
  }

  /** Shot ids of a run: one shot, one scene, or (neither) the whole story. */
  private subset(board: Storyboard, target: { scene?: string; shot?: string; shots?: string[] }): string[] {
    if (target.shots) return board.shots.map(s => s.id).filter(id => target.shots!.includes(id));
    if (target.shot !== undefined) {
      if (!board.shots.some(s => s.id === target.shot)) throw new StoryError('NOT_FOUND', 'Shot tidak ditemukan');
      return [target.shot];
    }
    if (target.scene !== undefined) {
      const scene = board.scenes?.find(sc => sc.id === target.scene);
      if (!scene) throw new StoryError('NOT_FOUND', 'Scene tidak ditemukan');
      return [...scene.shots];
    }
    return board.shots.map(s => s.id);
  }

  /** Shots of the active run (records from before partial runs: the whole story). */
  private runIds(record: StoryRecord): Set<string> {
    return new Set(record.run?.shots ?? record.shots.map(s => s.id));
  }

  /** Queue clips for one shot / one scene / everything not done. Budget counts only the run. */
  async render(id: string, options: { force?: boolean; scene?: string; shot?: string } = {}): Promise<StoryRecord> {
    return this.startRender(id, options);
  }

  private async startRender(id: string, options: { force?: boolean; scene?: string; shot?: string; shots?: string[] }): Promise<StoryRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      if (record.status === 'assembling') throw new StoryError('BUSY', 'Story sedang dirakit');
      if (record.status === 'casting' || record.status === 'framing') throw new StoryError('BUSY', 'Keyframe sedang dibuat; tunggu selesai dulu');
      const board = await this.readStoryboard(id);
      const ids = new Set(this.subset(board, options));
      const run = record.shots.filter(s => ids.has(s.id));
      if (record.mode === 'konsisten' && run.some(s => s.frame && s.frame.status !== 'done')) {
        throw new StoryError('INVALID', 'Buat dan review keyframe dulu sebelum render video');
      }
      const reuseIds = new Set(board.shots.filter(s => s.reuse).map(s => s.id));
      const todo = run.filter(s => !reuseIds.has(s.id) && (s.status === 'pending' || s.status === 'failed'));
      const videoEngine = board.engine?.video;
      if (videoEngine?.provider === 'openrouter') {
        if (!options.force) await this.openRouterBudget(videoEngine.model, todo.length);
      } else {
        const credits = await this.knownCredits();
        const needed = todo.length * CREDITS_PER_SHOT;
        if (!options.force && credits !== undefined && needed > credits) {
          throw new StoryError('BUDGET', `Butuh ±${needed} credits untuk ${todo.length} shot, tersisa ${credits} credits di akun Flow`);
        }
      }
      for (const state of todo) await this.queueShot(record, board, state.id);
      // A second render while rendering widens the run instead of replacing it.
      const previous = record.status === 'rendering' ? [...this.runIds(record)] : [];
      record.run = { shots: record.shots.map(s => s.id).filter(sid => ids.has(sid) || previous.includes(sid)) };
      record.status = 'rendering';
      record.error = undefined;
      await this.save(record, todo.length ? `${todo.length} shot masuk antrean Flow` : undefined);
      return record;
    });
  }

  async retry(id: string): Promise<StoryRecord> {
    let ids: string[] = [];
    const record = await this.withLock(id, async () => {
      const r = await this.require(id);
      // Retry the last run plus anything that failed; never spends on scenes the user did not run.
      const run = this.runIds(r);
      ids = r.shots.filter(s => run.has(s.id) || s.status === 'failed' || s.frame?.status === 'failed').map(s => s.id);
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
    if (record.mode === 'konsisten' && record.shots.some(s => ids.includes(s.id) && s.frame && s.frame.status !== 'done')) return this.startPrep(id, { shots: ids });
    return this.startRender(id, { force: true, shots: ids });
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
    const run = this.runIds(record);
    for (const state of record.shots) {
      const shot = board.shots.find(s => s.id === state.id);
      if (!shot || state.status === 'done' || state.status === 'failed') continue;
      if (shot.reuse) {
        if (!run.has(state.id)) continue;
        const job = await this.deps.flow.getJob(shot.reuse.jobId);
        if (job?.status === 'done' && job.resultPath && existsSync(job.resultPath)) {
          await linkOrCopy(job.resultPath, this.shotPath(record.id, shot.id));
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
      await linkOrCopy(job.resultPath, target);
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
      if (!record || !BUSY_STATUSES.includes(record.status)) return record;
      const board = await this.readStoryboard(id);
      if (record.status === 'casting' || record.status === 'framing') return this.advancePrep(record, board);
      if (record.status === 'rendering') {
        const changed = await this.collect(record, board);
        const run = this.runIds(record);
        // Only queued clips keep the run open: pending shots of other scenes never block it.
        if (record.shots.some(s => s.status === 'queued')) {
          if (changed) await this.save(record, `${record.shots.filter(s => s.status === 'done').length}/${record.shots.length} shot siap`);
          return record;
        }
        const failed = record.shots.filter(s => run.has(s.id) && s.status === 'failed');
        if (failed.length) {
          record.status = 'failed';
          record.error = failed.map(s => `${s.id}: ${s.error ?? 'gagal'}`).join('; ');
          await this.save(record, 'Gagal: ' + record.error);
          return record;
        }
        if (!record.shots.every(s => s.status === 'done')) {
          record.status = idleStatus(record);
          await this.save(record, `${record.shots.filter(s => s.status === 'done').length}/${record.shots.length} shot siap`);
          return record;
        }
        record.status = 'assembling';
        await this.save(record, 'Semua shot siap, merakit video');
      }
      return this.runAssembly(record, board);
    });
  }

  /** Rebuild final.mp4 from the current order. Needs every shot done; free (no Flow). */
  async assemble(id: string): Promise<StoryRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      if (BUSY_STATUSES.includes(record.status)) throw new StoryError('BUSY', 'Story sedang diproses');
      if (!record.shots.every(s => s.status === 'done')) throw new StoryError('INVALID', 'Semua shot harus selesai sebelum video dirakit');
      const board = await this.readStoryboard(id);
      record.status = 'assembling';
      record.error = undefined;
      await this.save(record, 'Merakit ulang video');
      return this.runAssembly(record, board);
    });
  }

  private async runAssembly(record: StoryRecord, board: Storyboard): Promise<StoryRecord> {
    const id = record.id;
    const backup = `${this.videoPath(id)}.prev`;
    try {
      await this.writeAssemblyPlan(record, board);
      // Keep the previous cut until the new one exists: a failed re-assembly must not lose it.
      if (existsSync(this.videoPath(id))) await rename(this.videoPath(id), backup);
      await this.deps.assemble(this.storyDir(id));
      const info = await stat(this.videoPath(id));
      record.status = 'done';
      record.video = { bytes: info.size, finishedAtMs: Date.now() };
      record.videoStale = undefined;
      record.error = undefined;
      await rm(backup, { force: true });
      await this.save(record, 'Video selesai');
    } catch (error) {
      if (existsSync(backup)) await rename(backup, this.videoPath(id)).catch(() => undefined);
      else { await rm(this.videoPath(id), { force: true }); record.video = undefined; }
      record.status = 'failed';
      record.error = `Perakitan gagal: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600);
      await this.save(record, record.error);
    }
    return record;
  }

  /** Studio pickers changed: recompose the Style line (invalidates sheets/frames/clips whose prompt changed). */
  async setLook(id: string, picks: Partial<Record<string, unknown>>): Promise<StoryRecord> {
    const board = await this.readStoryboard(id);
    const look = resolveLook({ template: board.template, look: { ...(board.look ?? {}), ...picks } });
    return this.updateStoryboard(id, { ...board, look, style: composeStyle(look) });
  }

  // ------------------------------------------------------------------ konsisten: cast + keyframes

  /** Character sheets the run needs, then the run's keyframes. Free in Flow; ends idle (review) for the user to approve. */
  async prepare(id: string, options: { scene?: string } = {}): Promise<StoryRecord> {
    return this.startPrep(id, options);
  }

  /** Cast tokens needed by the run's shots. */
  private runCast(record: StoryRecord, board: Storyboard): CastState[] {
    const run = this.runIds(record);
    const tokens = new Set(board.shots.filter(s => run.has(s.id) && !s.reuse).flatMap(s => shotCast(board, s).map(c => c.token)));
    return (record.cast ?? []).filter(c => tokens.has(c.token));
  }

  private async startPrep(id: string, options: { scene?: string; shots?: string[] }): Promise<StoryRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      if (record.mode !== 'konsisten') throw new StoryError('INVALID', 'Keyframe hanya untuk mode konsisten');
      if (BUSY_STATUSES.includes(record.status)) throw new StoryError('BUSY', 'Story sedang diproses');
      const board = await this.readStoryboard(id);
      record.run = { shots: this.subset(board, options) };
      record.error = undefined;
      const needed = this.runCast(record, board);
      const todo = needed.filter(c => c.status === 'pending' || c.status === 'failed');
      for (const c of todo) await this.queueCast(record, board, c);
      if (needed.every(c => c.status === 'done')) {
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
      const needed = new Set(shotCast(board, shot).map(c => c.token));
      if ((record.cast ?? []).some(c => needed.has(c.token) && c.status !== 'done')) throw new StoryError('INVALID', 'Lembar karakter belum siap');
      await this.queueFrame(record, board, shotId);
      record.run = { shots: [shotId] };
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
      prompt, kind: 'character', group: record.id, aspect: '16:9', durationSec: 6, ...this.owner(record), ...this.engine(board, 'image'),
      technique: `story:${record.id}/cast:${cast.token}`,
      characters: [{ name: member.name, look: member.look }]
    });
    Object.assign(cast, { jobId: job.id, status: 'queued', promptHash: hash(prompt), error: undefined });
  }

  private async queueFrame(record: StoryRecord, board: Storyboard, shotId: string): Promise<void> {
    const shot = board.shots.find(s => s.id === shotId)!;
    const state = record.shots.find(s => s.id === shotId)!;
    const prompt = framePrompt(board, shot);
    const engine = this.engine(board, 'image');
    const job = await this.deps.flow.createJob({
      prompt, kind: 'image', group: record.id, aspect: board.aspect ?? '9:16', durationSec: 6, ...this.owner(record), ...engine,
      technique: `story:${record.id}/frame:${shot.id}`,
      characters: shotCast(board, shot).map(c => ({ name: c.name, look: c.look })),
      // OpenRouter gets the approved cast sheets as input references.
      ...(engine.provider === 'openrouter' ? { references: shotCast(board, shot).map(c => this.castPath(record.id, c.token)) } : {})
    });
    state.frame = { ...(state.frame ?? { attempts: 0 }), status: 'queued', jobId: job.id, promptHash: hash(prompt), error: undefined } as TakeState;
  }

  private async queueFrames(record: StoryRecord, board: Storyboard): Promise<void> {
    const run = this.runIds(record);
    for (const s of record.shots) if (run.has(s.id) && s.frame && (s.frame.status === 'pending' || s.frame.status === 'failed')) await this.queueFrame(record, board, s.id);
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
    await linkOrCopy(job.resultPath, target);
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
      const cast = this.runCast(record, board);
      const failed = cast.filter(c => c.status === 'failed');
      if (failed.length && !cast.some(c => c.status === 'queued')) {
        record.status = 'failed';
        record.error = failed.map(c => `${c.name}: ${c.error ?? 'gagal'}`).join('; ');
        await this.save(record, 'Gagal: ' + record.error);
        return record;
      }
      if (!cast.every(c => c.status === 'done')) {
        for (const c of cast) if (c.status === 'pending') { await this.queueCast(record, board, c); changed = true; }
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
    const run = this.runIds(record);
    const frames = record.shots.filter(s => s.frame).map(s => s.frame!);
    const runFrames = record.shots.filter(s => s.frame && run.has(s.id)).map(s => s.frame!);
    const open = frames.some(f => f.status === 'queued');
    const failed = record.shots.filter(s => run.has(s.id) && s.frame?.status === 'failed');
    if (failed.length && !open) {
      record.status = 'failed';
      record.error = failed.map(s => `${s.id}: ${s.frame!.error ?? 'gagal'}`).join('; ');
      await this.save(record, 'Gagal: ' + record.error);
      return record;
    }
    if (!open) {
      // Run frames never queued (e.g. a record from before partial runs): queue them now.
      for (const s of record.shots) if (run.has(s.id) && s.frame?.status === 'pending') { await this.queueFrame(record, board, s.id); changed = true; }
    }
    // Only queued frames keep the run open: pending frames of other scenes never block it.
    if (!frames.some(f => f.status === 'queued') && runFrames.every(f => f.status === 'done')) {
      record.status = idleStatus(record);
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
