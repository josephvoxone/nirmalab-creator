import { join } from 'node:path';
import { readPrivateJsonFile, writePrivateJsonFile } from '../lib/private-json-file.js';

/**
 * WAVE 4 / access — workspace-scoped ownership (thin adaptor).
 *
 * The ws area owns `server/src/workspace/{store,service,routes}.ts`; this module is the ONE place the access area reads a
 * role from, so at merge its body is replaced by `workspace/store.ts` (`workspaceRole`) and every caller keeps working.
 * It implements the pinned contract of WAVE4-BRIEF: `Workspace` + `Membership` on disk, `workspaceRole(userId, workspaceId)`.
 *
 * Ownership axis: a project belongs to a WORKSPACE (`story.workspaceId`); a person reaches it through a membership role.
 *  - owner   manages members and does everything with the projects
 *  - editor  reads and changes projects (no member management)
 *  - viewer  reads projects, never changes them (403 VIEWER_READ_ONLY on writes)
 *  - nobody else (platform admin included): the project does not exist (404)
 *
 * A personal workspace (`ws_personal_<userId>`) exists implicitly for every account: it is what the projects made before
 * workspaces (and every project created without an explicit `workspaceId`) resolve to, and its owner is always its user.
 * Removal from a workspace deletes the membership row, so access is gone on the very next request; the projects stay.
 */

export type WorkspaceRole = 'owner' | 'editor' | 'viewer';
export const WORKSPACE_ROLES: readonly WorkspaceRole[] = ['owner', 'editor', 'viewer'];

export type Workspace = {
  id: string;
  name: string;
  ownerId: string;
  createdAtMs: number;
  personal: boolean;
  archivedAtMs?: number;
};

export type Membership = {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  joinedAtMs: number;
  invitedBy?: string;
};

/** What a member sees of a workspace: no owner ids or invites (those belong to the ws area). */
export type WorkspaceRef = { id: string; name: string; role: WorkspaceRole; personal: boolean };

export const WORKSPACE_ID = /^ws_[A-Za-z0-9_-]{1,80}$/;

/** The implicit workspace of one person (the migration gives every account one; the projects without `workspaceId` resolve here). */
export const personalWorkspaceId = (userId: string): string => `ws_personal_${userId}`;
export const isPersonalWorkspaceId = (workspaceId: string): boolean => workspaceId.startsWith('ws_personal_');

/** The workspace a project lives in: `workspaceId` when recorded, else the personal workspace of whoever made it (legacy). */
export function workspaceIdOf(record: { workspaceId?: string; createdBy?: string }, legacyOwnerId?: string): string | undefined {
  if (record.workspaceId) return record.workspaceId;
  const owner = record.createdBy || legacyOwnerId;
  return owner ? personalWorkspaceId(owner) : undefined;
}

/** `owner` and `editor` change projects; `viewer` may only read. */
export const canEdit = (role: WorkspaceRole | undefined): boolean => role === 'owner' || role === 'editor';

/** What a viewer gets on every write route: a clear message, not a silent no-op. */
export const VIEWER_READ_ONLY_BODY = {
  error: {
    code: 'VIEWER_READ_ONLY',
    message: 'Anda hanya penonton di workspace ini: proyek bisa dilihat, tidak bisa diubah. Minta pemilik workspace menaikkan peran Anda menjadi editor.'
  }
} as const;
export const VIEWER_READ_ONLY_MESSAGE = VIEWER_READ_ONLY_BODY.error.message;

// ------------------------------------------------------------------ the files (ws area owns the real shapes)

const workspacesFile = (dataDir: string) => join(dataDir, 'workspace', 'workspaces.json');
const membersFile = (dataDir: string) => join(dataDir, 'workspace', 'memberships.json');

/** One serialised writer per process, per file: two requests changing the member list must not lose each other. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  queues.set(key, run.catch(() => undefined));
  return run;
}

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : []);

async function readWorkspaces(dataDir: string): Promise<Workspace[]> {
  return asArray<Workspace>(await readPrivateJsonFile(workspacesFile(dataDir)).catch(() => undefined));
}

async function readMembers(dataDir: string): Promise<Membership[]> {
  const rows = asArray<Membership>(await readPrivateJsonFile(membersFile(dataDir)).catch(() => undefined));
  return rows.filter(m => typeof m?.workspaceId === 'string' && typeof m?.userId === 'string' && WORKSPACE_ROLES.includes(m.role));
}

/** The workspace records on disk plus the implicit personal one, created on first use (which is what makes a role resolvable). */
function personalWorkspace(userId: string): Workspace {
  return { id: personalWorkspaceId(userId), name: 'Ruang kerja pribadi', ownerId: userId, createdAtMs: 0, personal: true };
}

export type WorkspaceAccess = {
  roleOf(userId: string, workspaceId: string): Promise<WorkspaceRole | undefined>;
  workspacesFor(userId: string): Promise<WorkspaceRef[]>;
  nameOf(workspaceId: string): Promise<string | undefined>;
  ownerOf(workspaceId: string): Promise<string | undefined>;
  /** Who may act in `workspaceId`: `undefined` = not a member (404), `viewer` = read only (403 on writes). */
  roleIn(userId: string, workspaceId: string | undefined): Promise<WorkspaceRole | undefined>;
};

