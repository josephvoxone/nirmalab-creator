/**
 * W2 — workspace service: the rules the routes and the migration share.
 *
 *  - `roleOf` / `workspaceRole` is the ONLY key to a project from now on (the access area swaps `createdBy` for it).
 *  - `assertWrite` = a viewer gets 403 `VIEWER_READ_ONLY` on every write (owner and editor write).
 *  - `ensurePersonalForUser` runs when a person first uses the platform (login, accepting a join invite) and in the
 *    migration: one personal workspace per account, named `Ruang kerja <nama depan>` from the address' local part.
 *  - Project counts read ONLY `workspaceId` out of story.json (never a title, never anything else).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeEmail } from '../auth/password.js';
import type { AuthUser, UserAuthStore } from '../auth/store.js';
import { canWrite, personalWorkspaceName, WorkspaceError, WorkspaceStore, type Role, type Workspace } from './store.js';

export type WorkspaceSummary = { id: string; name: string; role: Role; personal: boolean; projects: number; members: number };
export type WorkspaceMemberView = { userId: string; email: string; role: Role; joinedAtMs: number };
export type WorkspaceInviteView = { id: string; email: string; role: Role; expiresAtMs: number; createdAtMs: number };

export type WorkspaceServiceOptions = { store: WorkspaceStore; auth: UserAuthStore; dataDir: string };

const STORY_ID = /^story_[a-f0-9]{16}$/;

/** The display name an account does not have: the local part of the address, first word, capitalised. */
export function displayNameOf(email: string): string {
  const local = normalizeEmail(email).split('@')[0] ?? '';
  const first = local.split(/[._-]+/).filter(Boolean)[0] ?? '';
  return first ? first[0]!.toUpperCase() + first.slice(1) : '';
}

export class WorkspaceService {
  constructor(private readonly options: WorkspaceServiceOptions) {}

  get store(): WorkspaceStore { return this.options.store; }
  get auth(): UserAuthStore { return this.options.auth; }

  roleOf(userId: string, workspaceId: string): Role | undefined { return this.options.store.roleOf(userId, workspaceId); }

  /** Throws `NOT_FOUND` when the caller is not a member: every route turns that into the same 404 as an unknown id. */
  assertMember(userId: string, workspaceId: string): Role {
    const role = this.roleOf(userId, workspaceId);
    if (!role) throw new WorkspaceError('NOT_FOUND', 'Workspace tidak ditemukan');
    return role;
  }

  async ensurePersonalForUser(userId: string): Promise<Workspace> {
    const user = this.options.auth.findUserById(userId);
    const name = personalWorkspaceName(displayNameOf(user?.email ?? ''));
    const { workspace } = await this.options.store.ensurePersonal({ userId, name });
    return workspace;
  }

  /** Every workspace the caller follows, with the numbers the sidebar shows. */
  async listForUser(userId: string): Promise<WorkspaceSummary[]> {
    const counts = await this.projectCounts();
    return this.options.store.listForUser(userId).map(({ workspace, role }) => ({
      id: workspace.id,
      name: workspace.name,
      role,
      personal: workspace.personal,
      projects: counts.get(workspace.id) ?? 0,
      members: this.options.store.members(workspace.id).length
    }));
  }

  /** Members (with their address, for the settings page) and, for an owner only, the live invites. */
  detail(workspaceId: string, userId: string): { workspace: Workspace & { role: Role }; members: WorkspaceMemberView[]; invites?: WorkspaceInviteView[] } {
    const role = this.assertMember(userId, workspaceId);
    const workspace = this.options.store.get(workspaceId)!;
    const members = this.options.store.members(workspaceId).map(membership => ({
      userId: membership.userId,
      email: this.options.auth.findUserById(membership.userId)?.email ?? this.options.auth.findTombstone(membership.userId)?.email ?? '',
      role: membership.role,
      joinedAtMs: membership.joinedAtMs
    }));
    return {
      workspace: { ...workspace, role },
      members,
      ...(role === 'owner'
        ? { invites: this.options.store.invites(workspaceId).map(invite => ({ id: invite.id, email: invite.email, role: invite.role, expiresAtMs: invite.expiresAtMs, createdAtMs: invite.createdAtMs })) }
        : {})
    };
  }

