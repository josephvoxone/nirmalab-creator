import { del, post, requestJson, type FetchLike } from './http.js';

export type Invite = { tokenHash: string; email?: string; createdAt: string; expiresAt: string; usedAt?: string; createdBy: string };
export type CreatedInvite = { token: string; expiresAt: string; email?: string };

export type FlowAccount = {
  id: string;
  label: string;
  email: string;
  profileDir?: string;
  status: 'ready' | 'cooldown' | 'error';
  credits?: number;
  creditsUsedToday: number;
  cooldownUntilMs?: number;
  lastError?: string;
};
export type BridgeStatus = { online: boolean; lastSeenMs?: number; bridgeId?: string };

export function settingsApi(fetchImpl: FetchLike) {
  return {
    invites: () => requestJson<{ invites: Invite[] }>(fetchImpl, '/api/auth/invites'),
    createInvite: (email: string) => requestJson<CreatedInvite>(fetchImpl, '/api/auth/invites', post(email ? { email } : {})),
    revokeInvite: (tokenHash: string) => requestJson<{ ok: boolean }>(fetchImpl, '/api/auth/invites/revoke', post({ tokenHash })),
    flow: () => requestJson<{ accounts: FlowAccount[]; bridge: BridgeStatus }>(fetchImpl, '/api/flow/accounts'),
    addFlowAccount: (input: { label: string; email: string; profileDir?: string }) =>
      requestJson<{ account: FlowAccount }>(fetchImpl, '/api/flow/accounts', post(input)),
    removeFlowAccount: (id: string) => requestJson<{ ok: boolean }>(fetchImpl, `/api/flow/accounts/${encodeURIComponent(id)}`, del()),
    changePassword: (currentPassword: string, newPassword: string) =>
      requestJson<{ ok: boolean }>(fetchImpl, '/api/auth/change-password', post({ currentPassword, newPassword }))
  };
}

export function inviteLink(origin: string, token: string): string {
  return `${origin}/join/${token}`;
}

export function inviteState(invite: Invite, now = Date.now()): { label: 'Dipakai' | 'Kedaluwarsa' | 'Aktif'; tone: string; active: boolean } {
  if (invite.usedAt) return { label: 'Dipakai', tone: 'done', active: false };
  if (Date.parse(invite.expiresAt) <= now) return { label: 'Kedaluwarsa', tone: '', active: false };
  return { label: 'Aktif', tone: 'pending', active: true };
}

export function relativeTime(ms: number, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - ms) / 1000));
  if (sec < 60) return 'baru saja';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} menit lalu`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} jam lalu`;
  return `${Math.floor(hours / 24)} hari lalu`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function totalCredits(accounts: FlowAccount[]): number {
  return accounts.reduce((sum, a) => sum + (typeof a.credits === 'number' ? a.credits : 0), 0);
}

export const ACCOUNT_STATUS: Record<FlowAccount['status'], { label: string; tone: string }> = {
  ready: { label: 'Siap', tone: 'done' },
  cooldown: { label: 'Jeda', tone: 'pending' },
  error: { label: 'Error', tone: 'failed' }
};

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Terjadi kesalahan';
}
