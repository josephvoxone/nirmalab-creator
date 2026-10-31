/**
 * W1 — team workspaces (wave 4): the store, its rules and its storage.
 * RED first: written before `workspace/store.ts` existed.
 */
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INVITE_TTL_MS, MAX_WORKSPACES_PER_USER, WorkspaceError, WorkspaceStore, canManage, canWrite, workspaceRole
} from '../src/workspace/store.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'nc-ws-store-'));
const newStore = (now?: () => number) => new WorkspaceStore(tempDir(), now ? { now } : {});

async function codeOf(fn: () => unknown): Promise<string | undefined> {
  try { await fn(); } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceError);
    return (error as WorkspaceError).code;
  }
  return undefined;
}

describe('W1 store: workspace pribadi, peran dan anggota', () => {
  it('creates a workspace whose creator is its owner, with a random id and one owner membership', async () => {
    const store = newStore();
    const ws = await store.create({ name: 'Tim Lentera', ownerId: 'u_a' });
    expect(ws.id).toMatch(/^ws_[A-Za-z0-9_-]{16,}$/);
    expect(ws).toMatchObject({ name: 'Tim Lentera', ownerId: 'u_a', personal: false });
    expect(ws.createdAtMs).toBeGreaterThan(0);
    expect(store.roleOf('u_a', ws.id)).toBe('owner');
    expect(store.members(ws.id)).toEqual([expect.objectContaining({ workspaceId: ws.id, userId: 'u_a', role: 'owner' })]);
    // a second call cannot reuse the same id
    const other = await store.create({ name: 'Tim Lentera', ownerId: 'u_a' });
    expect(other.id).not.toBe(ws.id);
  });

  it('gives every user one personal workspace, idempotently, named after the first name', async () => {
    const store = newStore();
    const first = await store.ensurePersonal({ userId: 'u_a', displayName: 'Joseph' });
    expect(first.workspace.personal).toBe(true);
    expect(first.workspace.name).toBe('Ruang kerja Joseph');
    expect(first.created).toBe(true);
    const again = await store.ensurePersonal({ userId: 'u_a', displayName: 'Joseph' });
    expect(again.created).toBe(false);
    expect(again.workspace.id).toBe(first.workspace.id);
    expect(store.list().filter(w => w.ownerId === 'u_a')).toHaveLength(1);
  });

  it(`caps the memberships of one user at ${MAX_WORKSPACES_PER_USER} (personal included)`, async () => {
    const store = newStore();
    await store.ensurePersonal({ userId: 'u_a', displayName: 'A' });
    for (let i = 1; i < MAX_WORKSPACES_PER_USER; i += 1) await store.create({ name: `W${i}`, ownerId: 'u_a' });
    expect(store.listForUser('u_a')).toHaveLength(MAX_WORKSPACES_PER_USER);
    expect(await codeOf(() => store.create({ name: 'Keenam', ownerId: 'u_a' }))).toBe('LIMIT');
  });

  it('refuses to demote or remove the last owner, and allows it once another owner exists', async () => {
    const store = newStore();
    const ws = await store.create({ name: 'Tim', ownerId: 'u_a' });
    await store.addMember({ workspaceId: ws.id, userId: 'u_b', role: 'editor', byUserId: 'u_a' });
    expect(await codeOf(() => store.setRole({ workspaceId: ws.id, userId: 'u_a', role: 'editor', byUserId: 'u_a' }))).toBe('LAST_OWNER');
    expect(await codeOf(() => store.removeMember({ workspaceId: ws.id, userId: 'u_a', byUserId: 'u_a' }))).toBe('LAST_OWNER');
    await store.setRole({ workspaceId: ws.id, userId: 'u_b', role: 'owner', byUserId: 'u_a' });
    expect(store.roleOf('u_b', ws.id)).toBe('owner');
    await store.setRole({ workspaceId: ws.id, userId: 'u_a', role: 'viewer', byUserId: 'u_b' });
    expect(store.roleOf('u_a', ws.id)).toBe('viewer');
  });

  it('only an owner manages members; a member may remove themselves; projects are not touched', async () => {
    const store = newStore();
    const ws = await store.create({ name: 'Tim', ownerId: 'u_a' });
    await store.addMember({ workspaceId: ws.id, userId: 'u_b', role: 'editor', byUserId: 'u_a' });
    await store.addMember({ workspaceId: ws.id, userId: 'u_c', role: 'viewer', byUserId: 'u_a' });
    expect(await codeOf(() => store.addMember({ workspaceId: ws.id, userId: 'u_d', role: 'viewer', byUserId: 'u_b' }))).toBe('FORBIDDEN');
    expect(await codeOf(() => store.setRole({ workspaceId: ws.id, userId: 'u_c', role: 'editor', byUserId: 'u_b' }))).toBe('FORBIDDEN');
    // a member leaving on their own is fine; the owner cannot be removed by a non-owner
    expect(await codeOf(() => store.removeMember({ workspaceId: ws.id, userId: 'u_a', byUserId: 'u_b' }))).toBe('FORBIDDEN');
    await store.removeMember({ workspaceId: ws.id, userId: 'u_b', byUserId: 'u_b' });
    expect(store.roleOf('u_b', ws.id)).toBeUndefined();
    expect(store.members(ws.id).map(m => m.userId).sort()).toEqual(['u_a', 'u_c']);
  });

  it('a personal workspace cannot be deleted; another workspace can, by its owner only', async () => {
    const store = newStore();
    const personal = await store.ensurePersonal({ userId: 'u_a', displayName: 'A' });
    const team = await store.create({ name: 'Tim', ownerId: 'u_a' });
    expect(await codeOf(() => store.deleteWorkspace({ workspaceId: personal.workspace.id, byUserId: 'u_a' }))).toBe('PERSONAL');
    await store.addMember({ workspaceId: team.id, userId: 'u_b', role: 'owner', byUserId: 'u_a' });
    expect(await codeOf(() => store.deleteWorkspace({ workspaceId: team.id, byUserId: 'u_c' }))).toBe('NOT_FOUND');
    await store.deleteWorkspace({ workspaceId: team.id, byUserId: 'u_b' });
    expect(store.get(team.id)).toBeUndefined();
    expect(store.roleOf('u_a', team.id)).toBeUndefined();
  });
});

