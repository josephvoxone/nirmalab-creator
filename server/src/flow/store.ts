import { randomBytes } from 'node:crypto';
import { appendFile, chmod, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivateJsonFile } from '../lib/private-json-file.js';
import { isModelId, type ProviderId } from '../providers/config.js';
import { AXCEL_MODELS, isAxcelModel } from '../providers/axcel.js';
import { CREDITS_PER_SHOT } from '../stories/storyboard.js';

export type FlowAccountStatus = 'ready' | 'cooldown' | 'error';

export type FlowAccount = {
  id: string;
  label: string;
  email: string;
  profileDir?: string;
  proxy?: string;
  status: FlowAccountStatus;
  creditsUsedToday: number;
  dayStamp: string;
  cooldownUntilMs?: number;
  lastUsedAtMs?: number;
  lastError?: string;
  credits?: number;
  createdAtMs: number;
  /** Disabled accounts never take jobs (absent in old files = enabled). */
  enabled: boolean;
  /** Lower = preferred when the pool rotation is 'priority'. */
  priority: number;
  /** Flow credits this account may spend per day (UTC+8); undefined = unlimited. */
  dailyCreditCap?: number;
  /** First paid claim of the current credit cycle: Google refills a free account 24 h after it. */
  cycleStartMs?: number;
  /** Flow refused a clip on this account while its credits were low: no paid work until it refills. */
  exhaustedAtMs?: number;
};

/** Google Flow (free accounts): 50 credits a day, refreshed 24 h after the cycle's first generation. */
export const REFILL_MS = 24 * 3_600_000;
/** A credit jump this big is the daily refill (a re-credited failed clip adds only one clip's cost). */
const REFILL_JUMP = 30;
/** Flow's answer when it will not render a clip on an account that is out of credits. */
const REFUSED_FOR_CREDITS = /did not create the video|not enough credits|insufficient credits|out of credits/i;

/** When this account's credits come back (estimate), or undefined when no cycle is running. */
export function refillAtMs(account: Pick<FlowAccount, 'cycleStartMs'>): number | undefined {
  return account.cycleStartMs ? account.cycleStartMs + REFILL_MS : undefined;
}

/** Start of the account's current credit cycle: the stored start or an earlier paid clip in the last 24 h. */
function cycleStartOf(account: FlowAccount, jobs: FlowJob[], now: number): number | undefined {
  const starts = jobs
    .filter(j => j.accountId === account.id && jobCredits(j.kind) > 0 && j.startedAtMs && now - j.startedAtMs < REFILL_MS)
    .map(j => j.startedAtMs!);
  if (account.cycleStartMs && now - account.cycleStartMs < REFILL_MS) starts.push(account.cycleStartMs);
  return starts.length ? Math.min(...starts) : undefined;
}

/** Whether the account can pay for a job of this cost now (unknown credits never block). */
function canPay(account: FlowAccount, cost: number): boolean {
  if (cost <= 0) return true;
  if (account.exhaustedAtMs) return false;
  return account.credits === undefined || account.credits >= cost;
}

export type FlowQueueStatus = {
  running: number;
  queued: number;
  /** Paid clips that no account can pay for right now: they start on their own after a refill. */
  waitingForCredits: number;
  resumeAtMs: number | null;
  accounts: Array<{ id: string; label: string; credits: number | null; exhausted: boolean; refillAtMs: number | null }>;
};

export type FlowRotation = 'round-robin' | 'least-used' | 'priority';
export const FLOW_ROTATIONS: readonly FlowRotation[] = ['round-robin', 'least-used', 'priority'];
export type FlowPool = { rotation: FlowRotation };
const DEFAULT_POOL: FlowPool = { rotation: 'least-used' };

/** Bad input to a store mutation (routes map it to 400). */
export class FlowInputError extends Error {}

export type FlowAccountPatch = { label?: string; enabled?: boolean; priority?: number; dailyCreditCap?: number | null };

/** Flow credits a job of this kind costs: videos ≈ CREDITS_PER_SHOT, stills and character sheets are free. */
export function jobCredits(kind: FlowJobKind): number {
  return kind === 'video' ? CREDITS_PER_SHOT : 0;
}

export type FlowJobStatus = 'queued' | 'running' | 'done' | 'failed';

export type FlowJobKind = 'video' | 'image' | 'character';
export type FlowCharacterRef = { name: string; look: string };
export type FlowJobResult = { mediaId?: string; caption?: string; flowCharacterId?: string; costUsd?: number };

