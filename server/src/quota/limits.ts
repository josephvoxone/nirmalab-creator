/**
 * Per-user spending limits. Stored at `<dataDir>/quota/limits.json` (0600): numbers only, never anything about a project.
 * Resolution: the user's own entry for the kind, else the default of their role. Absent/null = no limit.
 *
 * Defaults (owner's decision): ElevenLabs for non-admins 2.000 characters a day, 5.000 in 30 days, 2.500 per render;
 * admins (isAdmin) unlimited; Flow and OpenRouter unlimited for everybody until an admin sets a limit.
 */
import { join } from 'node:path';
import { readPrivateJsonFile, writePrivateJsonFile } from '../lib/private-json-file.js';
import type { QuotaKind } from './errors.js';

export type { QuotaKind } from './errors.js';
export const QUOTA_KINDS: readonly QuotaKind[] = ['flowCredits', 'openrouterUsd', 'elevenChars', 'llmTurns', 'genCalls'];

export type Limit = { perDay?: number | null; per30d?: number | null; perRender?: number | null };
export type UserLimits = Partial<Record<QuotaKind, Limit>>;

export const DEFAULT_LIMITS: { member: UserLimits; admin: UserLimits } = {
  member: { elevenChars: { perDay: 2000, per30d: 5000, perRender: 2500 } },
  admin: {}
};

/** Resolves the limit of `userId` for `kind`; undefined = unlimited. */
export type LimitResolver = (userId: string, kind: QuotaKind) => Limit | undefined;

export class LimitInputError extends Error {}

const FIELDS = ['perDay', 'per30d', 'perRender'] as const;

/** Validates an admin-supplied body: only known kinds and fields, numbers >= 0 or null. Anything else throws. */
export function parseUserLimits(raw: unknown): UserLimits {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new LimitInputError('limits harus berupa objek');
  const out: UserLimits = {};
  for (const [kind, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(QUOTA_KINDS as readonly string[]).includes(kind)) throw new LimitInputError(`Jenis batas tidak dikenal: ${kind.slice(0, 40)}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LimitInputError(`Batas ${kind} harus berupa objek`);
    const limit: Limit = {};
    for (const [field, n] of Object.entries(value as Record<string, unknown>)) {
      if (!(FIELDS as readonly string[]).includes(field)) throw new LimitInputError(`Isian batas tidak dikenal: ${field.slice(0, 40)}`);
      if (n === null) { (limit as Record<string, number | null>)[field] = null; continue; }
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1e9) throw new LimitInputError(`Batas ${kind}.${field} harus angka 0 atau lebih (atau kosong = tanpa batas)`);
      (limit as Record<string, number | null>)[field] = n;
    }
    out[kind as QuotaKind] = limit;
  }
  return out;
}

/** The number of a limit field, or undefined when it is absent/null (= no limit). */
export function limitNumber(limit: Limit | undefined, field: keyof Limit): number | undefined {
  const n = limit?.[field];
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

type Stored = { version?: 1; users?: Record<string, UserLimits>; workspaces?: Record<string, UserLimits> };

export class LimitsStore {
  readonly path: string;
  private cache: Record<string, UserLimits> | undefined;
  private workspaceCache: Record<string, UserLimits> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  /** `isAdmin`: who counts as an admin right now (the auth store), consulted on every resolution. */
  constructor(dataDir: string, private readonly isAdmin: (userId: string) => boolean) {
    this.path = join(dataDir, 'quota', 'limits.json');
  }

  private async load(): Promise<Record<string, UserLimits>> {
    if (this.cache) return this.cache;
    let users: Record<string, UserLimits> = {};
    let workspaces: Record<string, UserLimits> = {};
    try {
      const raw = (await readPrivateJsonFile(this.path)) as Stored | undefined;
      if (raw?.users && typeof raw.users === 'object') {
        for (const [id, limits] of Object.entries(raw.users)) { try { users[id] = parseUserLimits(limits); } catch { /* a damaged entry falls back to the default */ } }
      }
      if (raw?.workspaces && typeof raw.workspaces === 'object') {
        for (const [id, limits] of Object.entries(raw.workspaces)) { try { workspaces[id] = parseUserLimits(limits); } catch { /* a damaged entry means no workspace limit */ } }
      }
    } catch { users = {}; workspaces = {}; }
    this.cache = users;
    this.workspaceCache = workspaces;
    return users;
  }

  /** Reads the file once; call at boot so `resolve` is synchronous afterwards. */
  async init(): Promise<void> { await this.load(); }

  /** The user's own overrides (not the defaults). */
  async overrides(userId: string): Promise<UserLimits> { return { ...((await this.load())[userId] ?? {}) }; }

  /** Replaces the user's overrides; `{}` goes back to the defaults. */
  async set(userId: string, limits: UserLimits): Promise<UserLimits> {
    const run = this.queue.then(async () => {
      const users = await this.load();
      if (Object.keys(limits).length) users[userId] = limits; else delete users[userId];
      await writePrivateJsonFile(this.path, { version: 1, users, ...(this.workspaceCache && Object.keys(this.workspaceCache).length ? { workspaces: this.workspaceCache } : {}) } satisfies Stored);
      return limits;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The workspace's own overrides (not the per-person ones). */
  async overridesWorkspace(workspaceId: string): Promise<UserLimits> { await this.load(); return { ...((this.workspaceCache ?? {})[workspaceId] ?? {}) }; }

  /** Replaces the limits the platform admin set for a workspace; `{}` = no workspace limit (the per-person limits stay). */
  async setWorkspace(workspaceId: string, limits: UserLimits): Promise<UserLimits> {
    const run = this.queue.then(async () => {
      await this.load();
      const workspaces = (this.workspaceCache ??= {});
      if (Object.keys(limits).length) workspaces[workspaceId] = limits; else delete workspaces[workspaceId];
      this.workspaceCache = workspaces;
      await writePrivateJsonFile(this.path, { version: 1, users: this.cache ?? {}, ...(Object.keys(workspaces).length ? { workspaces } : {}) } satisfies Stored);
      return limits;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The workspace's limit for `kind`; undefined = no workspace limit (the per-person limit is a separate gate and stays). */
  resolveWorkspace = (workspaceId: string, kind: QuotaKind): Limit | undefined => (this.workspaceCache ?? {})[workspaceId]?.[kind];

  effectiveWorkspace(workspaceId: string): UserLimits {
    const out: UserLimits = {};
    for (const kind of QUOTA_KINDS) { const l = this.resolveWorkspace(workspaceId, kind); if (l) out[kind] = l; }
    return out;
  }

  defaultsFor(userId: string): UserLimits { return this.isAdmin(userId) ? DEFAULT_LIMITS.admin : DEFAULT_LIMITS.member; }

  /** Effective limit (after `init()`; before it only the defaults apply). */
  resolve: LimitResolver = (userId, kind) => userId.startsWith('system:') ? undefined : this.cache?.[userId]?.[kind] ?? this.defaultsFor(userId)[kind];

  effective(userId: string): UserLimits {
    const out: UserLimits = {};
    for (const kind of QUOTA_KINDS) { const l = this.resolve(userId, kind); if (l) out[kind] = l; }
    return out;
  }
}
