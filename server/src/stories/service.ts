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
import { OUTAGE } from '../providers/axcel.js';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FlowStore } from '../flow/store.js';
import { linkOrCopy } from '../media/link.js';
import { AXCEL_PROJECT_RESOLUTION, CREDITS_PER_SHOT, axcelClipSec, bibleSceneFor, editPrint, isSilent, narrationOf, castOf, frameHashFor, framePromptFor, hashFor, normalizeScenes, sceneOf, sheetHashFor, sheetPromptFor, shotCast, shotPromptFor, validateStoryboard, type Shot, type Storyboard } from './storyboard.js';
import { ShotCompileError } from '../bible/compiler.js';
import { bibleSceneErrors, syncBible } from '../bible/sync.js';
import { SnapshotStore, type RestoreAttention, type RestoreOutcome } from './snapshots.js';
import { AUDIT_GATE, AuditParseError, MAX_AUDIT_IMAGES, type AuditDimensions, type AuditExpectation, type AuditResult } from '../audit/vision.js';

import { composeStyle, resolveLook } from './looks.js';
import { usdLabel } from '../providers/catalog.js';
import { uploadPath } from '../assistant/uploads.js';
import { MUSIC_FILE, NOT_AUDIO_MESSAGE, NO_SOUND_MESSAGE, musicExt } from './music.js';

const MIN_IMAGE_BYTES = 10_000;

export const MAX_TAKES = 3;
/** Error of the clips stopped because the engine reported an outage (MODEL_GANGGUAN) on another clip. */
/** "01-a: <why>; 2 shot (02-b, 03-c): <why>" — one entry per reason, so 20 identical refusals read as one. */
function failureSummary(failed: Array<{ id: string; error?: string }>): string {
  const groups = new Map<string, string[]>();
  for (const s of failed) groups.set(s.error ?? 'gagal', [...(groups.get(s.error ?? 'gagal') ?? []), s.id]);
  return [...groups].map(([why, ids]) => ids.length === 1 ? `${ids[0]}: ${why}` : `${ids.length} shot (${ids.length > 4 ? `${ids.slice(0, 3).join(', ')}, …` : ids.join(', ')}): ${why}`).join('; ');
}
export const OUTAGE_STOP = 'Dihentikan: Axcel sedang gangguan (MODEL_GANGGUAN) — tidak dicoba, render lagi nanti';
export const MIN_CLIP_SEC = 3;
/** Audits that may re-queue a take: the first take plus one repaired take, never a third (spec §4.4). */
export const AUDIT_REPAIR_LIMIT = 2;
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

/** One stored vision audit (spec §4.4). `target` says which take it judged. */
export type AuditRecord = {
  score: number;
  dimensions: AuditDimensions;
  issues: string[];
  repair: string;
  model: string;
  atMs: number;
  costUsd: number;
  target?: 'frame' | 'clip';
};

/** A shot the gate refuses: under 70, or flagged for a human. */
export type GateBlocker = { id: string; score?: number; needsReview: boolean };

export type ShotState = {
  id: string;
  /** konsisten mode: the approved still this shot is animated from. */
  frame?: TakeState;
  status: ShotStatus;
  /** Failed takes so far (QC rejects + Flow failures). */
  attempts: number;
  jobId?: string;
  promptHash?: string;
  /** Live phase of `jobId` from the flow queue: `queued` (waiting for the bridge) or `running`. */
  jobPhase?: 'queued' | 'running';
  /** When the flow queue picked the job up — the UI turns this into "merender 3 mnt". */
  jobStartedAtMs?: number;
  /** Render cost/time hint: how many times this shot was submitted. */
  durationSec?: number;
  lastError?: string;
  error?: string;
  /** Latest vision audit of this shot's keyframe (konsisten) or clip (cepat). */
  audit?: AuditRecord;
  /** `frame:<jobId>` / `clip:<jobId>` of the take the stored audit describes (never audited twice). */
  auditJobId?: string;
  /** Audits that led to a re-queue: the first take plus one repair, never more. */
  auditRepairs?: number;
  /** Extra instruction the failing audit asked for; appended to the next prompt, then cleared. */
  auditRepair?: string;
  /** A human must look at this shot before the video is assembled. */
  needsReview?: boolean;
  approvedBy?: string;
  approvedAtMs?: number;
};

export type StoryRecord = {
  id: string;
  /** Storyboard revision: 1 at creation (and for records written before revisions), +1 on every storyboard change. */
  rev: number;
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
  /**
   * Shots of the current/last prepare or render run (partial runs per scene or shot). `cast` = a
   * sheet-only run (`makeSheet`): exactly these cast sheets, no keyframes.
   */
  run?: { shots: string[]; cast?: string[] };
  events: Array<{ atMs: number; message: string }>;
  /** User id that created the story; every Flow job it queues is attributed to them. */
  createdBy?: string;
  /** Why the last assembly was refused (spec §4.4), so the UI can list the shots. */
  gate?: { message: string; shots: GateBlocker[] };
  /**
   * Paid done takes an edit or an undo displaced (`clip:<shotId>`, `frame:<shotId>`, `cast:<token>`;
   * newest first, at most MAX_ARCHIVED each). When an edit brings back a prompt one of them was
   * made from, it is reinstated instead of paid for again. Not a take field: undo never rewinds it.
   */
  takeArchive?: Record<string, TakeState[]>;
};

/** Displaced done takes kept per shot/frame/cast entry. */
export const MAX_ARCHIVED = 5;

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
  /**
   * Vision audit (spec §4.4, §9.3–9.5). `model()` returns undefined when OpenRouter is not
   * configured: nothing is audited, nothing is spent and no shot is flagged. `frames()` samples a
   * rendered clip (ffmpeg) for the `cepat` clip audit.
   */
  audit?: {
    model: () => Promise<string | undefined>;
    run: (input: { images: string[]; expectation: AuditExpectation; model: string }) => Promise<AuditResult>;
    frames: (clip: string, dir: string, shotId: string) => Promise<string[]>;
  };
};