export type FlowJob = {
  id: string;
  /** video = clip, image = keyframe still, character = reference sheet + Flow character. */
  kind: FlowJobKind;
  /** Jobs of one group (a story) run on one account: Flow characters/frames live in that account's project. */
  group?: string;
  /** Characters to ensure in the project and attach as ingredients (consistency). */
  characters?: FlowCharacterRef[];
  /** Keyframe to animate (image-to-video): a media in the same Flow project. */
  startFrame?: { mediaId: string; caption: string };
  result?: FlowJobResult;
  prompt: string;
  technique?: string;
  aspect: '9:16' | '16:9';
  durationSec: number;
  status: FlowJobStatus;
  attempts: number;
  maxAttempts: number;
  createdAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  bridgeId?: string;
  accountId?: string;
  resultPath?: string;
  bytes?: number;
  /** Engine that renders the job: absent = 'flow' (the Mac bridge). */
  provider?: ProviderId;
  /** OpenRouter model id (provider 'openrouter'). */
  model?: string;
  /** OpenRouter: absolute paths of reference images (cast sheets) sent as input_references. */
  references?: string[];
  /** Keyframe file on the server: OpenRouter/Axcel send it as first frame; a Flow clip carries it so
   *  another account can upload it into its own project (round-robin) when the pinned one is out of credits. */
  startImage?: string;
  /** Axcel video: output height (480/720/1080); absent = the worker's default. */
  resolution?: number;
  /** OpenRouter generation id of a submitted video (resumed after a restart). */
  remoteId?: string;
  error?: string;
  /** Stopped by an operator (`cancelJob`): final, never re-taken by a story. */
  cancelled?: true;
  /** User id that queued the job (directly or through a story). */
  createdBy?: string;
};

type Counts = { jobs: number; done: number; failed: number; credits: number };
export type FlowUsageReport = {
  range: { from: string; to: string; days: number };
  totals: { jobs: number; done: number; failed: number; running: number; queued: number; credits: number };
  byDay: Array<{ date: string } & Counts>;
  byAccount: Array<{
    accountId: string; label: string; enabled: boolean; deleted?: true;
    dailyCreditCap?: number; creditsUsedToday: number; creditsRemaining?: number; lastUsedAtMs?: number;
  } & Counts>;
  byKind: Record<FlowJobKind, { jobs: number; done: number; credits: number }>;
  byMember: Array<{ userId: string; jobs: number; done: number; credits: number }>;
};

type FlowState = {
  version: 1;
  accounts: FlowAccount[];
  jobs: FlowJob[];
  bridge?: FlowBridgeState;
  /** group -> account that owns it */
  groupAccounts?: Record<string, string>;
  pool?: FlowPool;
};

export type FlowBridgeState = {
  bridgeId: string;
  lastSeenMs: number;
};

const BRIDGE_ONLINE_MS = 90_000;
/** Longest a claimed job may run without a result before it is re-queued. */
const JOB_LEASE_MS = 25 * 60_000;

const EMPTY: FlowState = { version: 1, accounts: [], jobs: [] };
/**
 * Finished (done/failed) jobs kept in flow.json. Queued and running jobs are never counted or cut: the window used
 * to cut by position, so 500 newer stills of other users pushed a waiting clip out and its story burnt a take.
 */
const MAX_JOBS = 500;
/** Finished jobs cut from flow.json move to `flow-history.jsonl` (usage reports, reuse of old clips read them). */
const HISTORY_FILE = 'flow-history.jsonl';
const HISTORY_MAX_BYTES = 8 * 1024 * 1024;
const HISTORY_KEEP_MS = 100 * 86_400_000;

const isActive = (job: FlowJob): boolean => job.status === 'queued' || job.status === 'running';

/** Business day stamp (YYYY-MM-DD) in Asia/Makassar (UTC+8, no DST): daily usage resets at local midnight. */
const DAY_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
export function flowDay(ms: number): string {
  return new Date(ms + DAY_OFFSET_MS).toISOString().slice(0, 10);
}
/** UTC epoch ms of local (UTC+8) midnight starting the given day stamp. */
function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) - DAY_OFFSET_MS;
}

function today(): string {
  return flowDay(Date.now());
}

/**
 * Give back the credits charged when `job` was claimed (the claim is being undone: failure, lease expiry, orphan).
 * Only when that claim was charged TODAY (Asia/Makassar): after midnight the counter already restarted, and
 * subtracting yesterday's charge would erase today's work (or go negative).
 */
function refundClaim(account: FlowAccount | undefined, job: FlowJob): void {
  const cost = jobCredits(job.kind);
  if (!account || cost <= 0 || account.dayStamp !== today()) return;
  if (job.startedAtMs !== undefined && flowDay(job.startedAtMs) !== today()) return;
  account.creditsUsedToday = Math.max(0, account.creditsUsedToday - cost);
}

function loadAccount(raw: FlowAccount): FlowAccount {
  const account: FlowAccount = {
    ...raw,
    enabled: raw.enabled !== false,
    priority: Number.isInteger(raw.priority) ? raw.priority : 0
  };
  if (typeof account.dailyCreditCap !== 'number' || !Number.isFinite(account.dailyCreditCap) || account.dailyCreditCap < 0) {
    delete account.dailyCreditCap;
  }
  return account;
}

