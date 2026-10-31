import { WorkspaceStore, type Role } from '../workspace/store.js';

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

// ------------------------------------------------------------------ backed by the real store (wave 4 / ws)

/*
 * ONE store, ONE file: `<data>/workspace/workspaces.json` holds workspaces, memberships and invites (wave 4 / ws). This
 * module used to keep a second `memberships.json`; that split was merged away, so a role is always read from the same
 * document the workspace routes write. Nothing here writes a project: a role is the only thing it answers.
 */

const stores = new Map<string, WorkspaceStore>();
export function workspaceStoreFor(dataDir: string): WorkspaceStore {
  const found = stores.get(dataDir);
  if (found) return found;
  const store = new WorkspaceStore(dataDir);
  stores.set(dataDir, store);
  return store;
}

export type WorkspaceAccess = {
  roleOf(userId: string, workspaceId: string): Promise<WorkspaceRole | undefined>;
  workspacesFor(userId: string): Promise<WorkspaceRef[]>;
  nameOf(workspaceId: string): Promise<string | undefined>;
  ownerOf(workspaceId: string): Promise<string | undefined>;
  /** Who may act in `workspaceId`: `undefined` = not a member (404), `viewer` = read only (403 on writes). */
  roleIn(userId: string, workspaceId: string | undefined): Promise<WorkspaceRole | undefined>;
};

const PERSONAL_NAME = 'Ruang kerja pribadi';

export function makeWorkspaceAccess(dataDir: string): WorkspaceAccess {
  const store = workspaceStoreFor(dataDir);

  const roleOf = async (userId: string, workspaceId: string): Promise<WorkspaceRole | undefined> => {
    if (!userId || !workspaceId || !WORKSPACE_ID.test(workspaceId)) return undefined;
    const found = store.roleOf(userId, workspaceId);
    if (found) return found;
    // The personal workspace belongs to its user even before it was written to disk (nobody else gets a role in it).
    if (workspaceId === personalWorkspaceId(userId)) return 'owner';
    return undefined;
  };

  const workspacesFor = async (userId: string): Promise<WorkspaceRef[]> => {
    if (!userId) return [];
    const out = new Map<string, WorkspaceRef>();
    for (const row of store.listForUser(userId)) {
      out.set(row.workspace.id, { id: row.workspace.id, name: row.workspace.name, role: row.role, personal: row.workspace.personal === true });
    }
    const personalId = personalWorkspaceId(userId);
    if (!out.has(personalId)) {
      const personal = store.list().find(w => w.personal && w.ownerId === userId);
      if (personal) out.set(personal.id, { id: personal.id, name: personal.name, role: 'owner', personal: true });
      else out.set(personalId, { id: personalId, name: PERSONAL_NAME, role: 'owner', personal: true });
    }
    return [...out.values()];
  };

  const nameOf = async (workspaceId: string): Promise<string | undefined> => {
    if (!WORKSPACE_ID.test(workspaceId)) return undefined;
    return store.get(workspaceId)?.name ?? (isPersonalWorkspaceId(workspaceId) ? PERSONAL_NAME : undefined);
  };

  const ownerOf = async (workspaceId: string): Promise<string | undefined> => {
    if (!WORKSPACE_ID.test(workspaceId)) return undefined;
    const record = store.get(workspaceId);
    if (record) return record.ownerId;
    return isPersonalWorkspaceId(workspaceId) ? workspaceId.slice('ws_personal_'.length) : undefined;
  };

  const roleIn = async (userId: string, workspaceId: string | undefined): Promise<WorkspaceRole | undefined> =>
    workspaceId ? roleOf(userId, workspaceId) : undefined;

  return { roleOf, workspacesFor, nameOf, ownerOf, roleIn };
}

// ------------------------------------------------------------------ test seeding helpers (same store, same file)

/** Create a workspace record; `personal: true` resolves to the canonical personal workspace of `ownerId`. */
export async function createWorkspaceRecord(
  dataDir: string,
  input: { name: string; ownerId: string; id?: string; personal?: boolean }
): Promise<Workspace> {
  const store = workspaceStoreFor(dataDir);
  if (input.personal === true) {
    const { workspace } = await store.ensurePersonal({ userId: input.ownerId, name: input.name });
    return workspace;
  }
  return store.create({ name: input.name, ownerId: input.ownerId });
}

async function addMemberAs(dataDir: string, workspaceId: string, userId: string, role: WorkspaceRole, invitedBy?: string): Promise<Membership> {
  const store = workspaceStoreFor(dataDir);
  const workspace = store.get(workspaceId);
  if (!workspace) {
    // Seeding a personal workspace that does not exist yet: materialise it, then add the row.
    if (!isPersonalWorkspaceId(workspaceId)) throw new Error('Workspace tidak ditemukan');
    const owner = workspaceId.slice('ws_personal_'.length);
    await store.ensurePersonal({ userId: owner });
  }
  const current = store.get(workspaceId)!;
  // Upsert: seeding a member who is already there (the owner of a workspace they just created) must not throw.
  const existing = store.roleOf(userId, workspaceId);
  if (existing) return store.setRole({ workspaceId, userId, role, byUserId: current.ownerId });
  return store.addMember({ workspaceId, userId, role, byUserId: current.ownerId, ...(invitedBy ? { invitedBy } : {}) });
}

export async function setMembership(
  dataDir: string,
  input: { workspaceId: string; userId: string; role: WorkspaceRole; invitedBy?: string }
): Promise<Membership> {
  if (!WORKSPACE_ROLES.includes(input.role)) throw new Error('Invalid role');
  return addMemberAs(dataDir, input.workspaceId, input.userId, input.role, input.invitedBy);
}

/** Removing a member deletes only the row: every project of the workspace stays exactly where it is. */
export async function removeMembership(dataDir: string, input: { workspaceId: string; userId: string }): Promise<boolean> {
  const store = workspaceStoreFor(dataDir);
  const workspace = store.get(input.workspaceId);
  if (!workspace) {
    if (!isPersonalWorkspaceId(input.workspaceId)) return false;
    const owner = input.workspaceId.slice('ws_personal_'.length);
    await store.ensurePersonal({ userId: owner });
  }
  const current = store.get(input.workspaceId)!;
  const before = store.roleOf(input.userId, input.workspaceId);
  if (!before) return false;
  await store.removeMember({ workspaceId: input.workspaceId, userId: input.userId, byUserId: current.ownerId });
  return true;
}

/** The role of one person in one workspace (the pinned `workspaceRole(userId, workspaceId)` of WAVE4-BRIEF). */
export async function workspaceRole(dataDir: string, userId: string, workspaceId: string): Promise<WorkspaceRole | undefined> {
  return makeWorkspaceAccess(dataDir).roleOf(userId, workspaceId);
}