  /**
   * Platform admin removed an account (wired into `onMemberRemoved`).
   *
   *  - every membership of that person goes, in every workspace (no dangling members, no access left anywhere);
   *  - their workspaces that hold no project are deleted with their invites (a dead empty "Ruang kerja X" is noise);
   *  - one that still holds projects is KEPT and marked `ownerRemovedAtMs`, so the projects are never lost and the
   *    admin console can transfer them. Nothing here deletes a project.
   */
  async cleanupRemovedUser(userId: string): Promise<{ removedWorkspaces: number; orphanedWorkspaces: number }> {
    const counts = await this.projectCounts();
    const owned = this.options.store.list().filter(w => w.ownerId === userId);
    await this.options.store.removeMembershipsOf(userId);
    let removedWorkspaces = 0;
    let orphanedWorkspaces = 0;
    for (const workspace of owned) {
      if ((counts.get(workspace.id) ?? 0) === 0) {
        if (await this.options.store.forceDelete(workspace.id)) removedWorkspaces += 1;
      } else {
        await this.options.store.markOwnerRemoved(workspace.id);
        orphanedWorkspaces += 1;
      }
    }
    return { removedWorkspaces, orphanedWorkspaces };
  }

  /** Projects per workspace, from `workspaceId` in story.json only (one pass, no cache: the tree is small). */
  async projectCounts(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const root = join(this.options.dataDir, 'stories');
    let names: string[];
    try { names = (await readdir(root)).filter(name => STORY_ID.test(name)); } catch { return counts; }
    for (const id of names) {
      let record: { workspaceId?: unknown };
      try { record = JSON.parse(await readFile(join(root, id, 'story.json'), 'utf8')) as { workspaceId?: unknown }; } catch { continue; }
      const workspaceId = typeof record?.workspaceId === 'string' ? record.workspaceId : '';
      if (workspaceId) counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
    }
    return counts;
  }

  /** The account a join token addresses, when the token is live. */
  joinPreview(token: string): { name: string; role: Role; email: string; needsAccount: boolean } | undefined {
    const invite = this.options.store.peekInvite(token);
    if (!invite) return undefined;
    const workspace = this.options.store.get(invite.workspaceId);
    if (!workspace) return undefined;
    return { name: workspace.name, role: invite.role, email: invite.email, needsAccount: this.options.auth.findUserByEmail(invite.email) === undefined };
  }

  /** Join as an already signed-in account. The token names the address; another account cannot take it. */
  async joinAsUser(token: string, user: AuthUser): Promise<{ workspace: Workspace; role: Role }> {
    const invite = this.options.store.peekInvite(token);
    if (!invite) throw new WorkspaceError('INVITE_INVALID', 'Undangan tidak berlaku lagi. Minta undangan baru.');
    const membership = await this.options.store.acceptInvite({ token, userId: user.id, email: user.email });
    const workspace = this.options.store.get(membership.workspaceId)!;
    await this.ensurePersonalForUser(user.id);
    return { workspace, role: membership.role };
  }

  /** Join by creating the account the invite was sent to (the invite IS the credential, not open signup). */
  async joinWithNewAccount(token: string, password: string, secureCookies: 'auto' | boolean, startSession: (userId: string) => void): Promise<{ user: AuthUser; workspace: Workspace; role: Role }> {
    const invite = this.options.store.peekInvite(token);
    if (!invite) throw new WorkspaceError('INVITE_INVALID', 'Undangan tidak berlaku lagi. Minta undangan baru.');
    if (password.length < 8 || password.length > 256) throw new WorkspaceError('INVALID', 'Password harus 8-256 karakter');
    if (this.options.auth.findUserByEmail(invite.email)) throw new WorkspaceError('EMAIL_MISMATCH', 'Sudah ada akun dengan email ini. Masuk dulu, lalu buka tautan undangan lagi.');
    const user = await this.options.auth.createUser({ email: invite.email, password, isAdmin: false, invitedBy: invite.createdBy });
    const membership = await this.options.store.acceptInvite({ token, userId: user.id, email: user.email });
    const workspace = this.options.store.get(membership.workspaceId)!;
    await this.ensurePersonalForUser(user.id);
    void secureCookies;
    startSession(user.id);
    return { user, workspace, role: membership.role };
  }
}

/** Owner or editor write; a viewer (or a non-member) gets undefined, so the route answers 403 `VIEWER_READ_ONLY`. */
export function assertWrite(service: Pick<WorkspaceService, 'roleOf'>, userId: string, workspaceId: string): Role | undefined {
  const role = service.roleOf(userId, workspaceId);
  return canWrite(role) ? role : undefined;
}