function loadPool(raw: unknown): FlowPool {
  const rotation = (raw as Partial<FlowPool> | undefined)?.rotation;
  return rotation && FLOW_ROTATIONS.includes(rotation) ? { rotation } : { ...DEFAULT_POOL };
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

/** Pool order among accounts (eligibility is checked separately). Stable for ties. */
function orderAccounts(accounts: FlowAccount[], rotation: FlowRotation): FlowAccount[] {
  const lastUsed = (a: FlowAccount) => a.lastUsedAtMs ?? 0;
  const leastUsed = (a: FlowAccount, b: FlowAccount) => a.creditsUsedToday - b.creditsUsedToday || lastUsed(a) - lastUsed(b);
  const compare: Record<FlowRotation, (a: FlowAccount, b: FlowAccount) => number> = {
    'round-robin': (a, b) => lastUsed(a) - lastUsed(b),
    'least-used': leastUsed,
    priority: (a, b) => a.priority - b.priority || leastUsed(a, b)
  };
  return [...accounts].sort(compare[rotation]);
}

export class FlowStore {
  private readonly path: string;
  private readonly historyPath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, 'flow.json');
    this.historyPath = join(dataDir, HISTORY_FILE);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<FlowState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<FlowState>;
      return {
        version: 1,
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts.map(loadAccount) : [],
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs.map(j => ({ ...j, kind: j.kind ?? 'video' })) : [],
        ...(parsed.bridge === undefined ? {} : { bridge: parsed.bridge }),
        ...(parsed.groupAccounts === undefined ? {} : { groupAccounts: parsed.groupAccounts }),
        ...(parsed.pool === undefined ? {} : { pool: loadPool(parsed.pool) })
      };
    } catch {
      return { ...EMPTY, accounts: [], jobs: [] };
    }
  }

  private async write(state: FlowState): Promise<void> {
    // Cut only the oldest FINISHED jobs; every queued/running job stays, in its place.
    const finished = state.jobs.filter(j => !isActive(j));
    const cut = new Set(finished.slice(0, Math.max(0, finished.length - MAX_JOBS)).map(j => j.id));
    if (cut.size === 0) return writePrivateJsonFile(this.path, state);
    await this.archive(state.jobs.filter(j => cut.has(j.id)));
    await writePrivateJsonFile(this.path, { ...state, jobs: state.jobs.filter(j => !cut.has(j.id)) });
  }

  /** Append finished jobs to the history file (0600); an old, big file is rewritten without the entries past 100 days. */
  private async archive(jobs: FlowJob[]): Promise<void> {
    try {
      await appendFile(this.historyPath, jobs.map(j => JSON.stringify(j)).join('\n') + '\n', { mode: 0o600 });
      await chmod(this.historyPath, 0o600).catch(() => undefined);
      if ((await stat(this.historyPath)).size > HISTORY_MAX_BYTES) {
        const cutoff = Date.now() - HISTORY_KEEP_MS;
        const keep = (await this.readHistory()).filter(j => (j.finishedAtMs ?? j.createdAtMs) >= cutoff);
        const tmp = `${this.historyPath}.tmp`;
        await writeFile(tmp, keep.map(j => JSON.stringify(j)).join('\n') + (keep.length ? '\n' : ''), { mode: 0o600 });
        await rename(tmp, this.historyPath);
      }
    } catch (error) {
      // History is a convenience: failing to keep it must never fail a claim or a completion.
      console.error('[flow] history archive failed', error instanceof Error ? error.message : error);
    }
  }

  private async readHistory(): Promise<FlowJob[]> {
    let text: string;
    try { text = await readFile(this.historyPath, 'utf8'); } catch { return []; }
    const jobs: FlowJob[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const j = JSON.parse(line) as FlowJob; if (j && typeof j.id === 'string') jobs.push({ ...j, kind: j.kind ?? 'video' }); } catch { /* a torn last line */ }
    }
    return jobs;
  }

  private normaliseAccount(account: FlowAccount): FlowAccount {
    const stamp = today();
    const used = account.dayStamp === stamp ? account.creditsUsedToday : 0;
    const cooling = (account.cooldownUntilMs ?? 0) > Date.now();
    return {
      ...account,
      creditsUsedToday: used,
      dayStamp: stamp,
      status: account.status === 'error' ? 'error' : cooling ? 'cooldown' : 'ready'
    };
  }

  async addAccount(input: { label: string; email: string; profileDir?: string; proxy?: string }): Promise<FlowAccount> {
    return this.serialize(async () => {
      const state = await this.read();
      const label = input.label.trim();
      if (!label) throw new Error('Account label is required');
      if (state.accounts.some(a => a.label.toLowerCase() === label.toLowerCase())) {
        throw new Error(`Duplicate account label: ${label}`);
      }
      const account: FlowAccount = {
        id: newId('acc'),
        label,
        email: input.email.trim(),
        status: 'ready',
        creditsUsedToday: 0,
        dayStamp: today(),
        createdAtMs: Date.now(),
        enabled: true,
        priority: 0,
        ...(input.profileDir === undefined ? {} : { profileDir: input.profileDir }),
        ...(input.proxy === undefined ? {} : { proxy: input.proxy })
      };
      state.accounts.push(account);
      await this.write(state);
      return account;
    });
  }

  async listAccounts(): Promise<FlowAccount[]> {
    const state = await this.read();
    return state.accounts.map(a => this.normaliseAccount(a));
  }

  async getAccount(id: string): Promise<FlowAccount | undefined> {
    return (await this.listAccounts()).find(a => a.id === id);
  }

  async updateAccount(id: string, patch: FlowAccountPatch): Promise<FlowAccount | undefined> {
    return this.serialize(async () => {
      const state = await this.read();
      const account = state.accounts.find(a => a.id === id);
      if (!account) return undefined;
      const next: FlowAccount = { ...account };
      if (patch.label !== undefined) {
        const label = typeof patch.label === 'string' ? patch.label.trim() : '';
        if (!label) throw new FlowInputError('Account label is required');
        if (label.length > 80) throw new FlowInputError('Account label is too long');
        if (state.accounts.some(a => a.id !== id && a.label.toLowerCase() === label.toLowerCase())) {
          throw new FlowInputError(`Duplicate account label: ${label}`);
        }
        next.label = label;
      }
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') throw new FlowInputError('enabled must be true or false');
        next.enabled = patch.enabled;
      }
      if (patch.priority !== undefined) {
        if (!Number.isInteger(patch.priority) || Math.abs(patch.priority) > 1000) {
          throw new FlowInputError('priority must be an integer between -1000 and 1000');
        }
        next.priority = patch.priority;
      }
      if (patch.dailyCreditCap === null) {
        delete next.dailyCreditCap;
      } else if (patch.dailyCreditCap !== undefined) {
        const cap = patch.dailyCreditCap;
        if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 0 || cap > 1_000_000) {
          throw new FlowInputError('dailyCreditCap must be a whole number ≥ 0 (or null for no cap)');
        }
        next.dailyCreditCap = cap;
      }
      Object.assign(account, next);
      if (!('dailyCreditCap' in next)) delete account.dailyCreditCap;
      await this.write(state);
      return this.normaliseAccount(account);
    });
  }

  async getPool(): Promise<FlowPool> {
    return loadPool((await this.read()).pool);
  }

  async setPool(input: { rotation: FlowRotation }): Promise<FlowPool> {
    if (!FLOW_ROTATIONS.includes(input.rotation)) {
      throw new FlowInputError(`rotation must be one of ${FLOW_ROTATIONS.join(', ')}`);
    }
    return this.serialize(async () => {
      const state = await this.read();
      state.pool = { rotation: input.rotation };
      await this.write(state);
      return { ...state.pool };
    });
  }

  async getJob(id: string): Promise<FlowJob | undefined> {
    const state = await this.read();
    const live = state.jobs.find(j => j.id === id);
    if (live) return live;
    // A finished job cut from flow.json: reuse of an old clip and reports still find it.
    return (await this.readHistory()).findLast(j => j.id === id);
  }

  async heartbeat(bridgeId: string, credits: Array<{ id: string; credits: number }>): Promise<void> {
    await this.serialize(async () => {
      const state = await this.read();
      state.bridge = { bridgeId: bridgeId.slice(0, 80), lastSeenMs: Date.now() };
      for (const entry of credits) {
        const account = state.accounts.find(a => a.id === entry.id);
        if (!account || !Number.isFinite(entry.credits)) continue;
        const next = Math.max(0, Math.round(entry.credits));
        if (account.credits !== undefined && next - account.credits >= REFILL_JUMP) {
          // The daily refill: a new cycle starts with the next paid clip.
          delete account.exhaustedAtMs;
          delete account.cycleStartMs;
        }
        account.credits = next;
      }
      await this.write(state);
    });
  }

  async bridgeStatus(): Promise<{ bridgeId?: string; lastSeenMs?: number; online: boolean }> {
    const state = await this.read();
    if (!state.bridge) return { online: false };
    return { ...state.bridge, online: Date.now() - state.bridge.lastSeenMs < BRIDGE_ONLINE_MS };
  }

  async removeAccount(id: string): Promise<boolean> {
    return this.serialize(async () => {
      const state = await this.read();
      const before = state.accounts.length;
      state.accounts = state.accounts.filter(a => a.id !== id);
      if (state.accounts.length === before) return false;
      await this.write(state);
      return true;
    });
  }

  async coolDown(id: string, ms: number, error?: string): Promise<void> {
    await this.serialize(async () => {
      const state = await this.read();
      const account = state.accounts.find(a => a.id === id);
      if (!account) return;
      account.cooldownUntilMs = Date.now() + ms;
      account.lastUsedAtMs = Date.now();
      if (error !== undefined) account.lastError = error.slice(0, 300);
      account.status = 'ready';
      await this.write(state);
    });
  }

  async createJob(input: {
    prompt: string;
    technique?: string;
    aspect?: '9:16' | '16:9';
    durationSec?: number;
    maxAttempts?: number;
    kind?: FlowJobKind;
    group?: string;
    characters?: FlowCharacterRef[];
    startFrame?: { mediaId: string; caption: string };
    createdBy?: string;
    provider?: ProviderId;
    model?: string;
    references?: string[];
    startImage?: string;
    resolution?: number;
  }): Promise<FlowJob> {
    const openrouter = input.provider === 'openrouter';
    const axcel = input.provider === 'axcel';
    if (openrouter && !isModelId(input.model)) throw new FlowInputError('model is required for provider openrouter (e.g. google/veo-3.1-fast)');
    if (axcel && !isAxcelModel(input.model)) throw new FlowInputError(`model is required for provider axcel (one of: ${AXCEL_MODELS.join(', ')})`);
    return this.serialize(async () => {
      const state = await this.read();
      const prompt = input.prompt.trim();
      if (!prompt) throw new Error('Prompt is required');
      const job: FlowJob = {
        id: newId('job'),
        kind: input.kind ?? 'video',
        ...(input.group ? { group: input.group } : {}),
        ...(input.characters?.length ? { characters: input.characters.slice(0, 6).map(c => ({ name: c.name.slice(0, 40), look: c.look.slice(0, 600) })) } : {}),
        ...(input.startFrame ? { startFrame: input.startFrame } : {}),
        ...(!openrouter && !axcel && input.startImage ? { startImage: input.startImage } : {}),
        prompt: prompt.slice(0, 4000),
        aspect: input.aspect ?? '9:16',
        durationSec: Math.min(Math.max(Math.round(input.durationSec ?? 8), 4), 10),
        status: 'queued',
        attempts: 0,
        maxAttempts: Math.min(Math.max(input.maxAttempts ?? 3, 1), 5),
        createdAtMs: Date.now(),
        ...(input.technique === undefined ? {} : { technique: input.technique }),
        ...(input.createdBy ? { createdBy: input.createdBy.slice(0, 80) } : {}),
        ...(openrouter || axcel ? {
          provider: (openrouter ? 'openrouter' : 'axcel') as ProviderId,
          model: input.model!,
          ...(input.references?.length ? { references: input.references.slice(0, 8) } : {}),
          ...(input.startImage ? { startImage: input.startImage } : {}),
          ...(axcel && input.resolution && [480, 720, 1080].includes(input.resolution) ? { resolution: input.resolution } : {})
        } : {})
      };
      state.jobs.push(job);
      await this.write(state);
      return job;
    });
  }

  async listJobs(limit = 100): Promise<FlowJob[]> {
    const state = await this.read();
    return state.jobs
      .map((job, index) => ({ job, index }))
      .sort((a, b) => b.job.createdAtMs - a.job.createdAtMs || b.index - a.index)
      .slice(0, limit)
      .map(item => item.job);
  }

  /**
   * Claim the oldest queued job of one provider (default 'flow': the Mac bridge never sees
   * OpenRouter jobs). Flow claims pick an account (pool rotation, daily caps); OpenRouter claims don't.
   */
  async claimJob(bridgeId: string, options: { provider?: ProviderId } = {}): Promise<FlowJob | undefined> {
    const provider = options.provider ?? 'flow';
    const ofProvider = (j: FlowJob) => (j.provider ?? 'flow') === provider;
    return this.serialize(async () => {
      const state = await this.read();
      const now = Date.now();
      const day = today();
      let changed = false;
      // A bridge that died mid-job never reports back: expire its lease so the job is retried.
      for (const stale of state.jobs) {
        if (stale.status === 'running' && now - (stale.startedAtMs ?? now) > JOB_LEASE_MS) {
          // The claim charged the account; the clip never reported back, so it is charged again when re-claimed.
          refundClaim(stale.accountId ? state.accounts.find(a => a.id === stale.accountId) : undefined, stale);
          stale.attempts += 1;
          stale.error = 'Bridge lease expired (no result reported)';
          stale.status = stale.attempts >= stale.maxAttempts ? 'failed' : 'queued';
          stale.bridgeId = undefined;
          stale.accountId = undefined;
          if (stale.status === 'failed') stale.finishedAtMs = now;
          changed = true;
        }
      }
      // Bridges work one job at a time: if this bridge claims again, its running job was
      // orphaned by a restart. Put it back (no attempt burnt) instead of waiting out the lease.
      for (const orphan of state.jobs) {
        if (provider === 'flow' && ofProvider(orphan) && orphan.status === 'running' && orphan.bridgeId === bridgeId) {
          refundClaim(orphan.accountId ? state.accounts.find(a => a.id === orphan.accountId) : undefined, orphan);
          orphan.status = 'queued';
          orphan.bridgeId = undefined;
          orphan.accountId = undefined;
          orphan.startedAtMs = undefined;
          changed = true;
        }
      }
      if (provider !== 'flow') {
        const next = state.jobs.filter(j => j.status === 'queued' && ofProvider(j)).sort((a, b) => a.createdAtMs - b.createdAtMs)[0];
        if (!next) {
          if (changed) await this.write(state);
          return undefined;
        }
        Object.assign(next, { status: 'running', bridgeId, startedAtMs: now });
        delete next.accountId;
        await this.write(state);
        return next;
      }
      const ordered = orderAccounts(state.accounts.map(a => this.normaliseAccount(a)), loadPool(state.pool).rotation);
      const eligible = (a: FlowAccount, cost: number) =>
        a.status === 'ready' && a.enabled && (a.dailyCreditCap === undefined || a.creditsUsedToday + cost <= a.dailyCreditCap)
        && canPay(a, cost);
      const pins = state.groupAccounts ?? {};
      let account: FlowAccount | undefined;
      let job: FlowJob | undefined;
      for (const candidate of state.jobs.filter(j => j.status === 'queued' && ofProvider(j)).sort((a, b) => a.createdAtMs - b.createdAtMs)) {
        const cost = jobCredits(candidate.kind);
        const pinnedId = candidate.group ? pins[candidate.group] : undefined;
        const pinned = pinnedId ? ordered.find(a => a.id === pinnedId) : undefined;
        // A group waits for its own account (its Flow characters live there) unless that account was
        // disabled or deleted: then it moves, and the bridge recreates the characters on the new one.
        // A paid clip that carries its keyframe file can run on any account (the bridge uploads the
        // keyframe there): round-robin to an account that can still pay, without moving the group.
        const portable = cost > 0 && candidate.kind === 'video' && Boolean(candidate.startImage);
        const pick = pinned?.enabled
          ? (eligible(pinned, cost) ? pinned : portable ? ordered.find(a => eligible(a, cost)) : undefined)
          : ordered.find(a => eligible(a, cost));
        if (pick) { account = pick; job = candidate; break; }
      }
      if (!account || !job) {
        if (changed) await this.write(state);
        return undefined;
      }
      job.status = 'running';
      job.bridgeId = bridgeId;
      job.accountId = account.id;
      const travelling = job.group !== undefined && (state.groupAccounts ?? {})[job.group] !== undefined
        && job.kind === 'video' && Boolean(job.startImage) && (state.groupAccounts ?? {})[job.group] !== account.id;
      if (job.group && !travelling && (state.groupAccounts ?? {})[job.group] !== account.id) {
        state.groupAccounts = { ...(state.groupAccounts ?? {}), [job.group]: account.id };
      }
      job.startedAtMs = now;
      const stored = state.accounts.find(a => a.id === account.id);
      if (stored) {
        stored.creditsUsedToday = (stored.dayStamp === day ? stored.creditsUsedToday : 0) + jobCredits(job.kind);
        stored.dayStamp = day;
        stored.lastUsedAtMs = now;
        // The cycle began with the earliest paid clip of the last 24 h (this one when there is none).
        if (jobCredits(job.kind) > 0) stored.cycleStartMs = cycleStartOf(stored, state.jobs, now) ?? now;
      }
      await this.write(state);
      return job;
    });
  }

  async groupAccount(group: string): Promise<string | undefined> {
    return (await this.read()).groupAccounts?.[group];
  }

  /** What the Flow queue is doing: running clips, clips that wait for credits, and when they resume. */
  async queueStatus(): Promise<FlowQueueStatus> {
    const state = await this.read();
    const accounts = state.accounts.map(a => this.normaliseAccount(a)).filter(a => a.enabled);
    const flowJobs = state.jobs.filter(j => (j.provider ?? 'flow') === 'flow');
    const pins = state.groupAccounts ?? {};
    const payable = (a: FlowAccount, cost: number) => a.status !== 'error' && (a.dailyCreditCap === undefined || a.creditsUsedToday + cost <= a.dailyCreditCap) && canPay(a, cost);
    const waiting = flowJobs.filter(j => {
      const cost = jobCredits(j.kind);
      if (j.status !== 'queued' || cost === 0) return false;
      const pinned = j.group ? accounts.find(a => a.id === pins[j.group!]) : undefined;
      const portable = j.kind === 'video' && Boolean(j.startImage);
      const pool = pinned && !portable ? [pinned] : accounts;
      return !pool.some(a => payable(a, cost));
    });
    // They resume at the earliest refill of an account that could take them.
    const now = Date.now();
    const refillOf = (a: FlowAccount) => { const start = cycleStartOf(a, state.jobs, now); return start === undefined ? undefined : start + REFILL_MS; };
    const refills = accounts.filter(a => !canPay(a, CREDITS_PER_SHOT)).map(refillOf).filter((t): t is number => t !== undefined);
    return {
      running: flowJobs.filter(j => j.status === 'running').length,
      queued: flowJobs.filter(j => j.status === 'queued').length,
      waitingForCredits: waiting.length,
      resumeAtMs: waiting.length && refills.length ? Math.min(...refills) : null,
      accounts: accounts.map(a => ({ id: a.id, label: a.label, credits: a.credits ?? null, exhausted: Boolean(a.exhaustedAtMs), refillAtMs: refillOf(a) ?? null }))
    };
  }

  async usage(input: { days?: number; nowMs?: number } = {}): Promise<FlowUsageReport> {
    const state = await this.read();
    const live = new Set(state.jobs.map(j => j.id));
    state.jobs = [...(await this.readHistory()).filter(j => !live.has(j.id)), ...state.jobs];
    const days = Math.min(Math.max(Math.round(Number.isFinite(input.days) ? input.days! : 7), 1), 90);
    const to = flowDay(input.nowMs ?? Date.now());
    const fromMs = dayStartMs(to) - (days - 1) * DAY_MS;
    const toEndMs = dayStartMs(to) + DAY_MS;
    const from = flowDay(fromMs);
    const zero = (): Counts => ({ jobs: 0, done: 0, failed: 0, credits: 0 });
    const add = (c: { jobs: number; done: number; credits: number; failed?: number }, j: FlowJob) => {
      c.jobs += 1;
      if (j.status === 'done') { c.done += 1; c.credits += (j.provider ?? 'flow') === 'flow' ? jobCredits(j.kind) : 0; }
      if (j.status === 'failed' && c.failed !== undefined) c.failed += 1;
    };

    const byDay = new Map<string, Counts>();
    for (let d = 0; d < days; d += 1) byDay.set(flowDay(fromMs + d * DAY_MS), zero());
    const totals = { jobs: 0, done: 0, failed: 0, running: 0, queued: 0, credits: 0 };
    const byKind: FlowUsageReport['byKind'] = {
      video: { jobs: 0, done: 0, credits: 0 }, image: { jobs: 0, done: 0, credits: 0 }, character: { jobs: 0, done: 0, credits: 0 }
    };
    const accounts = state.accounts.map(a => this.normaliseAccount(a));
    const byAccount = new Map<string, FlowUsageReport['byAccount'][number]>();
    for (const a of accounts) {
      byAccount.set(a.id, {
        accountId: a.id, label: a.label, ...zero(), enabled: a.enabled,
        ...(a.dailyCreditCap === undefined ? {} : {
          dailyCreditCap: a.dailyCreditCap, creditsRemaining: Math.max(0, a.dailyCreditCap - a.creditsUsedToday)
        }),
        creditsUsedToday: a.creditsUsedToday,
        ...(a.lastUsedAtMs === undefined ? {} : { lastUsedAtMs: a.lastUsedAtMs })
      });
    }
    const byMember = new Map<string, FlowUsageReport['byMember'][number]>();

    for (const job of state.jobs) {
      if (!(job.createdAtMs >= fromMs && job.createdAtMs < toEndMs)) continue;
      const kind = byKind[job.kind] ? job.kind : 'video';
      add(totals, job);
      if (job.status === 'running') totals.running += 1;
      if (job.status === 'queued') totals.queued += 1;
      add(byDay.get(flowDay(job.createdAtMs))!, job);
      add(byKind[kind], job);
      if (job.accountId) {
        let row = byAccount.get(job.accountId);
        if (!row) {
          row = { accountId: job.accountId, label: job.accountId, ...zero(), enabled: false, deleted: true, creditsUsedToday: 0 };
          byAccount.set(job.accountId, row);
        }
        add(row, job);
      }
      const userId = job.createdBy ?? 'unknown';
      const member = byMember.get(userId) ?? { userId, jobs: 0, done: 0, credits: 0 };
      add(member, job);
      byMember.set(userId, member);
    }

    return {
      range: { from, to, days },
      totals,
      byDay: [...byDay].map(([date, c]) => ({ date, ...c })),
      byAccount: [...byAccount.values()],
      byKind,
      byMember: [...byMember.values()].sort((a, b) =>
        Number(a.userId === 'unknown') - Number(b.userId === 'unknown')
        || b.credits - a.credits || b.jobs - a.jobs || a.userId.localeCompare(b.userId))
    };
  }

  /** Running jobs of one provider (the OpenRouter worker adopts the ones it is not processing). */
  async runningJobs(provider: ProviderId): Promise<FlowJob[]> {
    return (await this.read()).jobs.filter(j => j.status === 'running' && (j.provider ?? 'flow') === provider);
  }

  async setRemoteId(id: string, remoteId: string): Promise<void> {
    await this.serialize(async () => {
      const state = await this.read();
      const job = state.jobs.find(j => j.id === id);
      if (!job) return;
      job.remoteId = remoteId.slice(0, 200);
      await this.write(state);
    });
  }

  async completeJob(
    id: string,
    result: { filePath: string; bytes?: number; provider?: ProviderId; result?: FlowJobResult }
  ): Promise<FlowJob | undefined> {
    return this.serialize(async () => {
      const state = await this.read();
      const job = state.jobs.find(j => j.id === id);
      if (!job) return undefined;
      job.status = 'done';
      delete job.error;
      job.resultPath = result.filePath;
      job.bytes = result.bytes;
      job.provider = result.provider ?? job.provider ?? 'flow';
      if (result.result) job.result = result.result;
      job.finishedAtMs = Date.now();
      await this.write(state);
      return job;
    });
  }

  /** `final`: retrying cannot help (bad key, no balance, generation refused): fail without re-queueing. */
  async failJob(id: string, error: string, options: { final?: boolean } = {}): Promise<FlowJob | undefined> {
    return this.serialize(async () => {
      const state = await this.read();
      const job = state.jobs.find(j => j.id === id);
      if (!job) return undefined;
      // Only the party that owns a transition may make it: a late or duplicate failure report must never
      // revive a finished job (done → queued was a hidden re-render) or burn attempts of a job nobody runs.
      // The one exception is a `final` stop of a still-queued job (a story halting the rest of its run).
      if (job.status === 'done' || job.status === 'failed') return job;
      if (job.status === 'queued' && !options.final) return job;
      const account = job.accountId ? state.accounts.find(a => a.id === job.accountId) : undefined;
      if (!options.final && account && jobCredits(job.kind) > 0 && REFUSED_FOR_CREDITS.test(error)
        && account.credits !== undefined && account.credits < 2 * jobCredits(job.kind)) {
        // Flow will not render on an account that is (nearly) out of credits, and charges nothing for it:
        // park the account until it refills and put the clip back without burning a take.
        account.exhaustedAtMs = Date.now();
        account.lastError = error.slice(0, 300);
        refundClaim(account, job);
        job.error = `Menunggu kredit: ${account.label} habis`;
        job.status = 'queued';
        job.bridgeId = undefined;
        job.accountId = undefined;
        job.startedAtMs = undefined;
        await this.write(state);
        return job;
      }
      // Flow re-credits a failed generation: take it back off today's count.
      refundClaim(account, job);
      job.attempts += 1;
      job.error = error.slice(0, 500);
      job.finishedAtMs = Date.now();
      job.status = options.final || job.attempts >= job.maxAttempts ? 'failed' : 'queued';
      job.remoteId = undefined;
      if (job.status === 'queued') {
        job.bridgeId = undefined;
        job.accountId = undefined;
      }
      await this.write(state);
      return job;
    });
  }

  /**
   * Operator stop (`POST /api/flow/jobs/:id/cancel`): a queued job becomes a final failure that a story
   * does not retry. A running job needs `force` (the Flow render may already be under way) and gives
   * back the credits charged at claim. Attempts are never touched.
   */
  async cancelJob(id: string, by: string, options: { force?: boolean } = {}): Promise<
    { ok: true; job: FlowJob } | { ok: false; code: 'NOT_FOUND' | 'INVALID_STATE'; job?: FlowJob }
  > {
    return this.serialize(async () => {
      const state = await this.read();
      const job = state.jobs.find(j => j.id === id);
      if (!job) return { ok: false as const, code: 'NOT_FOUND' as const };
      if (job.status === 'done' || job.status === 'failed' || (job.status === 'running' && !options.force)) {
        return { ok: false as const, code: 'INVALID_STATE' as const, job };
      }
      if (job.status === 'running') {
        refundClaim(job.accountId ? state.accounts.find(a => a.id === job.accountId) : undefined, job);
      }
      job.status = 'failed';
      job.cancelled = true;
      job.error = `Dibatalkan oleh ${by}`.slice(0, 500);
      job.finishedAtMs = Date.now();
      job.remoteId = undefined;
      await this.write(state);
      return { ok: true as const, job };
    });
  }
}