export function makeWorkspaceAccess(dataDir: string): WorkspaceAccess {
  const roleOf = async (userId: string, workspaceId: string): Promise<WorkspaceRole | undefined> => {
    if (!userId || !workspaceId || !WORKSPACE_ID.test(workspaceId)) return undefined;
    const rows = await readMembers(dataDir);
    const found = rows.find(m => m.workspaceId === workspaceId && m.userId === userId);
    if (found) return found.role;
    // The personal workspace is owned by its user even before it was written to disk (nobody else ever gets a role in it).
    if (workspaceId === personalWorkspaceId(userId)) return 'owner';
    return undefined;
  };

  const workspacesFor = async (userId: string): Promise<WorkspaceRef[]> => {
    if (!userId) return [];
    const [records, rows] = await Promise.all([readWorkspaces(dataDir), readMembers(dataDir)]);
    const out = new Map<string, WorkspaceRef>();
    const personal = personalWorkspace(userId);
    out.set(personal.id, { id: personal.id, name: personal.name, role: 'owner', personal: true });
    for (const record of records) {
      if (record.ownerId === userId) {
        out.set(record.id, { id: record.id, name: record.name, role: 'owner', personal: record.personal === true });
        continue;
      }
      const membership = rows.find(m => m.workspaceId === record.id && m.userId === userId);
      if (membership) out.set(record.id, { id: record.id, name: record.name, role: membership.role, personal: record.personal === true });
    }
    // A membership row without its workspace record still resolves (a partially written store must not hide a project).
    for (const membership of rows) {
      if (membership.userId !== userId || out.has(membership.workspaceId)) continue;
      if (!WORKSPACE_ID.test(membership.workspaceId)) continue;
      out.set(membership.workspaceId, { id: membership.workspaceId, name: 'Workspace', role: membership.role, personal: isPersonalWorkspaceId(membership.workspaceId) });
    }
    return [...out.values()];
  };

  const nameOf = async (workspaceId: string): Promise<string | undefined> => {
    if (!WORKSPACE_ID.test(workspaceId)) return undefined;
    const records = await readWorkspaces(dataDir);
    return records.find(w => w.id === workspaceId)?.name
      ?? (isPersonalWorkspaceId(workspaceId) ? 'Ruang kerja pribadi' : undefined);
  };

  const ownerOf = async (workspaceId: string): Promise<string | undefined> => {
    if (!WORKSPACE_ID.test(workspaceId)) return undefined;
    const records = await readWorkspaces(dataDir);
    const record = records.find(w => w.id === workspaceId);
    if (record) return record.ownerId;
    return isPersonalWorkspaceId(workspaceId) ? workspaceId.slice('ws_personal_'.length) : undefined;
  };

  const roleIn = async (userId: string, workspaceId: string | undefined): Promise<WorkspaceRole | undefined> =>
    workspaceId ? roleOf(userId, workspaceId) : undefined;

  return { roleOf, workspacesFor, nameOf, ownerOf, roleIn };
}

// ------------------------------------------------------------------ writes (ws area replaces these with its store; tests seed through them)

export async function createWorkspaceRecord(
  dataDir: string,
  input: { name: string; ownerId: string; id?: string; personal?: boolean }
): Promise<Workspace> {
  return serial(workspacesFile(dataDir), async () => {
    const records = await readWorkspaces(dataDir);
    const id = input.id ?? `ws_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    if (!WORKSPACE_ID.test(id)) throw new Error('Invalid workspace id');
    if (records.some(w => w.id === id)) throw new Error('Workspace sudah ada');
    const record: Workspace = {
      id, name: input.name.trim() || 'Workspace', ownerId: input.ownerId,
      createdAtMs: Date.now(), personal: input.personal === true
    };
    await writePrivateJsonFile(workspacesFile(dataDir), [...records, record]);
    return record;
  });
}

export async function setMembership(
  dataDir: string,
  input: { workspaceId: string; userId: string; role: WorkspaceRole; invitedBy?: string }
): Promise<Membership> {
  if (!WORKSPACE_ID.test(input.workspaceId)) throw new Error('Invalid workspace id');
  if (!WORKSPACE_ROLES.includes(input.role)) throw new Error('Invalid role');
  return serial(membersFile(dataDir), async () => {
    const rows = await readMembers(dataDir);
    const existing = rows.find(m => m.workspaceId === input.workspaceId && m.userId === input.userId);
    const membership: Membership = existing
      ? { ...existing, role: input.role, ...(input.invitedBy ? { invitedBy: input.invitedBy } : {}) }
      : { workspaceId: input.workspaceId, userId: input.userId, role: input.role, joinedAtMs: Date.now(), ...(input.invitedBy ? { invitedBy: input.invitedBy } : {}) };
    const next = existing ? rows.map(m => (m === existing ? membership : m)) : [...rows, membership];
    await writePrivateJsonFile(membersFile(dataDir), next);
    return membership;
  });
}

/** Removing a member deletes only the row: every project of the workspace stays exactly where it is. */
export async function removeMembership(dataDir: string, input: { workspaceId: string; userId: string }): Promise<boolean> {
  return serial(membersFile(dataDir), async () => {
    const rows = await readMembers(dataDir);
    const next = rows.filter(m => !(m.workspaceId === input.workspaceId && m.userId === input.userId));
    if (next.length === rows.length) return false;
    await writePrivateJsonFile(membersFile(dataDir), next);
    return true;
  });
}

/** The role of one person in one workspace (the pinned `workspaceRole(userId, workspaceId)` of WAVE4-BRIEF). */
export async function workspaceRole(dataDir: string, userId: string, workspaceId: string): Promise<WorkspaceRole | undefined> {
  return makeWorkspaceAccess(dataDir).roleOf(userId, workspaceId);
}
