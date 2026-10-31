/**
 * W1 — team workspaces (wave 4): workspace, membership and invite storage at `<dataDir>/workspace/workspaces.json`.
 *
 *  - One rule per operation, checked in the store so every caller (routes, migration, scripts) inherits it:
 *    owner | editor | viewer; one owner minimum; a personal workspace cannot be deleted; at most 5 workspaces per person.
 *  - Invites: 32 random bytes, only the SHA-256 is stored, single use, 7 days, revocable. The plain token never touches the disk.
 *  - Storage: one private JSON file (0600) written through a promise queue (serialize): concurrent mutations read -> apply -> write
 *    one after another, so two clicks cannot lose each other's write. Temp file + rename (private-json-file.ts).
 *  - Reads are synchronous from the file (small document, same pattern as auth.json); writes are async.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { renameSync, writeFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { newAuthToken, normalizeEmail } from '../auth/password.js';

export type Role = 'owner' | 'editor' | 'viewer';
export const ROLES: readonly Role[] = ['owner', 'editor', 'viewer'];

/** Writers change projects (assembly, render, dub, publish); a viewer only reads. */
export const canWrite = (role: Role | undefined): boolean => role === 'owner' || role === 'editor';
/** Managing members, invites and the workspace itself is the owner's business only. */
export const canManage = (role: Role | undefined): boolean => role === 'owner';

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
  role: Role;
  joinedAtMs: number;
  invitedBy?: string;
};

export type WorkspaceInvite = {
  id: string;
  workspaceId: string;
  email: string;
  role: Role;
  /** SHA-256 (hex) of the token; the token itself is shown once and never stored. */
  tokenHash: string;
  createdAtMs: number;
  expiresAtMs: number;
  createdBy: string;
  revokedAtMs?: number;
  usedAtMs?: number;
  usedBy?: string;
};

export const MAX_WORKSPACES_PER_USER = 5;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type WorkspaceErrorCode =
  | 'NOT_FOUND'      // no such workspace, or the caller is not a member at all (the route turns both into 404: no oracle)
  | 'FORBIDDEN'      // a member, but the role does not allow it
  | 'LIMIT'          // MAX_WORKSPACES_PER_USER reached
  | 'LAST_OWNER'     // the workspace would be left without an owner
  | 'PERSONAL'       // a personal workspace cannot be deleted
  | 'INVITE_INVALID' // expired, used, revoked or unknown token
  | 'EMAIL_MISMATCH' // the invite was issued for another address
  | 'ALREADY_MEMBER' // that person is already in the workspace
  | 'INVALID';       // malformed input (name, role, email)