export class StoryError extends Error {
  constructor(public code: 'INVALID' | 'NOT_FOUND' | 'BUSY' | 'BUDGET' | 'STALE', message: string) {
    super(message);
  }
}

/** Shown verbatim to the user when a save was based on an older revision (409). */
export const STALE_MESSAGE = 'Proyek baru diubah di tempat lain — muat ulang.';

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
export const BUSY_STATUSES: readonly StoryStatus[] = ['casting', 'framing', 'rendering', 'assembling'];

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

/** A shot's clip take without its keyframe (frames are archived on their own). */
function clipTake(shot: ShotState): ShotState {
  const { frame: _frame, ...clip } = shot;
  return clip;
}

/** A spending call approved on revision `rev` runs only on that revision (checked under the story lock). */
function checkRev(record: StoryRecord, rev: number | undefined): void {
  if (rev !== undefined && rev !== record.rev) throw new StoryError('STALE', STALE_MESSAGE);
}

export class StoryService {
  private locks = new Map<string, Promise<unknown>>();
  private readonly root: string;
  /** Undo snapshots; they share this service's per-story lock. */
  readonly snapshots: SnapshotStore;

  constructor(private deps: StoryDeps) {
    this.root = join(deps.dataDir, 'stories');
    this.snapshots = new SnapshotStore(this.root, {
      lock: (id, fn) => this.withLock(id, fn),
      beforeTake: current => { if (BUSY_STATUSES.includes(current.status)) throw new StoryError('BUSY', 'Story sedang diproses; tunggu selesai atau gagal dulu'); },
      beforeRestore: (current, restored) => this.beforeRestore(current, restored)
    });
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

  /** Absolute path of a stored upload reference (`uploads/up_….ext`) of this story; undefined when malformed or missing. */
  referencePath(id: string, rel: unknown): string | undefined {
    return uploadPath(this.storyDir(id), rel);
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
      const record = JSON.parse(await readFile(join(this.storyDir(id), 'story.json'), 'utf8')) as StoryRecord;
      if (typeof record.rev !== 'number') record.rev = 1;
      return record;
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
    if (message) {
      // A repeated progress line ("0/20 shot siap" after every re-queued take) refreshes its time
      // instead of filling the activity log with copies.
      const last = record.events.at(-1);
      record.events = last?.message === message
        ? [...record.events.slice(0, -1), { atMs: record.updatedAtMs, message }]
        : [...record.events, { atMs: record.updatedAtMs, message }].slice(-60);
    }
    await this.writeJson(join(this.storyDir(record.id), 'story.json'), record);
  }

  /** The project's music file (`music.<ext>`), when one was uploaded. */
  async musicPath(id: string): Promise<string | undefined> {
    const dir = this.storyDir(id);
    const name = (await readdir(dir).catch(() => [] as string[])).find(f => MUSIC_FILE.test(f));
    return name ? join(dir, name) : undefined;
  }

  /**
   * Store the timeline music (one per project; a new upload replaces the old). Audio is recognised by
   * its bytes and must hold a sound stream; the board points at it only when the user saves the edit.
   */
  async saveMusic(id: string, bytes: Buffer, name: string): Promise<{ file: string; name: string; seconds: number }> {
    await this.require(id);
    const ext = musicExt(bytes);
    if (!ext) throw new StoryError('INVALID', NOT_AUDIO_MESSAGE);
    const dir = this.storyDir(id);
    const tmp = join(dir, `.music-${randomBytes(6).toString('hex')}.${ext}`);
    await writeFile(tmp, bytes);
    let seconds: number;
    try {
      const probe = await this.deps.probe(tmp);
      if (!probe.hasAudio || !(probe.durationSec > 0)) throw new StoryError('INVALID', NO_SOUND_MESSAGE);
      seconds = Math.round(probe.durationSec * 100) / 100;
    } catch (error) {
      await rm(tmp, { force: true });
      throw error instanceof StoryError ? error : new StoryError('INVALID', NOT_AUDIO_MESSAGE);
    }
    for (const old of (await readdir(dir)).filter(f => MUSIC_FILE.test(f))) await rm(join(dir, old), { force: true });
    const file = `music.${ext}`;
    await rename(tmp, join(dir, file));
    return { file, name: name.trim().slice(0, 120) || 'Musik', seconds };
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
      rev: 1,
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

  /**
   * Save an edited storyboard. `opts.rev` = the revision the caller read: a different current
   * revision throws STALE (spec §9.3); absent = no check (older clients). Bible boards are synced
   * from one function first (both copies of characters/locations/scenes, shot prompts from intent).
   */
  async updateStoryboard(id: string, input: Storyboard, opts: { rev?: number } = {}): Promise<StoryRecord> {
    this.assertValid(input);
    const incoming = normalizeScenes(input);
    return this.withLock(id, async () => {
      const record = await this.require(id);
      if (opts.rev !== undefined && opts.rev !== record.rev) throw new StoryError('STALE', STALE_MESSAGE);
      if (BUSY_STATUSES.includes(record.status)) {
        throw new StoryError('BUSY', 'Story sedang diproses; tunggu selesai atau gagal dulu');
      }
      const before = await this.readStoryboard(id).catch(() => undefined);
      let board = incoming;
      if (incoming.bible) {
        board = normalizeScenes(syncBible(incoming, before));
        const errors = [...bibleSceneErrors(board, before), ...validateStoryboard(board)];
        if (errors.length) throw new StoryError('INVALID', errors.join('; '));
      }
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
      // Bible boards hash PROMPT_VERSION + the compiled prompt; legacy boards hash exactly what they did before.
      const clipHash = (b: Storyboard, shot: Storyboard['shots'][number]) => hashFor(b, shot);
      const same = (stored: string | undefined, now: string, was: () => string | undefined) => stored === now || was() === now;
      // A take not kept may still be in the archive (an undo displaced it): same prompt → reinstated, not paid again.
      const links: Array<[string, string]> = [];
      const archived = (key: string, h: string, target: string) => this.fromArchive(record, key, h, target, links);
      const keptCast = new Set<CastState>();
      if (konsisten) {
        const cast: CastState[] = [];
        for (const c of castOf(board)) {
          const old = oldCast.get(c.token);
          const h = sheetHashFor(c, board);
          const was = () => { const bc = beforeCast.get(c.token); return bc && before ? sheetHashFor(bc, before) : undefined; };
          if (old && old.status === 'done' && same(old.promptHash, h, was)) {
            keptCast.add(old);
            cast.push({ ...old, promptHash: h });
            continue;
          }
          const back = await archived(`cast:${c.token}`, h, this.castPath(id, c.token));
          cast.push(back ? { ...back, token: c.token, name: c.name, promptHash: h } : { token: c.token, name: c.name, status: 'pending' as const, attempts: 0 });
        }
        record.cast = cast;
      } else {
        record.cast = undefined;
      }
      const castChanged = new Set((record.cast ?? []).filter(c => c.status !== 'done').map(c => c.token));
      record.title = board.title.trim();
      const keptClips = new Set<ShotState>();
      const keptFrames = new Set<TakeState>();
      const shots: ShotState[] = [];
      for (const shot of board.shots) {
        const old = previous.get(shot.id);
        const prev = beforeShots.get(shot.id);
        const promptHash = clipHash(board, shot);
        const frameHash = konsisten && !shot.reuse ? frameHashFor(board, shot) : undefined;
        const castReady = !shotCast(board, shot).some(c => castChanged.has(c.token));
        const keepFrame = konsisten && old?.frame?.status === 'done' && frameHash !== undefined
          && same(old.frame.promptHash, frameHash, () => (prev && before && !prev.reuse ? frameHashFor(before, prev) : undefined))
          && castReady;
        let frame: TakeState | undefined;
        if (frameHash !== undefined) {
          if (keepFrame) {
            keptFrames.add(old!.frame!);
            frame = { ...old!.frame!, promptHash: frameHash };
          } else {
            const back = castReady ? await archived(`frame:${shot.id}`, frameHash, this.framePath(id, shot.id)) : undefined;
            frame = back ? { ...back, promptHash: frameHash } : { status: 'pending' as const, attempts: 0 };
          }
        }
        const frameReady = !konsisten || !!shot.reuse || frame?.status === 'done';
        const keepClip = old?.status === 'done' && same(old.promptHash, promptHash, () => (prev && before ? clipHash(before, prev) : undefined));
        if (old && keepClip && frameReady) {
          keptClips.add(old);
          shots.push({ ...old, promptHash, ...(frame ? { frame } : {}) });
          continue;
        }
        const back = frameReady ? await archived(`clip:${shot.id}`, promptHash, this.shotPath(id, shot.id)) : undefined;
        shots.push(back ? { ...(back as ShotState), id: shot.id, promptHash, ...(frame ? { frame } : {}) } : { id: shot.id, status: 'pending', attempts: 0, ...(frame ? { frame } : {}) });
      }
      record.shots = shots;
      // Every paid take this edit lets go of goes to the archive (an edit back, or an undo, can reinstate it).
      for (const old of previous.values()) {
        if (!keptClips.has(old)) this.archiveTake(record, `clip:${old.id}`, clipTake(old));
        if (old.frame && !keptFrames.has(old.frame)) this.archiveTake(record, `frame:${old.id}`, old.frame);
      }
      for (const old of oldCast.values()) if (!keptCast.has(old)) this.archiveTake(record, `cast:${old.token}`, old);
      record.error = undefined;
      record.run = undefined;
      record.gate = undefined;
      // The cut is stale only when what plays changes (order or a take), not scene titles/splits.
      const cut = (shots: ShotState[]) => shots.map(s => `${s.id}:${s.status}:${s.jobId ?? ''}`).join('|');
      if (record.video && changed && (cut(record.shots) !== cut([...previous.values()]) || !before || editPrint(board) !== editPrint(before))) record.videoStale = true;
      record.status = idleStatus(record);
      if (changed) record.rev += 1;
      for (const [source, target] of links) await linkOrCopy(source, target);
      await this.writeJson(join(this.storyDir(id), 'storyboard.json'), { ...board, slug: id });
      await this.save(record, 'Storyboard diubah');
      return record;
    });
  }

  /**
   * Undo (spec §9.2): put back the storyboard and take state of a snapshot. 'stale' when the story
   * changed after that snapshot's change (currentRev or the stored rev ≠ revAfter), 'missing' when
   * the snapshot is unknown or was never committed. Runs under the story lock.
   */
  async restoreSnapshot(id: string, undoId: string, currentRev: number): Promise<RestoreOutcome> {
    await this.require(id);
    return this.snapshots.restore(id, undoId, currentRev);
  }

  /**
   * The result file of a finished take. The Flow store keeps only its newest 500 jobs, but results
   * stay in `flow/clips/<jobId>.<ext>` (the janitor keeps every file a story references), so a
   * pruned job record never makes a paid take count as lost. A job that is known but not done
   * (failed, re-queued) has no usable result.
   */
  private async resultFile(jobId: string): Promise<string | undefined> {
    const job = await this.deps.flow.getJob(jobId);
    if (job) return job.status === 'done' && job.resultPath && existsSync(job.resultPath) ? job.resultPath : undefined;
    if (!/^job_[a-f0-9]{16}$/.test(jobId)) return undefined;
    for (const ext of ['mp4', 'png', 'jpg', 'webp']) {
      const file = join(this.deps.dataDir, 'flow', 'clips', `${jobId}.${ext}`);
      if (existsSync(file)) return file;
    }
    return undefined;
  }

  /** Keep a displaced paid take (done, with a job) in the archive, newest first. */
  private archiveTake(record: StoryRecord, key: string, take: TakeState | undefined): void {
    if (take?.status !== 'done' || !take.jobId) return;
    const archive = { ...(record.takeArchive ?? {}) };
    archive[key] = [{ ...take }, ...(archive[key] ?? []).filter(t => t.jobId !== take.jobId)].slice(0, MAX_ARCHIVED);
    record.takeArchive = archive;
  }

  /**
   * An archived take of `key` made from `promptHash` whose result file still exists: taken out of
   * the archive and returned; its media is queued in `links` to be re-linked to `target`.
   */
  private async fromArchive(record: StoryRecord, key: string, promptHash: string, target: string, links: Array<[string, string]>): Promise<TakeState | undefined> {
    const list = record.takeArchive?.[key] ?? [];
    for (const take of list) {
      if (take.promptHash !== promptHash || !take.jobId) continue;
      const file = await this.resultFile(take.jobId);
      if (!file) continue;
      links.push([file, target]);
      const rest = list.filter(t => t !== take);
      const archive = { ...record.takeArchive };
      if (rest.length) archive[key] = rest; else delete archive[key];
      record.takeArchive = Object.keys(archive).length ? archive : undefined;
      return { ...take };
    }
    return undefined;
  }

  /**
   * Under the lock, before a restore writes: refuse while jobs run; archive every paid take the
   * restore displaces; bring back the media of restored takes — a take whose media is gone is reset
   * (made again) and returned for attention; finally the status follows the restored takes.
   */
  private async beforeRestore(current: StoryRecord, restored: StoryRecord): Promise<RestoreAttention[]> {
    if (BUSY_STATUSES.includes(current.status)) throw new StoryError('BUSY', 'Story sedang diproses; tunggu selesai atau gagal dulu');
    const shots = new Map(current.shots.map(s => [s.id, s]));
    const cast = new Map((current.cast ?? []).map(c => [c.token, c]));
    const backShots = new Map(restored.shots.map(s => [s.id, s]));
    const backCast = new Map((restored.cast ?? []).map(c => [c.token, c]));
    const displaced = (now: TakeState | undefined, back: TakeState | undefined) => now?.status === 'done' && !!now.jobId && back?.jobId !== now.jobId;
    for (const now of current.shots) {
      const back = backShots.get(now.id);
      if (displaced(now, back)) this.archiveTake(restored, `clip:${now.id}`, clipTake(now));
      if (displaced(now.frame, back?.frame)) this.archiveTake(restored, `frame:${now.id}`, now.frame);
    }
    for (const now of current.cast ?? []) if (displaced(now, backCast.get(now.token))) this.archiveTake(restored, `cast:${now.token}`, now);

    // A newer take may have replaced the file (render after the edit): re-link the restored job's result.
    // false = the restored take's media is gone; the newer file must not pass for it.
    const relink = async (take: TakeState | undefined, now: TakeState | undefined, target: string): Promise<boolean> => {
      if (take?.status !== 'done' || !take.jobId || take.jobId === now?.jobId) return true;
      const file = await this.resultFile(take.jobId);
      if (file) {
        await linkOrCopy(file, target);
        return true;
      }
      await rm(target, { force: true });
      return false;
    };
    const attention: RestoreAttention[] = [];
    restored.shots = await Promise.all(restored.shots.map(async shot => {
      let out = shot;
      if (!(await relink(shot.frame, shots.get(shot.id)?.frame, this.framePath(current.id, shot.id)))) {
        out = { ...out, frame: { status: 'pending', attempts: 0 } };
        attention.push({ id: shot.id, take: 'frame' });
      }
      if (!(await relink(shot, shots.get(shot.id), this.shotPath(current.id, shot.id)))) {
        out = { id: shot.id, status: 'pending', attempts: 0, ...(out.frame ? { frame: out.frame } : {}) };
        attention.push({ id: shot.id, take: 'clip' });
      }
      return out;
    }));
    if (restored.cast) {
      const next: CastState[] = [];
      for (const c of restored.cast) {
        if (await relink(c, cast.get(c.token), this.castPath(current.id, c.token))) { next.push(c); continue; }
        next.push({ token: c.token, name: c.name, status: 'pending', attempts: 0 });
        attention.push({ id: c.token, take: 'cast' });
      }
      restored.cast = next;
    }
    // The snapshot's status described its own cut: never 'done' over a stale cut or a take made again.
    if (!BUSY_STATUSES.includes(restored.status)) restored.status = idleStatus(restored);
    return attention;
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
  private engine(board: Storyboard, kind: 'image' | 'video'): { provider?: 'openrouter' | 'axcel'; model?: string } {
    const engine = board.engine?.[kind];
    return engine?.provider === 'openrouter' || engine?.provider === 'axcel' ? { provider: engine.provider, model: engine.model } : {};
  }

  /** Engines that take files (OpenRouter, Axcel): the keyframe/sheets are sent as images, not Flow media ids. */
  private takesFiles(engine: { provider?: string }): boolean {
    return engine.provider === 'openrouter' || engine.provider === 'axcel';
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
    const prompt = this.compiled(() => shotPromptFor(board, shot), shotId);
    const konsisten = record.mode === 'konsisten';
    const engine = this.engine(board, 'video');
    const axcel = board.engine?.video?.provider === 'axcel' ? board.engine.video : undefined;
    const job = await this.deps.flow.createJob({
      prompt: state.auditRepair ? `${prompt} ${state.auditRepair}`.trim() : prompt,
      technique: `story:${record.id}/${shot.id}`,
      aspect: board.aspect ?? '9:16',
      durationSec: axcel ? axcelClipSec(axcel.model) : 6,
      ...(axcel ? { resolution: AXCEL_PROJECT_RESOLUTION } : {}),
      kind: 'video',
      ...this.owner(record),
      ...engine,
      ...(konsisten ? {
        group: record.id,
        characters: shotCast(board, shot).map(c => ({ name: c.name, look: c.look })),
        // OpenRouter/Axcel animate the approved keyframe file (start frame); Flow animates its own media.
        ...(this.takesFiles(engine)
          ? (state.frame?.status === 'done' ? { startImage: this.framePath(record.id, shot.id) } : this.startUpload(record, shot))
          // Flow animates its own media; the file rides along so another account can upload it (round-robin).
          : state.frame?.mediaId ? { startFrame: { mediaId: state.frame.mediaId, caption: state.frame.caption ?? '' }, startImage: this.framePath(record.id, shot.id) } : {})
      } : this.takesFiles(engine) ? this.startUpload(record, shot) : {})
    });
    state.jobId = job.id;
    state.promptHash = hashFor(board, shot);
    state.status = 'queued';
    state.error = undefined;
  }

  /** OpenRouter only: an uploaded start frame of the shot (`shot.startFrame`), when it still exists. */
  private startUpload(record: StoryRecord, shot: Shot): { startImage?: string } {
    const file = this.referencePath(record.id, shot.startFrame);
    return file ? { startImage: file } : {};
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
  /** `rev`: only on this storyboard revision (checked under the lock; another → STALE). */
  async render(id: string, options: { force?: boolean; scene?: string; shot?: string; rev?: number } = {}): Promise<StoryRecord> {
    return this.startRender(id, options);
  }

  private async startRender(id: string, options: { force?: boolean; scene?: string; shot?: string; shots?: string[]; rev?: number }): Promise<StoryRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      checkRev(record, options.rev);
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
      } else if (videoEngine?.provider === 'axcel') {
        // Paid by the Axcel plan: no per-clip balance to check, and no Flow credits are spent.
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
      const queue = videoEngine?.provider === 'axcel' ? `Axcel (${videoEngine.model})` : videoEngine?.provider === 'openrouter' ? 'OpenRouter' : 'Flow';
      await this.save(record, todo.length ? `${todo.length} shot masuk antrean ${queue}` : undefined);
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
    let outage: string | undefined;
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
      if (job.status === 'queued' || job.status === 'running') {
        state.jobPhase = job.status;
        state.jobStartedAtMs = job.startedAtMs ?? job.createdAtMs;
      }
      if (job.status === 'failed') {
        if (OUTAGE.test(job.error ?? '')) {
          // The model is down: more takes, or the other clips of this run, would only hit the same wall.
          state.attempts += 1;
          state.status = 'failed';
          state.lastError = job.error;
          state.error = job.error;
          outage = job.error;
        } else if ((await this.rejectTake(state, job.error ?? 'Flow gagal')) === 'requeue') await this.queueShot(record, board, state.id);
        changed = true;
        continue;
      }
      if (job.status !== 'done' || !job.resultPath) continue;
      const target = this.shotPath(record.id, state.id);
      await linkOrCopy(job.resultPath, target);
      const reason = await this.qc(target, isSilent(board, shot));
      if (reason) {
        await rm(target, { force: true });
        if ((await this.rejectTake(state, reason)) === 'requeue') await this.queueShot(record, board, state.id);
      } else {
        state.status = 'done';
        state.durationSec = (await this.deps.probe(target)).durationSec;
        state.lastError = undefined;
        // cepat: the clip is the only enforcement point (spec §9.3) — sample it and audit it now.
        if (record.mode !== 'konsisten') changed = (await this.auditClip(record, board, state, shot, target)) || changed;
      }
      changed = true;
    }
    if (outage) {
      // Stop the rest of the run: its queued jobs never reach the engine, nothing is re-queued.
      for (const state of record.shots) {
        if (state.status !== 'queued') continue;
        if (state.jobId) await this.deps.flow.failJob(state.jobId, OUTAGE_STOP, { final: true }).catch(() => undefined);
        state.status = 'failed';
        state.error = OUTAGE_STOP;
        state.lastError = outage;
      }
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
    const music = board.edit?.music;
    const plan = {
      ...board,
      slug: 'final',
      // The subtitle line of each shot travels with it (bible shots keep it on the intent).
      shots: board.shots.map(s => ({ ...(s.reuse ? { ...s, reuse: { file: join(dir, `${s.id}.mp4`), start: s.reuse.start ?? 0 } } : s), narration: narrationOf(s) })),
      edit: board.edit ? {
        ...(board.edit.clipVolume !== undefined ? { clipVolume: board.edit.clipVolume } : {}),
        ...(board.edit.subtitles ? { subtitles: true } : {}),
        ...(board.edit.subtitles && board.edit.subtitleStyle ? { subtitleStyle: board.edit.subtitleStyle } : {}),
        ...(music ? { music: { path: join(dir, music.file), volume: music.volume, at: music.at, ...(music.from ? { from: music.from } : {}) } } : {})
      } : undefined
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
          record.error = failureSummary(failed);
          await this.save(record, 'Gagal: ' + record.error);
          return record;
        }
        if (!record.shots.every(s => s.status === 'done')) {
          record.status = idleStatus(record);
          await this.save(record, `${record.shots.filter(s => s.status === 'done').length}/${record.shots.length} shot siap`);
          return record;
        }
        // Automatic assembly obeys the same gate: a flagged shot stops here and waits for a human.
        const blocked = this.setGate(record);
        if (blocked.length) {
          record.status = 'review';
          await this.save(record, record.gate!.message);
          return record;
        }
        record.status = 'assembling';
        await this.save(record, 'Semua shot siap, merakit video');
      }
      return this.runAssembly(record, board);
    });
  }

