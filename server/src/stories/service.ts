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
import type { FlowJob, FlowStore } from '../flow/store.js';
import { linkOrCopy } from '../media/link.js';
import { AXCEL_PROJECT_RESOLUTION, CREDITS_PER_SHOT, axcelClipSec, subtitleOf, bibleSceneFor, editPrint, isSilent, narrationOf, castOf, frameHashFor, framePromptFor, hashFor, lookFor, normalizeScenes, sceneOf, sheetHashFor, sheetPromptFor, shotCast, shotPromptFor, validateStoryboard, type Shot, type Storyboard } from './storyboard.js';
import { ShotCompileError } from '../bible/compiler.js';
import { bibleSceneErrors, syncBible } from '../bible/sync.js';
import { SnapshotStore, type RestoreAttention, type RestoreOutcome } from './snapshots.js';
import { QuotaError, type QuotaKind } from '../quota/errors.js';
import { AUDIT_GATE, AuditParseError, MAX_AUDIT_IMAGES, type AuditDimensions, type AuditExpectation, type AuditResult } from '../audit/vision.js';

import { composeStyle, resolveLook } from './looks.js';
import { usdLabel } from '../providers/catalog.js';
import { uploadPath } from '../assistant/uploads.js';
import { MUSIC_FILE, NOT_AUDIO_MESSAGE, NO_SOUND_MESSAGE, musicExt } from './music.js';

const MIN_IMAGE_BYTES = 10_000;

export const MAX_TAKES = 3;
/**
 * Flow attempts of one clip JOB. The story's takes (MAX_TAKES) are the one owner of clip retries: a job that also
 * retried 3 times made 3×3 = 9 Flow attempts per clip. Sheets and keyframes are free and keep the store default (3).
 */
export const CLIP_JOB_ATTEMPTS = 1;
/** Flow's answer when it will not render the clip (an account without credits is parked by the store before this counts). */
const FLOW_REFUSED = /did not create the video/i;
/** Accounts that must refuse the same clip before it is called un-renderable as written. */
const REFUSAL_ACCOUNTS = 2;
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

/**
 * Free motion QC of a finished clip (bridge/py/clipqc.py): deterministic checks on the pixels, no credits.
 * `reasons` are plain Indonesian sentences (with the second the thing happens at); `suggest` only ever names
 * edits the assembler already supports (`shot.trim`, `shot.zoom`), never a paid re-render.
 * It only sees the painterly look's known failures (a scene melting into another, a pale border growing in, a
 * frozen or near-still clip, the camera drifting back); a small identity glitch (a hood going up in 0.2 s) is NOT found.
 */
export type ShotMotion = {
  status: 'ok' | 'warn' | 'fail';
  score: number;
  reasons: string[];
  at: number;
  suggest?: { trimOut?: number; trimIn?: number; zoom?: number };
};
export type MotionVerdict = Omit<ShotMotion, 'at'>;
/** What the checker needs to know about one clip. */
export type MotionInput = { file: string; move: string; look: string; keyframe?: string; zoom?: number };

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
  /** Flow refused this clip on several accounts (not for credits): the prompt or keyframe must change first. */
  needsEdit?: true;
  /** Accounts that refused this clip with credits to spare ("did not create the video"). */
  refusedBy?: string[];
  /** Motion QC of the current clip (absent: not checked yet, or the checker was unavailable). Dropped when a new take replaces the clip. */
  motion?: ShotMotion;
  /** The take `motion` describes (`jobId`, or the reuse hash): a verdict is never trusted for another take. */
  motionJobId?: string;
  /** `needsReview` was set by a failing `motion` verdict (so only that verdict, or a human, may clear it). */
  motionReview?: boolean;
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
  /** Set by the tenancy migration when it gave an ownerless project to the primary owner (`migrasi-tenancy-1`); never set for projects created with an owner. */
  ownerAssignedBy?: string;
  ownerAssignedAt?: string;
  /** Why the last assembly was refused (spec §4.4), so the UI can list the shots. */
  gate?: { message: string; shots: GateBlocker[] };
  /** Heads-up from the last assembly start (not a refusal): `dub-basi:<shot>` = that shot has text but no fresh dub, so it is silent in the video. */
  warnings?: string[];
  /**
   * Paid done takes an edit or an undo displaced (`clip:<shotId>`, `frame:<shotId>`, `cast:<token>`;
   * newest first, at most MAX_ARCHIVED each). When an edit brings back a prompt one of them was
   * made from, it is reinstated instead of paid for again. Not a take field: undo never rewinds it.
   */
  takeArchive?: Record<string, TakeState[]>;
};

/** Displaced done takes kept per shot/frame/cast entry. */
export const MAX_ARCHIVED = 5;

/** What a motion backfill did: clips checked now, already up to date, or whose checker gave no answer. */
export type MotionBackfill = { checked: number; skipped: number; unavailable: number };

