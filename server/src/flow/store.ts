import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivateJsonFile } from '../lib/private-json-file.js';
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
export type FlowJobResult = { mediaId?: string; caption?: string; flowCharacterId?: string };

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
  provider?: string;
  error?: string;
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
const MAX_JOBS = 500;

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
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, 'flow.json');
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
    const trimmed: FlowState = { ...state, jobs: state.jobs.slice(-MAX_JOBS) };
    await writePrivateJsonFile(this.path, trimmed);
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
    return state.jobs.find(j => j.id === id);
  }

  async heartbeat(bridgeId: string, credits: Array<{ id: string; credits: number }>): Promise<void> {
    await this.serialize(async () => {
      const state = await this.read();
      state.bridge = { bridgeId: bridgeId.slice(0, 80), lastSeenMs: Date.now() };
      for (const entry of credits) {
        const account = state.accounts.find(a => a.id === entry.id);
        if (account && Number.isFinite(entry.credits)) account.credits = Math.max(0, Math.round(entry.credits));
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
  }): Promise<FlowJob> {
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
        prompt: prompt.slice(0, 4000),
        aspect: input.aspect ?? '9:16',
        durationSec: Math.min(Math.max(Math.round(input.durationSec ?? 8), 4), 10),
        status: 'queued',
        attempts: 0,
        maxAttempts: Math.min(Math.max(input.maxAttempts ?? 3, 1), 5),
        createdAtMs: Date.now(),
        ...(input.technique === undefined ? {} : { technique: input.technique }),
        ...(input.createdBy ? { createdBy: input.createdBy.slice(0, 80) } : {})
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

  async claimJob(bridgeId: string): Promise<FlowJob | undefined> {
    return this.serialize(async () => {
      const state = await this.read();
      const now = Date.now();
      const day = today();
      let changed = false;
      // A bridge that died mid-job never reports back: expire its lease so the job is retried.
      for (const stale of state.jobs) {
        if (stale.status === 'running' && now - (stale.startedAtMs ?? now) > JOB_LEASE_MS) {
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
        if (orphan.status === 'running' && orphan.bridgeId === bridgeId) {
          orphan.status = 'queued';
          orphan.bridgeId = undefined;
          orphan.accountId = undefined;
          orphan.startedAtMs = undefined;
          changed = true;
        }
      }
      const ordered = orderAccounts(state.accounts.map(a => this.normaliseAccount(a)), loadPool(state.pool).rotation);
      const eligible = (a: FlowAccount, cost: number) =>
        a.status === 'ready' && a.enabled && (a.dailyCreditCap === undefined || a.creditsUsedToday + cost <= a.dailyCreditCap);
      const pins = state.groupAccounts ?? {};
      let account: FlowAccount | undefined;
      let job: FlowJob | undefined;
      for (const candidate of state.jobs.filter(j => j.status === 'queued').sort((a, b) => a.createdAtMs - b.createdAtMs)) {
        const cost = jobCredits(candidate.kind);
        const pinnedId = candidate.group ? pins[candidate.group] : undefined;
        const pinned = pinnedId ? ordered.find(a => a.id === pinnedId) : undefined;
        // A group waits for its own account (its Flow characters live there) unless that account was
        // disabled or deleted: then it moves, and the bridge recreates the characters on the new one.
        const pick = pinned?.enabled
          ? (eligible(pinned, cost) ? pinned : undefined)
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
      if (job.group && (state.groupAccounts ?? {})[job.group] !== account.id) {
        state.groupAccounts = { ...(state.groupAccounts ?? {}), [job.group]: account.id };
      }
      job.startedAtMs = now;
      const stored = state.accounts.find(a => a.id === account.id);
      if (stored) {
        stored.creditsUsedToday = (stored.dayStamp === day ? stored.creditsUsedToday : 0) + jobCredits(job.kind);
        stored.dayStamp = day;
        stored.lastUsedAtMs = now;
      }
      await this.write(state);
      return job;
    });
  }

  async usage(input: { days?: number; nowMs?: number } = {}): Promise<FlowUsageReport> {
    const state = await this.read();
    const days = Math.min(Math.max(Math.round(Number.isFinite(input.days) ? input.days! : 7), 1), 90);
    const to = flowDay(input.nowMs ?? Date.now());
    const fromMs = dayStartMs(to) - (days - 1) * DAY_MS;
    const toEndMs = dayStartMs(to) + DAY_MS;
    const from = flowDay(fromMs);
    const zero = (): Counts => ({ jobs: 0, done: 0, failed: 0, credits: 0 });
    const add = (c: { jobs: number; done: number; credits: number; failed?: number }, j: FlowJob) => {
      c.jobs += 1;
      if (j.status === 'done') { c.done += 1; c.credits += jobCredits(j.kind); }
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

  async completeJob(
    id: string,
    result: { filePath: string; bytes?: number; provider?: string; result?: FlowJobResult }
  ): Promise<FlowJob | undefined> {
    return this.serialize(async () => {
      const state = await this.read();
      const job = state.jobs.find(j => j.id === id);
      if (!job) return undefined;
      job.status = 'done';
      job.resultPath = result.filePath;
      job.bytes = result.bytes;
      job.provider = result.provider ?? 'flow';
      if (result.result) job.result = result.result;
      job.finishedAtMs = Date.now();
      await this.write(state);
      return job;
    });
  }

  async failJob(id: string, error: string): Promise<FlowJob | undefined> {
    return this.serialize(async () => {
      const state = await this.read();
      const job = state.jobs.find(j => j.id === id);
      if (!job) return undefined;
      job.attempts += 1;
      job.error = error.slice(0, 500);
      job.finishedAtMs = Date.now();
      job.status = job.attempts >= job.maxAttempts ? 'failed' : 'queued';
      if (job.status === 'queued') {
        job.bridgeId = undefined;
        job.accountId = undefined;
      }
      await this.write(state);
      return job;
    });
  }
}