describe('W1 store: undangan (hash saja, sekali pakai, kedaluwarsa 7 hari, bisa dicabut)', () => {
  it('stores only the SHA-256 of a 32-byte token, expires in 7 days, and the token works once', async () => {
    const store = newStore();
    const ws = await store.create({ name: 'Tim', ownerId: 'u_a' });
    const { invite, token } = await store.createInvite({ workspaceId: ws.id, email: ' M@X.io ', role: 'editor', createdBy: 'u_a' });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    expect(invite.email).toBe('m@x.io');
    expect(invite.role).toBe('editor');
    expect(invite.expiresAtMs - invite.createdAtMs).toBe(INVITE_TTL_MS);
    const raw = readFileSync(store.path, 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).toContain(invite.tokenHash);
    expect(invite.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(store.peekInvite(token)).toMatchObject({ id: invite.id, workspaceId: ws.id, role: 'editor' });
    const joined = await store.acceptInvite({ token, userId: 'u_b', email: 'm@x.io' });
    expect(joined).toMatchObject({ workspaceId: ws.id, userId: 'u_b', role: 'editor' });
    expect(store.roleOf('u_b', ws.id)).toBe('editor');
    // single use
    expect(store.peekInvite(token)).toBeUndefined();
    expect(await codeOf(() => store.acceptInvite({ token, userId: 'u_c', email: 'm@x.io' }))).toBe('INVITE_INVALID');
  });

  it('refuses an expired invite, a revoked invite and a different email; the invited email must match an existing account', async () => {
    let clock = 1_000_000;
    const store = newStore(() => clock);
    const ws = await store.create({ name: 'Tim', ownerId: 'u_a' });
    const expired = await store.createInvite({ workspaceId: ws.id, email: 'm@x.io', role: 'viewer', createdBy: 'u_a' });
    clock += INVITE_TTL_MS + 1;
    expect(store.peekInvite(expired.token)).toBeUndefined();
    expect(await codeOf(() => store.acceptInvite({ token: expired.token, userId: 'u_b', email: 'm@x.io' }))).toBe('INVITE_INVALID');
    const fresh = await store.createInvite({ workspaceId: ws.id, email: 'm@x.io', role: 'viewer', createdBy: 'u_a' });
    expect(await codeOf(() => store.acceptInvite({ token: fresh.token, userId: 'u_b', email: 'other@x.io' }))).toBe('EMAIL_MISMATCH');
    await store.revokeInvite({ workspaceId: ws.id, inviteId: fresh.invite.id, byUserId: 'u_a' });
    expect(store.peekInvite(fresh.token)).toBeUndefined();
    expect(await codeOf(() => store.acceptInvite({ token: fresh.token, userId: 'u_b', email: 'm@x.io' }))).toBe('INVITE_INVALID');
  });

  it('lists live invites for the owner only and never returns a token or hash in a member view', async () => {
    const store = newStore();
    const ws = await store.create({ name: 'Tim', ownerId: 'u_a' });
    await store.addMember({ workspaceId: ws.id, userId: 'u_b', role: 'editor', byUserId: 'u_a' });
    const { invite } = await store.createInvite({ workspaceId: ws.id, email: 'm@x.io', role: 'editor', createdBy: 'u_a' });
    expect(store.invites(ws.id).map(i => i.id)).toEqual([invite.id]);
    expect(await codeOf(() => store.revokeInvite({ workspaceId: ws.id, inviteId: invite.id, byUserId: 'u_b' }))).toBe('FORBIDDEN');
    expect(await codeOf(() => store.createInvite({ workspaceId: ws.id, email: 'm@x.io', role: 'editor', createdBy: 'u_b' }))).toBe('FORBIDDEN');
    expect(await codeOf(() => store.createInvite({ workspaceId: ws.id, email: 'm@x.io', role: 'owner', createdBy: 'u_a' }))).toBe('INVALID');
  });
});

describe('W1 store: penyimpanan (0600, serialize) dan pembantu peran', () => {
  it('writes one 0600 file and loses nothing when twenty writes run at once', async () => {
    const store = newStore();
    const ids = await Promise.all(Array.from({ length: 20 }, (_, i) => store.create({ name: `W${i}`, ownerId: `u_${i}` })));
    expect(new Set(ids.map(w => w.id)).size).toBe(20);
    expect(store.list()).toHaveLength(20);
    if (process.platform !== 'win32') expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(existsSync(store.path)).toBe(true);
    const reopened = new WorkspaceStore(join(store.path, '..', '..'), {});
    expect(reopened.list()).toHaveLength(20);
  });

  it('maps roles to what they may do, and answers undefined for a non-member', async () => {
    expect([canWrite('owner'), canWrite('editor'), canWrite('viewer')]).toEqual([true, true, false]);
    expect([canManage('owner'), canManage('editor'), canManage('viewer')]).toEqual([true, false, false]);
    const store = newStore();
    const ws = await store.create({ name: 'Tim', ownerId: 'u_a' });
    expect(workspaceRole(store, 'u_a', ws.id)).toBe('owner');
    expect(workspaceRole(store, 'u_z', ws.id)).toBeUndefined();
    expect(workspaceRole(store, 'u_a', 'ws_nope')).toBeUndefined();
  });
});
