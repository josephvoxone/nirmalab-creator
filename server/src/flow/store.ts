import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivateJsonFile } from '../lib/private-json-file.js';

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
};

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
};

type FlowState = {
  version: 1;
  accounts: FlowAccount[];
  jobs: FlowJob[];
  bridge?: FlowBridgeState;
  /** group -> account that owns it */
  groupAccounts?: Record<string, string>;
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

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
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
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs.map(j => ({ ...j, kind: j.kind ?? 'video' })) : [],
        ...(parsed.bridge === undefined ? {} : { bridge: parsed.bridge }),
        ...(parsed.groupAccounts === undefined ? {} : { groupAccounts: parsed.groupAccounts })
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
        ...(input.technique === undefined ? {} : { technique: input.technique })
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
      const usedToday = (a: FlowAccount) => (a.dayStamp === day ? a.creditsUsedToday : 0);
      const ready = state.accounts
        .map(a => this.normaliseAccount(a))
        .filter(a => a.status === 'ready')
        .sort((a, b) => usedToday(a) - usedToday(b) || (a.lastUsedAtMs ?? 0) - (b.lastUsedAtMs ?? 0));
      const pins = state.groupAccounts ?? {};
      let account: FlowAccount | undefined;
      let job: FlowJob | undefined;
      for (const candidate of state.jobs.filter(j => j.status === 'queued').sort((a, b) => a.createdAtMs - b.createdAtMs)) {
        const pinned = candidate.group ? pins[candidate.group] : undefined;
        const pick = pinned && state.accounts.some(a => a.id === pinned) ? ready.find(a => a.id === pinned) : ready[0];
        if (pick) { account = pick; job = candidate; break; }
      }
      if (!account || !job) {
        if (changed) await this.write(state);
        return undefined;
      }
      job.status = 'running';
      job.bridgeId = bridgeId;
      job.accountId = account.id;
      if (job.group && !(state.groupAccounts ?? {})[job.group]) {
        state.groupAccounts = { ...(state.groupAccounts ?? {}), [job.group]: account.id };
      }
      job.startedAtMs = now;
      const stored = state.accounts.find(a => a.id === account.id);
      if (stored) {
        stored.creditsUsedToday = (stored.dayStamp === day ? stored.creditsUsedToday : 0) + 1;
        stored.dayStamp = day;
        stored.lastUsedAtMs = now;
      }
      await this.write(state);
      return job;
    });
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