export type AssembleContext = { owner?: string; onPosition?: (position: number, total: number) => void };

export type StoryDeps = {
  dataDir: string;
  flow: FlowStore;
  probe: (file: string) => Promise<ClipProbe>;
  /**
   * Builds `<dir>/final.mp4` from `<dir>/assemble.json` and the shot clips in `<dir>`. `ctx.owner` (the story's
   * creator) lets a shared work queue serve users in turn; `ctx.onPosition` reports the place in that line.
   */
  assemble: (dir: string, ctx?: AssembleContext) => Promise<void>;
  /** The fresh dubs (ElevenLabs) the assembler mixes in; absent = no dubbing feature. */
  dub?: { for: (id: string) => Promise<{ keepAmbient: boolean; shots: Record<string, { file: string; seconds: number }>; staleShots?: string[] }> };
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
  /**
   * Tenancy: the account that owns every project and Flow job made before ownership was recorded (the primary owner the
   * migration assigns; env TENANCY_DEFAULT_OWNER_EMAIL / oldest non-QA admin). Only used to keep a legacy `shot.reuse` of an
   * unattributed clip working for that one account; absent = no such account, an owned project cannot reuse an unattributed clip.
   */
  legacyOwnerId?: () => string | undefined | Promise<string | undefined>;
  /**
   * Money gate (quota ledger). `check` is the friendly pre-flight of a whole run (throws QuotaError, reserves nothing; the
   * atomic gate is `FlowStore.createJob`); `audit` holds the price of one vision audit for `userId` until `commit`/`release`.
   */
  quota?: {
    check: (userId: string | undefined, amounts: Partial<Record<QuotaKind, number>>) => Promise<void>;
    audit: (userId: string | undefined, key: string) => Promise<{ commit: (actualUsd?: number) => Promise<void>; release: () => Promise<void> }>;
  };
  /**
   * Free motion QC of a finished clip. `undefined` (or a throw) = no verdict: the clip stays usable, the event log says
   * so. Absent dependency = nothing is checked. It never renders, queues or spends anything.
   */
  motion?: { check: (input: MotionInput) => Promise<MotionVerdict | undefined> };
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
  /** Background assemblies started by `startAssembly`, per story. */
  private assembling = new Map<string, Promise<void>>();
  /** Motion backfills in flight, per story (a second request joins the first). */
  private motionRuns = new Map<string, Promise<MotionBackfill>>();
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
    this.dropStaleMotion(record);
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

  /**
   * Tenancy hotfix: may a project owned by `owner` (id `selfId`; none while it is being created) take this Flow job's clip through
   * `shot.reuse`? Yes for: the project's own jobs (`group` = its id), jobs made by the same user, jobs of another project of the same
   * owner, and — legacy — an unattributed job (no `createdBy`) when the owner is the account that owned everything before attribution
   * (or the project has no owner either). Everything else is another user's paid clip.
   */
  private async mayReuse(job: FlowJob, owner: string | undefined, selfId?: string): Promise<boolean> {
    if (selfId && job.group === selfId) return true;
    if (owner && job.createdBy === owner) return true;
    if (!owner) return !job.createdBy;
    if (job.group && STORY_ID.test(job.group)) {
      const groupOwner = (await this.get(job.group).catch(() => undefined))?.createdBy;
      if (groupOwner === owner) return true;
    }
    if (!job.createdBy) return (await this.deps.legacyOwnerId?.()) === owner;
    return false;
  }

  /**
   * Save-time check of `shot.reuse.jobId` (HOTFIX T3-reuse): a jobId this board did not already hold must be a clip the owner may use,
   * else 400 INVALID in plain Indonesian. A jobId already in the stored board is not asked again (an existing board keeps saving; the
   * render-time check in `collect` still refuses a foreign clip), and a job that does not exist is accepted here as before (it fails at
   * render with "tidak tersedia", the same words as for a foreign clip, so a save cannot be used to probe other users' job ids).
   */
  private async assertReusable(board: Storyboard, owner: string | undefined, selfId: string | undefined, before?: Storyboard): Promise<void> {
    const errors: string[] = [];
    for (const shot of board.shots) {
      if (!shot.reuse) continue;
      if (before?.shots.find(s => s.id === shot.id)?.reuse?.jobId === shot.reuse.jobId) continue;
      const job = await this.deps.flow.getJob(shot.reuse.jobId);
      if (job && !(await this.mayReuse(job, owner, selfId))) errors.push(`${shot.id}: klip ${shot.reuse.jobId} tidak bisa dipakai ulang — hanya klip milik Anda sendiri (dari proyek Anda) yang boleh`);
    }
    if (errors.length) throw new StoryError('INVALID', errors.join('; '));
  }

  async create(input: Storyboard, options: { createdBy?: string } = {}): Promise<StoryRecord> {
    this.assertValid(input);
    const board = normalizeScenes(input);
    await this.assertReusable(board, options.createdBy, undefined);
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

  /**
   * Tenancy: who owns a record. `createdBy` when set (even when that account is gone: such a project is nobody's); a project that
   * never got an owner at all belongs to the legacy owner (the main owner: the account that owned everything before ownership was
   * recorded — boot attribution normally fixes these, this keeps them his if it could not run). Without a legacy owner: nobody.
   */
  private async effectiveOwner(record: StoryRecord | undefined): Promise<string | undefined> {
    if (!record) return undefined;
    if (record.createdBy) return record.createdBy;
    return (await this.deps.legacyOwnerId?.()) || undefined;
  }

  /** Tenancy (additive): the user a project belongs to; undefined for a missing project, or an ownerless one when there is no legacy owner. */
  async ownerOf(id: string): Promise<string | undefined> {
    return this.effectiveOwner(await this.get(id).catch(() => undefined));
  }

  /** Tenancy (additive): the record when `userId` owns it; NOT_FOUND otherwise, the same error as for a project that does not exist (no oracle). */
  async assertOwner(id: string, userId: string): Promise<StoryRecord> {
    const record = await this.get(id);
    if (!record || !userId || (await this.effectiveOwner(record)) !== userId) throw new StoryError('NOT_FOUND', 'Story not found');
    return record;
  }

  /** Tenancy (additive): only the projects `userId` owns, newest first. */
  async listFor(userId: string): Promise<StoryRecord[]> {
    if (!userId) return [];
    const legacy = (await this.deps.legacyOwnerId?.()) || undefined;
    return (await this.list()).filter(r => (r.createdBy || legacy) === userId);
  }

  /** Tenancy (additive): run `fn` under this story's mutation lock (the migration writes `story.json` under it, like every other writer). */
  lockStory<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return this.withLock(id, fn);
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
      await this.assertReusable(board, record.createdBy, id, before);
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

  /**
   * A background re-take (collect, retry of a failed take): when the owner's quota is used up the shot FAILS with the quota
   * message, so it neither hangs as queued nor loops; the user presses retry after the limit moves or resets.
   */
  /** Same as `requeueShot` for a sheet or keyframe take. */
  private async requeueTake(take: TakeState, requeue: () => Promise<void>): Promise<void> {
    try {
      await requeue();
    } catch (error) {
      if (!(error instanceof QuotaError)) throw error;
      Object.assign(take, { status: 'failed', error: error.message, lastError: error.message });
    }
  }

  private async requeueShot(record: StoryRecord, board: Storyboard, state: ShotState): Promise<void> {
    try {
      await this.queueShot(record, board, state.id);
    } catch (error) {
      if (!(error instanceof QuotaError)) throw error;
      Object.assign(state, { status: 'failed', error: error.message, lastError: error.message });
    }
  }

  private async queueShot(record: StoryRecord, board: Storyboard, shotId: string, options: { force?: boolean } = {}): Promise<void> {
    const shot = board.shots.find(s => s.id === shotId)!;
    const state = record.shots.find(s => s.id === shotId)!;
    const prompt = this.compiled(() => shotPromptFor(board, shot), shotId);
    const konsisten = record.mode === 'konsisten';
    const engine = this.engine(board, 'video');
    const axcel = board.engine?.video?.provider === 'axcel' ? board.engine.video : undefined;
    // A clip that just failed on account A is retaken on another account when one can take it.
    const previous = state.jobId ? await this.deps.flow.getJob(state.jobId) : undefined;
    const avoidAccountId = previous?.status === 'failed' && !previous.cancelled ? previous.accountId : undefined;
    const job = await this.deps.flow.createJob({
      ...(engine.provider === undefined ? { maxAttempts: CLIP_JOB_ATTEMPTS } : {}),
      ...(avoidAccountId ? { avoidAccountId } : {}),
      prompt: state.auditRepair ? `${prompt} ${state.auditRepair}`.trim() : prompt,
      technique: `story:${record.id}/${shot.id}`,
      aspect: board.aspect ?? '9:16',
      durationSec: axcel ? axcelClipSec(axcel.model) : 6,
      ...(axcel ? { resolution: AXCEL_PROJECT_RESOLUTION } : {}),
      kind: 'video',
      ...this.owner(record),
      ...engine,
      ...(options.force ? { budgetOverride: true } : {}),
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
    state.needsEdit = undefined;
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
      // needsEdit shots wait for an edit; only naming the shot itself renders it again.
      const todo = run.filter(s => !reuseIds.has(s.id) && (s.status === 'pending' || s.status === 'failed') && (!s.needsEdit || options.shot === s.id));
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
      // Friendly pre-flight of the whole run against the owner's quota (the atomic gate is FlowStore.createJob): a run that
      // cannot be paid is refused before the first job exists. `force` skips only the balance estimate, never a limit.
      if (this.deps.quota && record.createdBy && todo.length) {
        const usdPerClip = videoEngine?.provider === 'openrouter' ? await this.deps.openRouter?.usdPerClip(videoEngine.model).catch(() => null) : null;
        await this.deps.quota.check(record.createdBy, videoEngine?.provider === 'openrouter'
          ? (typeof usdPerClip === 'number' ? { openrouterUsd: todo.length * usdPerClip } : {})
          : videoEngine?.provider === 'axcel' ? {} : { flowCredits: todo.length * CREDITS_PER_SHOT });
      }
      // If the gate refuses midway (another request took the last room), the clips already queued stay tracked and the
      // others fail with the quota message: no job is ever left running that the project does not know about.
      let quotaStop: QuotaError | undefined;
      let queued = 0;
      for (const state of todo) {
        if (quotaStop) { Object.assign(state, { status: 'failed', error: quotaStop.message, lastError: quotaStop.message }); continue; }
        try { await this.queueShot(record, board, state.id, options.force ? { force: true } : {}); queued += 1; } catch (error) {
          if (!(error instanceof QuotaError)) throw error;
          if (!queued) throw error;
          quotaStop = error;
          Object.assign(state, { status: 'failed', error: error.message, lastError: error.message });
        }
      }
      // A second render while rendering widens the run instead of replacing it.
      const previous = record.status === 'rendering' ? [...this.runIds(record)] : [];
      record.run = { shots: record.shots.map(s => s.id).filter(sid => ids.has(sid) || previous.includes(sid)) };
      record.status = 'rendering';
      record.error = undefined;
      const queue = videoEngine?.provider === 'axcel' ? `Axcel (${videoEngine.model})` : videoEngine?.provider === 'openrouter' ? 'OpenRouter' : 'Flow';
      await this.save(record, todo.length ? `${queued} shot masuk antrean ${queue}` : undefined);
      if (quotaStop) throw quotaStop;
      return record;
    });
  }

  async retry(id: string): Promise<StoryRecord> {
    let ids: string[] = [];
    const record = await this.withLock(id, async () => {
      const r = await this.require(id);
      // Retry the last run plus anything that failed; never spends on scenes the user did not run.
      const run = this.runIds(r);
      // A shot Flow refused on several accounts needs an edit first: retrying it would only spend takes.
      ids = r.shots.filter(s => !s.needsEdit && (run.has(s.id) || s.status === 'failed' || s.frame?.status === 'failed')).map(s => s.id);
      // One new take per failed shot: its attempts are kept (not zeroed), so the next failure ends it again.
      for (const s of r.shots) if (s.status === 'failed' && !s.needsEdit) { s.status = 'pending'; s.attempts = Math.max(s.attempts, MAX_TAKES - 1); s.error = undefined; }
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

  /**
   * Records a "did not create the video" refusal of a Flow clip and says whether enough DIFFERENT accounts refused it.
   * A refusal on an account that is (nearly) out of credits is not about the prompt, and the same account twice proves nothing.
   */
  private async refusedEverywhere(state: ShotState, job: FlowJob): Promise<boolean> {
    if (!FLOW_REFUSED.test(job.error ?? '') || !job.accountId) return false;
    const account = await this.deps.flow.getAccount(job.accountId);
    if (!account || (account.credits !== undefined && account.credits < 2 * CREDITS_PER_SHOT)) return false;
    state.refusedBy = [...new Set([...(state.refusedBy ?? []), account.id])];
    return state.refusedBy.length >= REFUSAL_ACCOUNTS;
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
        if (job?.status === 'done' && job.resultPath && existsSync(job.resultPath) && await this.mayReuse(job, record.createdBy, record.id)) {
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
        if ((await this.rejectTake(state, 'Job Flow hilang')) === 'requeue') await this.requeueShot(record, board, state);
        changed = true;
        continue;
      }
      if (job.status === 'queued' || job.status === 'running') {
        state.jobPhase = job.status;
        state.jobStartedAtMs = job.startedAtMs ?? job.createdAtMs;
      }
      if (job.status === 'failed') {
        if (job.cancelled) {
          // An operator stopped this job: final, no attempt burnt, no new take.
          state.status = 'failed';
          state.error = job.error;
          state.lastError = job.error;
        } else if (OUTAGE.test(job.error ?? '')) {
          // The model is down: more takes, or the other clips of this run, would only hit the same wall.
          state.attempts += 1;
          state.status = 'failed';
          state.lastError = job.error;
          state.error = job.error;
          outage = job.error;
        } else if (await this.refusedEverywhere(state, job)) {
          // Flow said no on several accounts that could pay: more takes of the same prompt would only repeat it.
          state.attempts += 1;
          state.status = 'failed';
          state.needsEdit = true;
          state.lastError = job.error;
          state.error = `Flow menolak membuat klip ini di ${state.refusedBy!.length} akun berbeda (bukan karena kredit): ubah dulu prompt atau keyframe shot ini, lalu render lagi`;
        } else if ((await this.rejectTake(state, job.error ?? 'Flow gagal')) === 'requeue') await this.requeueShot(record, board, state);
        changed = true;
        continue;
      }
      if (job.status !== 'done' || !job.resultPath) continue;
      const target = this.shotPath(record.id, state.id);
      await linkOrCopy(job.resultPath, target);
      const reason = await this.qc(target, isSilent(board, shot));
      if (reason) {
        await rm(target, { force: true });
        if ((await this.rejectTake(state, reason)) === 'requeue') await this.requeueShot(record, board, state);
      } else {
        state.status = 'done';
        state.durationSec = (await this.deps.probe(target)).durationSec;
        state.lastError = undefined;
        state.refusedBy = undefined;
        // cepat: the clip is the only enforcement point (spec §9.3) — sample it and audit it now.
        if (record.mode !== 'konsisten') changed = (await this.auditClip(record, board, state, shot, target)) || changed;
        // motion QC (free, never queues a render): after the audit, which may re-queue the clip itself
        await this.checkMotion(record, board, state, shot);
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
    const dubs = await this.deps.dub?.for(record.id);
    const dubbed = dubs && Object.keys(dubs.shots).length > 0 ? dubs : undefined;
    const plan = {
      ...board,
      slug: 'final',
      // The subtitle line of each shot travels with it (bible shots keep it on the intent); a fresh dub too.
      shots: board.shots.map(s => ({
        ...(s.reuse ? { ...s, reuse: { file: join(dir, `${s.id}.mp4`), start: s.reuse.start ?? 0 } } : s),
        narration: subtitleOf(s),
        ...(dubbed?.shots[s.id] ? { dub: dubbed.shots[s.id] } : {})
      })),
      edit: board.edit || dubbed?.keepAmbient ? {
        ...(board.edit?.clipVolume !== undefined ? { clipVolume: board.edit.clipVolume } : {}),
        ...(board.edit?.fadeIn !== undefined ? { fadeIn: board.edit.fadeIn } : {}),
        ...(board.edit?.beatCuts ? { beatCuts: board.edit.beatCuts.zoom !== undefined ? { zoom: board.edit.beatCuts.zoom } : {} } : {}),
        ...(board.edit?.subtitles ? { subtitles: true } : {}),
        ...(board.edit?.subtitles && board.edit.subtitleStyle ? { subtitleStyle: board.edit.subtitleStyle } : {}),
        ...(board.edit?.subtitles && board.edit.subtitleSize !== undefined ? { subtitleSize: board.edit.subtitleSize } : {}),
        ...(board.edit?.subtitles && board.edit.subtitleY !== undefined ? { subtitleY: board.edit.subtitleY } : {}),
        ...(board.edit?.subtitles && board.edit.subtitleKaraoke === false ? { subtitleKaraoke: false } : {}),
        ...(music ? { music: { path: join(dir, music.file), volume: music.volume, at: music.at, ...(music.from ? { from: music.from } : {}) } } : {}),
        ...(dubbed?.keepAmbient ? { dubKeepAmbient: true } : {})
      } : undefined
    };
    await this.writeJson(join(dir, 'assemble.json'), plan);
  }

  /** Advance one story as far as possible. Safe to call any time, any number of times. */
  async reconcile(id: string, opts: { wait?: boolean } = {}): Promise<StoryRecord | undefined> {
    // Being assembled right now by this process: nothing to advance, and nothing may wait for it or start a second one.
    if (this.assembling.has(id)) return this.get(id);
    let job: Promise<void> | undefined;
    const record = await this.withLock(id, async () => {
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
        record.warnings = await this.dubWarnings(id);
        record.status = 'assembling';
        record.videoStale = undefined; // same as beginAssembly: stale from here on means "changed after this cut started"
        await this.save(record, 'Semua shot siap, merakit video');
      }
      // "assembling" with no job in this process = the server restarted mid-assembly: run it again.
      if (!this.assembling.has(id)) job = this.launchAssembly(record, board);
      return record;
    });
    // `wait: false` (the page's polling GET, the timer): hand back at once, the assembly goes on in the background.
    // Default: wait for it, outside the lock, so callers that want the finished state still get it.
    if (job && opts.wait !== false) { await job; return (await this.get(id)) ?? record; }
    return record;
  }

  /** Rebuild final.mp4 from the current order. Needs every shot done; free (no Flow). Resolves when the video exists. */
  async assemble(id: string, opts: { rev?: number } = {}): Promise<StoryRecord> {
    return this.withLock(id, async () => {
      const { record, board } = await this.beginAssembly(id, opts);
      return this.runAssembly(record, board, true);
    });
  }

  /**
   * Same, but returns at once with the story "assembling" and finishes in the background: a request must not stay
   * open for minutes while the assembly waits its turn in the shared queue. `settle(id)` waits for the end (tests).
   */
  async startAssembly(id: string, opts: { rev?: number } = {}): Promise<StoryRecord> {
    // A second click while one is running must be refused at once, not wait for the lock and then assemble again.
    if (this.assembling.has(id)) throw new StoryError('BUSY', 'Story sedang diproses');
    const { record, board } = await this.withLock(id, () => this.beginAssembly(id, opts));
    this.launchAssembly(record, board);
    return { ...record };
  }

  /**
   * Runs the assembly in the background, one job per story, WITHOUT holding the story lock: an assembly takes minutes and
   * the page polls the story every few seconds (GET reconciles), so none of that may wait for it. Other changes are kept
   * out by the "assembling" status, and the job only takes the lock for its own short writes.
   */
  private launchAssembly(record: StoryRecord, board: Storyboard): Promise<void> {
    const id = record.id;
    const job: Promise<void> = this.runAssembly(record, board, false).then(() => undefined, () => undefined).finally(() => { if (this.assembling.get(id) === job) this.assembling.delete(id); });
    this.assembling.set(id, job);
    return job;
  }

  async settle(id: string): Promise<void> {
    await this.assembling.get(id);
  }

  /** `dub-basi:<shot>` for every shot that has text but no fresh dub in a project that already has dubs (undefined = nothing to say). */
  private async dubWarnings(id: string): Promise<string[] | undefined> {
    const stale = (await this.deps.dub?.for(id).catch(() => undefined))?.staleShots;
    return stale?.length ? stale.map(shot => `dub-basi:${shot}`) : undefined;
  }

  private async beginAssembly(id: string, opts: { rev?: number }): Promise<{ record: StoryRecord; board: Storyboard }> {
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
    record.warnings = await this.dubWarnings(id);
    record.status = 'assembling';
    record.error = undefined;
    // From here on "stale" means: changed AFTER this cut started (a dub edited meanwhile), so it is set again by that change.
    record.videoStale = undefined;
    await this.save(record, 'Merakit ulang video');
    return { record, board };
  }

  /** The dubbing (or anything else outside the board) changed what the video should contain: "assemble again". */
  async markVideoStale(id: string): Promise<void> {
    await this.withLock(id, async () => {
      const record = await this.get(id);
      if (!record || !record.video || record.videoStale) return;
      record.videoStale = true;
      if (!BUSY_STATUSES.includes(record.status)) record.status = idleStatus(record);
      await this.save(record, 'Dubbing berubah: rakit ulang video');
    });
  }

  private async runAssembly(record: StoryRecord, board: Storyboard, locked: boolean): Promise<StoryRecord> {
    const id = record.id;
    const backup = `${this.videoPath(id)}.prev`;
    // The blocking path already holds the lock; the background path takes it only for its own short writes, on the
    // freshest record (a dub edited meanwhile must not be overwritten by this job's older copy).
    const exclusive = async <T>(fn: (fresh: StoryRecord) => Promise<T>): Promise<T> => {
      const run = async () => fn((await this.get(id)) ?? record);
      return locked ? run() : this.withLock(id, run);
    };
    let note: Promise<unknown> = Promise.resolve();
    try {
      await this.writeAssemblyPlan(record, board);
      // Keep the previous cut until the new one exists: a failed re-assembly must not lose it.
      if (existsSync(this.videoPath(id))) await rename(this.videoPath(id), backup);
      // Waiting for a free assembler is written to the activity log, so the page shows "antre" instead of freezing.
      await this.deps.assemble(this.storyDir(id), {
        owner: record.createdBy ?? id,
        onPosition: (position, total) => {
          if (position <= 1 && total <= 1) return;
          note = note.then(() => exclusive(fresh => this.save(fresh, `Antre perakitan: urutan ${position} dari ${total}`))).catch(() => undefined);
        }
      });
      await note;
      const info = await stat(this.videoPath(id));
      return await exclusive(async fresh => {
        fresh.status = 'done';
        fresh.video = { bytes: info.size, finishedAtMs: Date.now() };
        fresh.error = undefined;
        fresh.gate = undefined;
        await rm(backup, { force: true });
        // videoStale is whatever a change made during the cut left it: then the story is "assemble again", not done
        if (fresh.videoStale) fresh.status = idleStatus(fresh);
        await this.save(fresh, 'Video selesai');
        return fresh;
      });
    } catch (error) {
      await note.catch(() => undefined);
      return exclusive(async fresh => {
        if (existsSync(backup)) await rename(backup, this.videoPath(id)).catch(() => undefined);
        else { await rm(this.videoPath(id), { force: true }); fresh.video = undefined; }
        fresh.status = 'failed';
        fresh.videoStale = fresh.video ? true : undefined; // the kept video is behind the board
        fresh.error = `Perakitan gagal: ${error instanceof Error ? error.message : String(error)}`.slice(0, 600);
        await this.save(fresh, fresh.error);
        return fresh;
      });
    }
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
    if (job?.cancelled) {
      Object.assign(take, { status: 'failed', error: job.error, lastError: job.error });
      return true;
    }
    if (!job || job.status === 'failed') {
      if ((await this.rejectTake(take, job?.error ?? 'Job Flow hilang')) === 'requeue') await this.requeueTake(take, requeue);
      return true;
    }
    if (job.status !== 'done' || !job.resultPath) return false;
    await linkOrCopy(job.resultPath, target);
    const reason = await qc(target);
    if (reason) {
      await rm(target, { force: true });
      if ((await this.rejectTake(take, reason)) === 'requeue') await this.requeueTake(take, requeue);
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
    // The audit is OpenRouter money of the project's owner: held before the call, settled with the real cost after it.
    let hold: { commit: (actualUsd?: number) => Promise<void>; release: () => Promise<void> } | undefined;
    if (this.deps.quota) {
      try { hold = await this.deps.quota.audit(record.createdBy, `audit:${record.id}:${shot.id}:${randomBytes(4).toString('hex')}`); } catch (error) {
        if (!(error instanceof QuotaError)) throw error;
        record.events = [...record.events, { atMs: Date.now(), message: `Audit dilewati: ${error.message}`.slice(0, 300) }].slice(-60);
        return undefined;
      }
    }
    try {
      const result = await audit.run({ images: images.slice(0, MAX_AUDIT_IMAGES), expectation: this.expectation(board, shot), model });
      await hold?.commit(result.costUsd).catch(() => undefined);
      return { score: result.score, dimensions: result.dimensions, issues: result.issues, repair: result.repair, model, atMs: Date.now(), costUsd: result.costUsd };
    } catch (error) {
      // A parse failure still cost money (the model answered); anything else never reached a bill.
      if (error instanceof AuditParseError) await hold?.commit(undefined).catch(() => undefined); else await hold?.release().catch(() => undefined);
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
      const before = state.frame;
      state.frame = { status: 'pending', attempts: 0 };
      try {
        await this.queueFrame(record, board, state.id);
      } catch (error) {
        if (!(error instanceof QuotaError)) throw error;
        // The keyframe itself is usable (it only failed the audit): a human decides, with the quota message in the log.
        state.frame = before;
        state.needsReview = true;
        record.events = [...record.events, { atMs: Date.now(), message: `Perbaikan otomatis keyframe ${state.id} dilewati: ${error.message}`.slice(0, 300) }].slice(-60);
      }
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
    try {
      await this.queueShot(record, board, state.id);
    } catch (error) {
      if (!(error instanceof QuotaError)) throw error;
      // The clip itself is fine (it only failed the audit): a human decides, with the quota message in the log.
      state.status = 'done';
      state.needsReview = true;
      record.events = [...record.events, { atMs: Date.now(), message: `Perbaikan otomatis ${state.id} dilewati: ${error.message}`.slice(0, 300) }].slice(-60);
    }
    state.auditRepair = undefined;
    return true;
  }

  /** The take a motion verdict belongs to. */
  private motionKey(state: ShotState): string {
    return state.jobId ?? state.promptHash ?? '';
  }

  /** A verdict of a clip that is gone (re-queued, replaced, failed) must not show on its successor, nor keep its flag. */
  private dropStaleMotion(record: StoryRecord): void {
    for (const s of record.shots) {
      if (s.motionJobId === undefined && !s.motion) continue;
      if (s.status === 'done' && s.motionJobId === this.motionKey(s)) continue;
      s.motion = undefined;
      s.motionJobId = undefined;
      if (s.motionReview) { s.needsReview = undefined; s.motionReview = undefined; }
    }
  }

  private motionInput(record: StoryRecord, board: Storyboard, state: ShotState, shot: Shot): MotionInput {
    const frame = this.framePath(record.id, state.id);
    // konsisten: the clip must open on its approved keyframe (unverified on real clips: only synthetic tests).
    const keyframe = record.mode === 'konsisten' && state.frame?.status === 'done' && existsSync(frame) ? frame : undefined;
    return {
      file: this.shotPath(record.id, state.id),
      move: shot.intent?.move?.trim() ?? '',
      look: lookFor(board).family,
      ...(keyframe ? { keyframe } : {}),
      ...(typeof shot.zoom === 'number' && shot.zoom > 1 ? { zoom: shot.zoom } : {})
    };
  }

  /** Never throws: a checker that is missing, crashes or times out simply gives no verdict. */
  private async askMotion(input: MotionInput): Promise<MotionVerdict | undefined> {
    try {
      return await this.deps.motion?.check(input);
    } catch {
      return undefined;
    }
  }

  private note(record: StoryRecord, message: string): void {
    record.events = [...record.events, { atMs: Date.now(), message: message.slice(0, 200) }].slice(-60);
  }

  private applyMotion(record: StoryRecord, state: ShotState, v: MotionVerdict, gate: boolean): void {
    state.motion = {
      status: v.status, score: v.score, reasons: v.reasons, at: Date.now(),
      ...(v.suggest && Object.keys(v.suggest).length ? { suggest: v.suggest } : {})
    };
    state.motionJobId = this.motionKey(state);
    if (!gate) return;
    // Only a failing verdict asks for a human, through the same flag the audit uses. Never a re-render.
    if (v.status === 'fail') {
      state.needsReview = true;
      state.motionReview = true;
    } else if (state.motionReview) {
      state.needsReview = undefined;
      state.motionReview = undefined;
    }
    if (v.status !== 'ok') this.note(record, `Cek gerak ${state.id}: ${v.reasons[0] ?? (v.status === 'fail' ? 'perlu dicek' : 'ada catatan')}${v.reasons.length > 1 ? ` (+${v.reasons.length - 1} lagi)` : ''}`);
  }

  /** collect(): a clip just came in. Free; flags a failing shot for a human; NEVER queues or spends. */
  private async checkMotion(record: StoryRecord, board: Storyboard, state: ShotState, shot: Shot): Promise<void> {
    if (!this.deps.motion || state.status !== 'done' || state.motionJobId === this.motionKey(state)) return;
    const verdict = await this.askMotion(this.motionInput(record, board, state, shot));
    if (!verdict) {
      this.note(record, `Cek gerak ${state.id} dilewati: tidak bisa dijalankan (klip tetap dipakai)`);
      return;
    }
    this.applyMotion(record, state, verdict, true);
  }

  /**
   * Backfill (admin): check the done clips that have no verdict for their take. Free. Idempotent. It stores the
   * verdicts only — a finished project is never gated behind a new check — and it does not hold the story lock while
   * the checks run (they take a second each): it reads under the lock, checks outside, and merges under the lock.
   */
  async checkMotions(id: string): Promise<MotionBackfill> {
    if (!this.deps.motion) throw new StoryError('INVALID', 'Cek gerak belum tersedia di server ini');
    const running = this.motionRuns.get(id);
    if (running) return running;
    const run = this.runMotionBackfill(id).finally(() => { this.motionRuns.delete(id); });
    this.motionRuns.set(id, run);
    return run;
  }

  private async runMotionBackfill(id: string): Promise<MotionBackfill> {
    const { items, skipped } = await this.withLock(id, async () => {
      const record = await this.require(id);
      const board = await this.readStoryboard(id);
      const items: Array<{ id: string; key: string; input: MotionInput }> = [];
      let skipped = 0;
      for (const state of record.shots) {
        const shot = board.shots.find(x => x.id === state.id);
        if (!shot || state.status !== 'done' || !existsSync(this.shotPath(id, state.id))) continue;
        if (state.motionJobId === this.motionKey(state)) { skipped += 1; continue; }
        items.push({ id: state.id, key: this.motionKey(state), input: this.motionInput(record, board, state, shot) });
      }
      return { items, skipped };
    });
    const verdicts = new Map<string, { key: string; verdict: MotionVerdict }>();
    let unavailable = 0;
    for (const item of items) {
      const verdict = await this.askMotion(item.input);
      if (verdict) verdicts.set(item.id, { key: item.key, verdict }); else unavailable += 1;
    }
    if (verdicts.size) {
      await this.withLock(id, async () => {
        const record = await this.require(id);
        let stored = 0;
        let bad = 0;
        for (const state of record.shots) {
          const got = verdicts.get(state.id);
          // The take may have changed while we were checking: a verdict is only stored for the take it was made for.
          if (!got || state.status !== 'done' || this.motionKey(state) !== got.key || state.motionJobId === got.key) continue;
          this.applyMotion(record, state, got.verdict, false);
          stored += 1;
          if (got.verdict.status !== 'ok') bad += 1;
        }
        if (stored) await this.save(record, `Cek gerak ${stored} klip: ${bad ? `${bad} perlu perhatian` : 'semua baik'}`);
      });
    }
    return { checked: verdicts.size, skipped, unavailable };
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
        // A sign-off covers what the human saw: a failing motion verdict made after it blocks again.
        const motionAfter = s.motion?.status === 'fail' && typeof s.approvedAtMs === 'number' && s.motion.at > s.approvedAtMs;
        if (typeof s.approvedAtMs === 'number' && s.audit && s.approvedAtMs >= s.audit.atMs && !motionAfter) return false;
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
      state.motionReview = undefined;
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
      try { await this.reconcile(id, { wait: false }); } catch (error) { console.error(`[stories] reconcile ${id}:`, error); }
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