  /** Rebuild final.mp4 from the current order. Needs every shot done; free (no Flow). */
  async assemble(id: string, opts: { rev?: number } = {}): Promise<StoryRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      checkRev(record, opts.rev);
      if (BUSY_STATUSES.includes(record.status)) throw new StoryError('BUSY', 'Story sedang diproses');
      if (!record.shots.every(s => s.status === 'done')) throw new StoryError('INVALID', 'Semua shot harus selesai sebelum video dirakit');
      // Audit gate (spec §4.4): a shot under 70 or flagged for review blocks the cut until fixed or approved.
      const blockers = this.setGate(record);
      if (blockers.length) {
        record.status = 'review';
        const message = record.gate!.message;
        await this.save(record, message);
        throw new StoryError('INVALID', message);
      }
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
      record.gate = undefined;
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
  async prepare(id: string, options: { scene?: string; rev?: number } = {}): Promise<StoryRecord> {
    return this.startPrep(id, options);
  }

  /**
   * One character sheet for one cast token (konsisten only): exactly one image job, no keyframes.
   * A done sheet is made again (its take goes to the archive). `opts.reference` = an upload of this
   * story (`uploads/…`) sent with this job on OpenRouter; without it the bible card's reference is used.
   */
  async makeSheet(id: string, token: string, opts: { reference?: string; rev?: number } = {}): Promise<StoryRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      checkRev(record, opts.rev);
      if (record.mode !== 'konsisten') throw new StoryError('INVALID', 'Lembar karakter hanya untuk mode konsisten');
      if (BUSY_STATUSES.includes(record.status)) throw new StoryError('BUSY', 'Story sedang diproses; tunggu selesai atau gagal dulu');
      const board = await this.readStoryboard(id);
      const cast = (record.cast ?? []).find(c => c.token === token);
      if (!cast) throw new StoryError('INVALID', `Karakter ${token} belum muncul di shot mana pun — belum ada sheet untuk dibuat`);
      const reference = opts.reference === undefined ? undefined : this.referencePath(id, opts.reference);
      if (opts.reference !== undefined && !reference) throw new StoryError('INVALID', 'Referensi tidak ditemukan di proyek ini');
      this.archiveTake(record, `cast:${token}`, cast);
      Object.assign(cast, { status: 'pending', attempts: 0, error: undefined, lastError: undefined });
      await this.queueCast(record, board, cast, reference);
      record.run = { shots: [], cast: [token] };
      record.status = 'casting';
      record.error = undefined;
      await this.save(record, `Membuat lembar karakter ${cast.name}`);
      return record;
    });
  }

  /** Cast tokens needed by the run's shots. */
  private runCast(record: StoryRecord, board: Storyboard): CastState[] {
    if (record.run?.cast) return (record.cast ?? []).filter(c => record.run!.cast!.includes(c.token));
    const run = this.runIds(record);
    const tokens = new Set(board.shots.filter(s => run.has(s.id) && !s.reuse).flatMap(s => shotCast(board, s).map(c => c.token)));
    return (record.cast ?? []).filter(c => tokens.has(c.token));
  }

  private async startPrep(id: string, options: { scene?: string; shots?: string[]; rev?: number }): Promise<StoryRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      checkRev(record, options.rev);
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

  /**
   * Review step: draw one frame again (free on Flow), optionally with a new shot prompt (legacy
   * boards). `opts.note` is a one-off extra instruction for this take only (like an audit repair:
   * the frame hash does not change); `opts.reference` (`uploads/…`) is sent as an extra image
   * reference with OpenRouter image engines.
   */
  async redrawFrame(id: string, shotId: string, prompt?: string, opts: { note?: string; reference?: string; rev?: number } = {}): Promise<StoryRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      checkRev(record, opts.rev);
      if (!['review', 'failed', 'draft', 'done'].includes(record.status)) throw new StoryError('BUSY', 'Story sedang diproses');
      const board = await this.readStoryboard(id);
      const shot = board.shots.find(s => s.id === shotId);
      const state = record.shots.find(s => s.id === shotId);
      if (!shot || !state?.frame) throw new StoryError('NOT_FOUND', 'Shot tidak ditemukan');
      if (prompt !== undefined) {
        shot.prompt = prompt.trim();
        this.assertValid(board);
      }
      // Checked before anything is written: a refusal leaves board and rev as they were.
      const needed = new Set(shotCast(board, shot).map(c => c.token));
      if ((record.cast ?? []).some(c => needed.has(c.token) && c.status !== 'done')) throw new StoryError('INVALID', 'Lembar karakter belum siap');
      const reference = opts.reference === undefined ? undefined : this.referencePath(id, opts.reference);
      if (opts.reference !== undefined && !reference) throw new StoryError('INVALID', 'Referensi tidak ditemukan di proyek ini');
      if (prompt !== undefined) {
        await this.writeJson(join(this.storyDir(id), 'storyboard.json'), board);
        record.rev += 1;
        Object.assign(state, { status: 'pending', attempts: 0, error: undefined });
      }
      state.frame = { status: 'pending', attempts: 0 };
      // The note rides on this one frame take; a repair pending for the shot (its clip) is kept.
      const note = opts.note?.trim();
      const previousRepair = state.auditRepair;
      if (note) state.auditRepair = [previousRepair, note].filter(Boolean).join(' ');
      try {
        await this.queueFrame(record, board, shotId, reference);
      } finally {
        if (note) state.auditRepair = previousRepair;
      }
      record.run = { shots: [shotId] };
      record.status = 'framing';
      record.error = undefined;
      await this.save(record, `Gambar ulang keyframe ${shotId}`);
      return record;
    });
  }

  /** A bible shot with a missing slot is a bad storyboard (400), not a provider failure (503). */
  private compiled(build: () => string, shotId?: string): string {
    try {
      return build();
    } catch (error) {
      if (error instanceof ShotCompileError) throw new StoryError('INVALID', `${shotId ? `${shotId}: ` : ''}${error.message}`);
      throw error;
    }
  }

  /**
   * One sheet job. OpenRouter image engines also get the character's reference image: `reference`
   * (an absolute upload path) when given, else the upload stored on the bible card. Flow cannot
   * take arbitrary uploads, so it gets the text only.
   */
  private async queueCast(record: StoryRecord, board: Storyboard, cast: CastState, reference?: string): Promise<void> {
    const member = castOf(board).find(c => c.token === cast.token)!;
    const prompt = sheetPromptFor(member, board);
    const engine = this.engine(board, 'image');
    const card = board.bible?.characters?.find(c => c.token === cast.token);
    const ref = this.takesFiles(engine) ? reference ?? this.referencePath(record.id, card?.reference) : undefined;
    const job = await this.deps.flow.createJob({
      prompt, kind: 'character', group: record.id, aspect: '16:9', durationSec: 6, ...this.owner(record), ...engine,
      technique: `story:${record.id}/cast:${cast.token}`,
      characters: [{ name: member.name, look: member.look }],
      ...(ref ? { references: [ref] } : {})
    });
    Object.assign(cast, { jobId: job.id, status: 'queued', promptHash: sheetHashFor(member, board), error: undefined });
  }

  private async queueFrame(record: StoryRecord, board: Storyboard, shotId: string, reference?: string): Promise<void> {
    const shot = board.shots.find(s => s.id === shotId)!;
    const state = record.shots.find(s => s.id === shotId)!;
    const base = this.compiled(() => framePromptFor(board, shot), shot.id);
    const prompt = state.auditRepair ? `${base} ${state.auditRepair}`.trim() : base;
    const engine = this.engine(board, 'image');
    const job = await this.deps.flow.createJob({
      prompt, kind: 'image', group: record.id, aspect: board.aspect ?? '9:16', durationSec: 6, ...this.owner(record), ...engine,
      technique: `story:${record.id}/frame:${shot.id}`,
      characters: shotCast(board, shot).map(c => ({ name: c.name, look: c.look })),
      // OpenRouter/Axcel get the approved cast sheets as input references.
      ...(this.takesFiles(engine) ? { references: [...(reference ? [reference] : []), ...shotCast(board, shot).map(c => this.castPath(record.id, c.token))] } : {})
    });
    state.frame = { ...(state.frame ?? { attempts: 0 }), status: 'queued', jobId: job.id, promptHash: frameHashFor(board, shot), error: undefined } as TakeState;
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

  // ------------------------------------------------------------------ vision audit (spec §4.4)

  /**
   * One audit call. Never throws: a provider failure is recorded in the event log and returns
   * undefined (an unreachable OpenRouter must not block a render), while an unreadable reply is a
   * score of 0 — a model that cannot say "pass" never grants one.
   */
  private async runAudit(record: StoryRecord, board: Storyboard, shot: Shot, images: string[]): Promise<AuditRecord | undefined> {
    const audit = this.deps.audit;
    if (!audit || !images.length) return undefined;
    const model = await audit.model().catch(() => undefined);
    if (!model) return undefined;
    try {
      const result = await audit.run({ images: images.slice(0, MAX_AUDIT_IMAGES), expectation: this.expectation(board, shot), model });
      return { score: result.score, dimensions: result.dimensions, issues: result.issues, repair: result.repair, model, atMs: Date.now(), costUsd: result.costUsd };
    } catch (error) {
      if (error instanceof AuditParseError) {
        return {
          score: 0, dimensions: { sceneMatch: 0, actionMatch: 0, moodMatch: 0, composition: 0 },
          issues: [error.message], repair: '', model, atMs: Date.now(), costUsd: 0
        };
      }
      record.events = [...record.events, { atMs: Date.now(), message: `Audit gagal: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) }].slice(-60);
      return undefined;
    }
  }

  /** What the take must deliver (spec §9.4): scene goal, one action, mood, the spoken line. */
  private expectation(board: Storyboard, shot: Shot): AuditExpectation {
    const scene = bibleSceneFor(board, shot);
    const flat = sceneOf(board, shot.id);
    const location = flat?.location ? board.locations?.[flat.location]?.look : undefined;
    const intent = shot.intent;
    // The auditor reads names, never TOKENs: the same expansion the image prompt gets.
    const named = (text: string) => shotCast(board, shot).reduce((out, c) => out.split(c.token).join(c.name), text);
    return {
      scene: [scene?.title ?? flat?.title, scene?.goal ?? flat?.summary, location].filter(Boolean).join(' — ') || board.title,
      action: intent
        ? [intent.subject, intent.action, intent.startState && intent.endState ? `from ${intent.startState} to ${intent.endState}` : ''].filter(Boolean).join(': ')
        : named(shot.prompt),
      ...(intent?.emotion ?? board.bible?.tone ? { mood: intent?.emotion ?? board.bible?.tone } : {}),
      ...(isSilent(board, shot) || !shot.narration ? {} : { dialogue: named(shot.narration) })
    };
  }

  /** Cast sheets as identity references — at most two, so take + references never exceed three. */
  private referenceImages(record: StoryRecord, board: Storyboard, shot: Shot): string[] {
    return shotCast(board, shot).map(c => this.castPath(record.id, c.token)).filter(f => existsSync(f)).slice(0, MAX_AUDIT_IMAGES - 1);
  }

  /** konsisten: audit the keyframe before it is animated (a repair costs 0 Flow credits). */
  private async auditFrame(record: StoryRecord, board: Storyboard, state: ShotState, shot: Shot): Promise<boolean> {
    const take = state.frame;
    if (!this.deps.audit || take?.status !== 'done' || !take.jobId) return false;
    const key = `frame:${take.jobId}`;
    if (state.auditJobId === key) return false;
    const file = this.framePath(record.id, state.id);
    if (!existsSync(file)) return false;
    const audit = await this.runAudit(record, board, shot, [file, ...this.referenceImages(record, board, shot)]);
    if (!audit) return false;
    state.audit = { ...audit, target: 'frame' };
    state.auditJobId = key;
    const repairs = (state.auditRepairs ?? 0) + 1;
    state.auditRepairs = repairs;
    if (audit.score >= AUDIT_GATE) {
      state.needsReview = undefined;
      state.auditRepair = undefined;
      return true;
    }
    if (audit.repair && repairs < AUDIT_REPAIR_LIMIT) {
      state.auditRepair = audit.repair;
      state.frame = { status: 'pending', attempts: 0 };
      await this.queueFrame(record, board, state.id);
      state.auditRepair = undefined;
      return true;
    }
    state.needsReview = true;
    return true;
  }

  /**
   * cepat: audit three frames sampled across the finished clip (spec §9.3). A clip repair spends
   * Flow credits, so it waits for `board.autoRepairClip` and never crosses the daily cap.
   */
  private async auditClip(record: StoryRecord, board: Storyboard, state: ShotState, shot: Shot, file: string): Promise<boolean> {
    if (!this.deps.audit || state.status !== 'done') return false;
    const key = `clip:${state.jobId ?? ''}`;
    if (state.auditJobId === key) return false;
    let frames: string[] = [];
    try {
      frames = await this.deps.audit.frames(file, this.storyDir(record.id), state.id);
    } catch (error) {
      record.events = [...record.events, { atMs: Date.now(), message: `Audit gagal: sampel frame ${state.id} tidak bisa dibuat`.slice(0, 200) }].slice(-60);
      return false;
    }
    const audit = await this.runAudit(record, board, shot, [...frames, ...this.referenceImages(record, board, shot)].slice(0, MAX_AUDIT_IMAGES));
    if (!audit) return false;
    state.audit = { ...audit, target: 'clip' };
    state.auditJobId = key;
    const repairs = (state.auditRepairs ?? 0) + 1;
    state.auditRepairs = repairs;
    if (audit.score >= AUDIT_GATE) {
      state.needsReview = undefined;
      return true;
    }
    if (!audit.repair || repairs >= AUDIT_REPAIR_LIMIT) {
      state.needsReview = true;
      return true;
    }
    // Default is a human click (spec §9.5): never burn 10 credits unseen, never cross the cap.
    if (board.autoRepairClip !== true || !(await this.withinDailyCap())) {
      state.needsReview = true;
      return true;
    }
    state.status = 'pending';
    state.attempts = 0;
    state.auditRepair = audit.repair;
    await this.queueShot(record, board, state.id);
    state.auditRepair = undefined;
    return true;
  }

  /** A Flow clip repair must fit in the account's daily credit cap (unknown cap = no limit). */
  private async withinDailyCap(cost = CREDITS_PER_SHOT): Promise<boolean> {
    const capped = (await this.deps.flow.listAccounts()).filter(a => a.enabled !== false && typeof a.dailyCreditCap === 'number');
    if (!capped.length) return true;
    const cap = capped.reduce((sum, a) => sum + (a.dailyCreditCap ?? 0), 0);
    const used = capped.reduce((sum, a) => sum + (a.creditsUsedToday ?? 0), 0);
    return used + cost <= cap;
  }

  /** Shots the gate refuses: audited below 70 or flagged for a human, unless a human already signed off. */
  gateBlockers(record: Pick<StoryRecord, 'shots'>): GateBlocker[] {
    return record.shots
      .filter(s => {
        if (typeof s.approvedAtMs === 'number' && s.audit && s.approvedAtMs >= s.audit.atMs) return false;
        return s.needsReview || (typeof s.audit?.score === 'number' && s.audit.score < AUDIT_GATE);
      })
      .map(s => ({ id: s.id, ...(typeof s.audit?.score === 'number' ? { score: s.audit.score } : {}), needsReview: !!s.needsReview }));
  }

  private gateMessage(blockers: GateBlocker[]): string {
    const parts = blockers.map(b => `${b.id} (${b.needsReview ? 'perlu dicek' : `skor ${b.score}`})`);
    return `Belum bisa dirakit — audit belum lolos: ${parts.join(', ')}. Perbaiki atau setujui dulu di tab Hasil.`;
  }

  /** Remember (or clear) why the gate refused, so the UI can list the shots after a reload. */
  private setGate(record: StoryRecord): GateBlocker[] {
    const blockers = this.gateBlockers(record);
    record.gate = blockers.length ? { message: this.gateMessage(blockers), shots: blockers } : undefined;
    return blockers;
  }

  /** Human sign-off: clears the flag and records who approved the shot. */
  async approveShot(id: string, shotId: string, options: { by?: string } = {}): Promise<StoryRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      const state = record.shots.find(s => s.id === shotId);
      if (!state) throw new StoryError('NOT_FOUND', 'Shot tidak ditemukan');
      state.needsReview = undefined;
      state.approvedAtMs = Date.now();
      if (options.by) state.approvedBy = options.by;
      this.setGate(record);
      await this.save(record, `Audit ${shotId} disetujui${options.by ? ` oleh ${options.by}` : ''}`);
      return record;
    });
  }

  /**
   * Spend on the repair the audit asked for. konsisten: the keyframe is drawn again (free).
   * cepat: the clip is re-rendered — allowed here because a human asked, still cap-checked.
   */
  async repairShot(id: string, shotId: string, options: { by?: string } = {}): Promise<StoryRecord> {
    return this.withLock(id, async () => {
      const record = await this.require(id);
      if (BUSY_STATUSES.includes(record.status)) throw new StoryError('BUSY', 'Story sedang diproses; tunggu selesai dulu');
      const board = await this.readStoryboard(id);
      const shot = board.shots.find(s => s.id === shotId);
      const state = record.shots.find(s => s.id === shotId);
      if (!shot || !state) throw new StoryError('NOT_FOUND', 'Shot tidak ditemukan');
      const repair = state.audit?.repair?.trim();
      if (!repair) throw new StoryError('INVALID', 'Audit belum memberi instruksi perbaikan untuk shot ini');
      if (!(await this.withinDailyCap())) throw new StoryError('BUDGET', 'Batas kredit harian akun tersentuh; setujui shot ini atau tunggu besok');
      record.run = { shots: [shotId] };
      record.error = undefined;
      state.needsReview = undefined;
      state.auditRepair = repair;
      if (record.mode === 'konsisten' && state.frame) {
        state.frame = { status: 'pending', attempts: 0 };
        await this.queueFrame(record, board, shotId);
        record.status = 'framing';
      } else {
        state.status = 'pending';
        state.attempts = 0;
        await this.queueShot(record, board, shotId);
        record.status = 'rendering';
      }
      state.auditRepair = undefined;
      this.setGate(record);
      await this.save(record, `Perbaikan audit ${shotId}${options.by ? ` oleh ${options.by}` : ''}`);
      return record;
    });
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
      if (record.run?.cast && !record.run.shots.length) {
        // A sheet-only run (makeSheet) ends here: no keyframe is drawn without being asked for.
        record.status = idleStatus(record);
        await this.save(record, 'Lembar karakter siap');
        return record;
      }
      await this.queueFrames(record, board);
      record.status = 'framing';
      await this.save(record, 'Karakter siap, membuat keyframe');
      changed = false;
    }
    const run = this.runIds(record);
    for (const s of record.shots) {
      if (!s.frame) continue;
      changed = (await this.collectTake(s.frame, this.framePath(record.id, s.id), f => this.imageQc(f, board),
        () => this.queueFrame(record, board, s.id))) || changed;
      // konsisten: judge the still before it is animated — a repair here costs no Flow credits.
      const shot = board.shots.find(b => b.id === s.id);
      if (shot && s.frame.status === 'done' && s.frame.jobId) {
        changed = (await this.auditFrame(record, board, s, shot)) || changed;
      }
    }
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