export class WorkspaceError extends Error {
  constructor(readonly code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

type WorkspaceDocument = { version: 1; workspaces: Workspace[]; memberships: Membership[]; invites: WorkspaceInvite[] };

const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** Constant-time compare over every record (same rule as auth/store.ts): no early exit, no timing signal. */
function findByTokenHash<T extends { tokenHash: string }>(records: T[], wantedHex: string): T | undefined {
  const wanted = Buffer.from(wantedHex, 'hex');
  let match: T | undefined;
  for (const record of records) {
    const stored = Buffer.from(record.tokenHash, 'hex');
    if (stored.length === wanted.length && timingSafeEqual(stored, wanted)) match = record;
  }
  return match;
}

const NAME_MAX = 60;
const cleanName = (raw: unknown): string => {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw new WorkspaceError('INVALID', 'Nama workspace wajib diisi');
  if (name.length > NAME_MAX) throw new WorkspaceError('INVALID', `Nama workspace paling panjang ${NAME_MAX} karakter`);
  return name;
};
const cleanRole = (raw: unknown, allowOwner: boolean): Role => {
  if (typeof raw !== 'string' || !(ROLES as readonly string[]).includes(raw)) throw new WorkspaceError('INVALID', 'Peran harus owner, editor atau viewer');
  if (!allowOwner && raw === 'owner') throw new WorkspaceError('INVALID', 'Undangan hanya untuk peran editor atau viewer');
  return raw as Role;
};

/** The name of a personal workspace: `Ruang kerja <nama depan>`. */
export const personalWorkspaceName = (displayName: string | undefined): string => {
  const first = (displayName ?? '').trim().split(/\s+/)[0] ?? '';
  return first ? `Ruang kerja ${first}`.slice(0, NAME_MAX) : 'Ruang kerja saya';
};

/** `workspaceRole(userId, workspaceId)` of the brief; undefined for somebody who is not a member. */
export const workspaceRole = (store: Pick<WorkspaceStore, 'roleOf'>, userId: string, workspaceId: string): Role | undefined =>
  store.roleOf(userId, workspaceId);

export type WorkspaceStoreOptions = { now?: () => number };

export class WorkspaceStore {
  readonly path: string;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, options: WorkspaceStoreOptions = {}) {
    this.path = join(dataDir, 'workspace', 'workspaces.json');
    this.now = options.now ?? Date.now;
  }

  // ------------------------------------------------------------------ reading

  list(): Workspace[] { return this.read().workspaces; }

  get(workspaceId: string): Workspace | undefined { return this.read().workspaces.find(w => w.id === workspaceId); }

  members(workspaceId: string): Membership[] {
    return this.read().memberships.filter(m => m.workspaceId === workspaceId).map(m => ({ ...m }));
  }

  /** Live invites (not used, not revoked, not expired) of a workspace, newest last. */
  invites(workspaceId: string): WorkspaceInvite[] {
    const now = this.now();
    return this.read().invites.filter(i => i.workspaceId === workspaceId && !i.usedAtMs && !i.revokedAtMs && i.expiresAtMs > now).map(i => ({ ...i }));
  }

  roleOf(userId: string, workspaceId: string): Role | undefined {
    return this.read().memberships.find(m => m.workspaceId === workspaceId && m.userId === userId)?.role;
  }

  /** Every workspace the user belongs to, with the role held there (newest first). */
  listForUser(userId: string): Array<{ workspace: Workspace; role: Role }> {
    const doc = this.read();
    return doc.memberships
      .filter(m => m.userId === userId)
      .map(m => ({ workspace: doc.workspaces.find(w => w.id === m.workspaceId), role: m.role }))
      .filter((row): row is { workspace: Workspace; role: Role } => row.workspace !== undefined)
      .sort((a, b) => b.workspace.createdAtMs - a.workspace.createdAtMs);
  }

  personalOf(userId: string): Workspace | undefined {
    return this.read().workspaces.find(w => w.personal && w.ownerId === userId);
  }

  // ------------------------------------------------------------------ writing

  private run<T>(work: (doc: WorkspaceDocument) => T): Promise<T> {
    const next = this.queue.then(() => {
      const doc = this.read();
      const out = work(doc);
      this.write(doc);
      return out;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  create(input: { name: unknown; ownerId: string }): Promise<Workspace> {
    const name = cleanName(input.name);
    return this.run(doc => {
      const mine = doc.memberships.filter(m => m.userId === input.ownerId).length;
      if (mine >= MAX_WORKSPACES_PER_USER) throw new WorkspaceError('LIMIT', `Paling banyak ${MAX_WORKSPACES_PER_USER} workspace per pengguna`);
      const workspace: Workspace = { id: `ws_${newAuthToken(12)}`, name, ownerId: input.ownerId, createdAtMs: this.now(), personal: false };
      doc.workspaces.push(workspace);
      doc.memberships.push({ workspaceId: workspace.id, userId: input.ownerId, role: 'owner', joinedAtMs: workspace.createdAtMs });
      return workspace;
    });
  }

  /** The personal workspace of a user, created on first use. Idempotent: one per user, ever. Never counts against nothing: it is a membership. */
  ensurePersonal(input: { userId: string; displayName?: string; name?: string }): Promise<{ workspace: Workspace; created: boolean }> {
    const wanted = input.name === undefined ? personalWorkspaceName(input.displayName) : cleanName(input.name);
    return this.run(doc => {
      const existing = doc.workspaces.find(w => w.personal && w.ownerId === input.userId);
      if (existing) return { workspace: existing, created: false };
      // Canonical personal id (`ws_personal_<userId>`): the access layer resolves legacy projects and every
      // project created without an explicit workspace to this id, so it must be the one that exists on disk.
      const workspace: Workspace = { id: `ws_personal_${input.userId}`, name: wanted, ownerId: input.userId, createdAtMs: this.now(), personal: true };
      doc.workspaces.push(workspace);
      doc.memberships.push({ workspaceId: workspace.id, userId: input.userId, role: 'owner', joinedAtMs: workspace.createdAtMs });
      return { workspace, created: true };
    });
  }

  private assertManager(doc: WorkspaceDocument, workspaceId: string, byUserId: string): Role {
    if (!doc.workspaces.some(w => w.id === workspaceId)) throw new WorkspaceError('NOT_FOUND', 'Workspace tidak ditemukan');
    const role = doc.memberships.find(m => m.workspaceId === workspaceId && m.userId === byUserId)?.role;
    if (!role) throw new WorkspaceError('NOT_FOUND', 'Workspace tidak ditemukan');
    if (!canManage(role)) throw new WorkspaceError('FORBIDDEN', 'Hanya pemilik workspace yang boleh mengelola anggota');
    return role;
  }

  addMember(input: { workspaceId: string; userId: string; role: Role; byUserId: string; invitedBy?: string }): Promise<Membership> {
    return this.run(doc => {
      this.assertManager(doc, input.workspaceId, input.byUserId);
      const already = doc.memberships.find(m => m.workspaceId === input.workspaceId && m.userId === input.userId);
      if (already) throw new WorkspaceError('ALREADY_MEMBER', 'Orang ini sudah menjadi anggota workspace');
      const membership: Membership = {
        workspaceId: input.workspaceId, userId: input.userId, role: input.role, joinedAtMs: this.now(),
        ...(input.invitedBy ? { invitedBy: input.invitedBy } : {})
      };
      doc.memberships.push(membership);
      return membership;
    });
  }

  setRole(input: { workspaceId: string; userId: string; role: Role; byUserId: string }): Promise<Membership> {
    return this.run(doc => {
      this.assertManager(doc, input.workspaceId, input.byUserId);
      const membership = doc.memberships.find(m => m.workspaceId === input.workspaceId && m.userId === input.userId);
      if (!membership) throw new WorkspaceError('NOT_FOUND', 'Anggota tidak ditemukan');
      if (membership.role === 'owner' && input.role !== 'owner' && this.ownersOf(doc, input.workspaceId) <= 1) {
        throw new WorkspaceError('LAST_OWNER', 'Workspace harus punya setidaknya satu pemilik');
      }
      membership.role = input.role;
      return { ...membership };
    });
  }

  /** Remove a member (the projects stay in the workspace). A member may remove themselves; only an owner removes others. */
  removeMember(input: { workspaceId: string; userId: string; byUserId: string }): Promise<void> {
    return this.run(doc => {
      if (!doc.workspaces.some(w => w.id === input.workspaceId)) throw new WorkspaceError('NOT_FOUND', 'Workspace tidak ditemukan');
      const mine = doc.memberships.find(m => m.workspaceId === input.workspaceId && m.userId === input.byUserId)?.role;
      if (!mine) throw new WorkspaceError('NOT_FOUND', 'Workspace tidak ditemukan');
      const target = doc.memberships.find(m => m.workspaceId === input.workspaceId && m.userId === input.userId);
      if (!target) throw new WorkspaceError('NOT_FOUND', 'Anggota tidak ditemukan');
      if (input.userId !== input.byUserId && !canManage(mine)) throw new WorkspaceError('FORBIDDEN', 'Hanya pemilik workspace yang boleh mengeluarkan anggota');
      if (target.role === 'owner' && this.ownersOf(doc, input.workspaceId) <= 1) {
        throw new WorkspaceError('LAST_OWNER', 'Workspace harus punya setidaknya satu pemilik');
      }
      doc.memberships = doc.memberships.filter(m => m !== target);
    });
  }

  /** Delete a workspace (members and open invites go with it). Personal workspaces are permanent; projects are NOT deleted here. */
  deleteWorkspace(input: { workspaceId: string; byUserId: string }): Promise<void> {
    return this.run(doc => {
      const workspace = doc.workspaces.find(w => w.id === input.workspaceId);
      if (!workspace) throw new WorkspaceError('NOT_FOUND', 'Workspace tidak ditemukan');
      const role = doc.memberships.find(m => m.workspaceId === input.workspaceId && m.userId === input.byUserId)?.role;
      if (!role) throw new WorkspaceError('NOT_FOUND', 'Workspace tidak ditemukan');
      if (!canManage(role)) throw new WorkspaceError('FORBIDDEN', 'Hanya pemilik workspace yang boleh menghapusnya');
      if (workspace.personal) throw new WorkspaceError('PERSONAL', 'Workspace pribadi tidak bisa dihapus');
      doc.workspaces = doc.workspaces.filter(w => w !== workspace);
      doc.memberships = doc.memberships.filter(m => m.workspaceId !== input.workspaceId);
      doc.invites = doc.invites.filter(i => i.workspaceId !== input.workspaceId);
    });
  }

  // ------------------------------------------------------------------ invites

  createInvite(input: { workspaceId: string; email: unknown; role: unknown; createdBy: string }): Promise<{ invite: WorkspaceInvite; token: string }> {
    const email = typeof input.email === 'string' ? normalizeEmail(input.email) : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new WorkspaceError('INVALID', 'Email undangan tidak valid');
    const role = cleanRole(input.role, false);
    return this.run(doc => {
      this.assertManager(doc, input.workspaceId, input.createdBy);
      const token = randomBytes(32).toString('base64url');
      const now = this.now();
      const invite: WorkspaceInvite = {
        id: `wi_${newAuthToken(9)}`, workspaceId: input.workspaceId, email, role,
        tokenHash: hashToken(token), createdAtMs: now, expiresAtMs: now + INVITE_TTL_MS, createdBy: input.createdBy
      };
      doc.invites.push(invite);
      return { invite, token };
    });
  }

  /** The invite a token names, when it is still live (not used, not revoked, not expired). */
  peekInvite(token: string): WorkspaceInvite | undefined {
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return undefined;
    const invite = findByTokenHash(this.read().invites, hashToken(token));
    if (!invite || invite.usedAtMs || invite.revokedAtMs || invite.expiresAtMs <= this.now()) return undefined;
    return invite;
  }

  revokeInvite(input: { workspaceId: string; inviteId: string; byUserId: string }): Promise<void> {
    return this.run(doc => {
      this.assertManager(doc, input.workspaceId, input.byUserId);
      const invite = doc.invites.find(i => i.id === input.inviteId && i.workspaceId === input.workspaceId);
      if (!invite) throw new WorkspaceError('NOT_FOUND', 'Undangan tidak ditemukan');
      if (!invite.usedAtMs) invite.revokedAtMs = this.now();
    });
  }

  /**
   * Join through an invite: the token is spent in the same write that adds the membership (a crash cannot leave it reusable).
   * An invite is bound to the address it was sent to; an existing account with another address cannot take it.
   */
  acceptInvite(input: { token: string; userId: string; email: string }): Promise<Membership> {
    return this.run(doc => {
      const invite = findByTokenHash(doc.invites, hashToken(input.token));
      if (!invite || invite.usedAtMs || invite.revokedAtMs || invite.expiresAtMs <= this.now()) {
        throw new WorkspaceError('INVITE_INVALID', 'Undangan tidak berlaku lagi. Minta undangan baru.');
      }
      if (normalizeEmail(input.email) !== invite.email) {
        throw new WorkspaceError('EMAIL_MISMATCH', 'Undangan ini ditujukan untuk alamat email lain');
      }
      const existing = doc.memberships.find(m => m.workspaceId === invite.workspaceId && m.userId === input.userId);
      invite.usedAtMs = this.now();
      invite.usedBy = input.userId;
      if (existing) return { ...existing }; // already in: the token is still spent, nothing doubles
      const membership: Membership = {
        workspaceId: invite.workspaceId, userId: input.userId, role: invite.role, joinedAtMs: this.now(), invitedBy: invite.createdBy
      };
      doc.memberships.push(membership);
      return membership;
    });
  }

  // ------------------------------------------------------------------ helpers

  private ownersOf(doc: WorkspaceDocument, workspaceId: string): number {
    return doc.memberships.filter(m => m.workspaceId === workspaceId && m.role === 'owner').length;
  }

  private read(): WorkspaceDocument {
    try {
      if (!existsSync(this.path)) return { version: 1, workspaces: [], memberships: [], invites: [] };
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return { version: 1, workspaces: [], memberships: [], invites: [] };
      const doc = parsed as Partial<WorkspaceDocument>;
      return {
        version: 1,
        workspaces: Array.isArray(doc.workspaces) ? doc.workspaces : [],
        memberships: Array.isArray(doc.memberships) ? doc.memberships : [],
        invites: Array.isArray(doc.invites) ? doc.invites : []
      };
    } catch {
      return { version: 1, workspaces: [], memberships: [], invites: [] };
    }
  }

  /** Temp file + rename, 0600: a crash mid-write leaves the previous file, never half of one. */
  private write(doc: WorkspaceDocument): void {
    const parent = dirname(this.path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const tmp = join(parent, `.${this.path.split('/').pop()}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      if (process.platform !== 'win32') chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
      if (process.platform !== 'win32') chmodSync(this.path, 0o600);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
}
