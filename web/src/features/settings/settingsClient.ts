import { del, post, requestJson, type FetchLike } from './http.js';

export type Invite = { tokenHash: string; email?: string; createdAt: string; expiresAt: string; usedAt?: string; revokedAt?: string; createdBy: string };
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
  enabled?: boolean;
  priority?: number;
  dailyCreditCap?: number;
  lastUsedAtMs?: number;
};
export type Member = { id: string; email: string; isAdmin: boolean; createdAt: string; lastSeenAt?: string };
export type Rotation = 'round-robin' | 'least-used' | 'priority';
export type AccountPatch = { label?: string; enabled?: boolean; priority?: number; dailyCreditCap?: number | null };
type Count = { jobs: number; done: number; failed: number };
export type Usage = {
  range: { from: string; to: string; days: number };
  totals: Count & { running: number; queued: number; credits: number };
  byDay: Array<Count & { date: string; credits: number }>;
  byAccount: Array<Count & { accountId: string; label: string; credits: number; creditsRemaining?: number; enabled: boolean; dailyCreditCap?: number; creditsUsedToday: number; lastUsedAtMs?: number }>;
  byKind: Record<'video' | 'image' | 'character', { jobs: number; done: number; credits: number }>;
  byMember: Array<{ userId: string; email?: string; jobs: number; done: number; credits: number }>;
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
    members: () => requestJson<{ members: Member[] }>(fetchImpl, '/api/auth/members'),
    setAdmin: (id: string, isAdmin: boolean) => requestJson<{ member: Member }>(fetchImpl, `/api/auth/members/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ isAdmin }) }),
    removeMember: (id: string) => requestJson<{ ok: boolean }>(fetchImpl, `/api/auth/members/${encodeURIComponent(id)}`, del()),
    usage: (days: number) => requestJson<Usage>(fetchImpl, `/api/flow/usage?days=${days}`),
    pool: () => requestJson<{ pool: { rotation: Rotation } }>(fetchImpl, '/api/flow/pool'),
    setPool: (rotation: Rotation) => requestJson<{ pool: { rotation: Rotation } }>(fetchImpl, '/api/flow/pool', { method: 'PUT', body: JSON.stringify({ rotation }) }),
    updateAccount: (id: string, patch: AccountPatch) => requestJson<{ account: FlowAccount }>(fetchImpl, `/api/flow/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    changePassword: (currentPassword: string, newPassword: string) =>
      requestJson<{ ok: boolean }>(fetchImpl, '/api/auth/change-password', post({ currentPassword, newPassword }))
  };
}

/** Model teks (OpenCode Go) — mirrors server/src/llm/config.ts `TEXT_MODELS`. */
export const TEXT_MODELS = [
  { value: 'glm-5.3-flash', label: 'glm-5.3-flash', hint: 'cepat · default' },
  { value: 'glm-5.3', label: 'glm-5.3', hint: 'lebih teliti, lebih lambat' },
  { value: 'beam-free', label: 'beam-free', hint: 'gratis' },
  { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro', hint: 'alternatif' }
] as const;
export type TextModelId = (typeof TEXT_MODELS)[number]['value'];
export type TextModelState = { configured: boolean; keyHint?: string; model: TextModelId };
export type TextModelTest = { ok: true; model: string; ms: number };

export function textModelApi(fetchImpl: FetchLike) {
  return {
    get: () => requestJson<TextModelState>(fetchImpl, '/api/providers/text'),
    save: (patch: { apiKey?: string | null; model?: TextModelId }) =>
      requestJson<TextModelState>(fetchImpl, '/api/providers/text', { method: 'PUT', body: JSON.stringify(patch) }),
    test: () => requestJson<TextModelTest>(fetchImpl, '/api/providers/text/test', post({}))
  };
}

/** "Tersimpan · …abcd" from a server keyHint like "••••abcd". */
export function textKeyText(hint?: string): string {
  return `Tersimpan · …${(hint ?? '').slice(-4)}`;
}

export function inviteLink(origin: string, token: string): string {
  return `${origin}/join/${token}`;
}

export function inviteState(invite: Invite, now = Date.now()): { label: 'Dipakai' | 'Dicabut' | 'Kedaluwarsa' | 'Aktif'; tone: string; active: boolean } {
  if (invite.revokedAt) return { label: 'Dicabut', tone: '', active: false };
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
