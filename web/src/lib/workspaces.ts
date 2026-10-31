/**
 * Team workspaces (wave 4, contract PIN): one person can belong to several workspaces with a
 * role. Every route below is the server contract — the client wraps it so pages never build
 * URLs by hand and a missing endpoint shows as a plain Indonesian error, not a crash.
 */
import { post, requestJson, type FetchLike, type User } from './api.js';

const patch = (body: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(body ?? {}) });
const remove = (): RequestInit => ({ method: 'DELETE' });

export type Role = 'owner' | 'editor' | 'viewer';

export const ROLE_LABEL: Record<Role, string> = { owner: 'Pemilik', editor: 'Editor', viewer: 'Penonton' };
export const ROLE_HINT: Record<Role, string> = {
  owner: 'Bisa mengubah proyek, mengundang, dan mengeluarkan anggota',
  editor: 'Bisa mengubah, merakit, dan merender proyek',
  viewer: 'Hanya bisa melihat proyek, tanpa mengubah apa pun'
};
export const ROLE_ORDER: Role[] = ['owner', 'editor', 'viewer'];

/** What the sidebar needs: id, name, my role and the two counts. */
export type WorkspaceSummary = { id: string; name: string; role: Role; personal: boolean; projects: number; members: number };
export type WorkspaceMember = { userId: string; email: string; role: Role; joinedAtMs: number };
export type WorkspaceInvite = { id: string; email: string; role: Role; expiresAtMs: number; createdAtMs?: number; revokedAtMs?: number; usedAtMs?: number };
export type WorkspaceDetail = { workspace: { id: string; name: string; ownerId: string; personal: boolean }; members: WorkspaceMember[]; invites?: WorkspaceInvite[] };
export type CreatedInvite = { invite: { id: string; email: string; role: Role; expiresAtMs: number }; url: string };

export const roleOf = (role: string | undefined): Role => (role === 'owner' || role === 'editor' ? role : 'viewer');
export const canWrite = (role: Role | undefined) => role === 'owner' || role === 'editor';
export const canManage = (role: Role | undefined) => role === 'owner';

export function workspacesApi(fetchImpl: FetchLike) {
  return {
    list: async () => {
      const r = await requestJson<{ workspaces?: WorkspaceSummary[] }>(fetchImpl, '/api/workspaces');
      return { workspaces: (Array.isArray(r?.workspaces) ? r.workspaces : []).map(w => ({ ...w, role: roleOf(w.role) })) };
    },
    create: (name: string) => requestJson<{ workspace: WorkspaceSummary }>(fetchImpl, '/api/workspaces', post({ name })),
    get: (id: string) => requestJson<WorkspaceDetail>(fetchImpl, `/api/workspaces/${encodeURIComponent(id)}`),
    invite: (id: string, email: string, role: Role) =>
      requestJson<CreatedInvite>(fetchImpl, `/api/workspaces/${encodeURIComponent(id)}/invites`, post({ email: email.trim().toLowerCase(), role })),
    revokeInvite: (id: string, inviteId: string) =>
      requestJson<{ ok: boolean }>(fetchImpl, `/api/workspaces/${encodeURIComponent(id)}/invites/${encodeURIComponent(inviteId)}`, remove()),
    setRole: (id: string, userId: string, role: Role) =>
      requestJson<{ member: WorkspaceMember }>(fetchImpl, `/api/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, patch({ role })),
    removeMember: (id: string, userId: string) =>
      requestJson<{ ok: boolean }>(fetchImpl, `/api/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, remove())
  };
}

/** The public side of an invite: no account needed to look at it. */
export function joinApi(fetchImpl: FetchLike) {
  return {
    peek: (token: string) =>
      requestJson<{ workspace: { name: string }; role: Role; email: string; needsAccount: boolean }>(fetchImpl, `/api/join/${encodeURIComponent(token)}`),
    accept: (token: string, password?: string) =>
      requestJson<{ user: User }>(fetchImpl, `/api/join/${encodeURIComponent(token)}`, post(password ? { password } : {}))
  };
}

/** "Kedaluwarsa", "Dicabut", "Dipakai", or "Aktif" for a pending invite row. */
export function inviteState(invite: WorkspaceInvite, now = Date.now()): { label: string; active: boolean } {
  if (invite.revokedAtMs) return { label: 'Dicabut', active: false };
  if (invite.usedAtMs) return { label: 'Dipakai', active: false };
  if (invite.expiresAtMs <= now) return { label: 'Kedaluwarsa', active: false };
  return { label: 'Aktif', active: true };
}

export function inviteUrl(origin: string, url: string): string {
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `${origin.replace(/\/$/, '')}${url.startsWith('/') ? '' : '/'}${url}`;
}
