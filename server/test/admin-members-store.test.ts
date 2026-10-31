import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemberError, UserAuthStore } from '../src/auth/store.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'nc-adm-store-'));
async function codeOf(fn: () => unknown): Promise<string | undefined> {
  try { await fn(); } catch (error) { expect(error).toBeInstanceOf(MemberError); return (error as MemberError).code; }
  return undefined;
}
async function world() {
  const dir = tempDir();
  const store = new UserAuthStore(dir);
  const admin = await store.createUser({ email: 'a@x.io', password: 'admin-pass-1', isAdmin: true });
  const member = await store.createUser({ email: 'm@x.io', password: 'member-pass-1', isAdmin: false });
  return { dir, store, admin, member };
}

describe('T8 suspend: sign-in refused, sessions gone, nothing else touched', () => {
  it('setSuspended revokes every session at once, marks the member, and is reversible and idempotent', async () => {
    const { store, admin, member } = await world();
    const s1 = store.createSession(member.id);
    const s2 = store.createSession(member.id);
    const keep = store.createSession(admin.id);
    const out = store.setSuspended(member.id, true, admin.id);
    expect(out.suspendedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(store.resolveSession(s1.token)).toBeUndefined();
    expect(store.resolveSession(s2.token)).toBeUndefined();
    expect(store.resolveSession(keep.token)).toMatchObject({ id: admin.id });
    // second call keeps the first timestamp
    expect(store.setSuspended(member.id, true, admin.id).suspendedAt).toBe(out.suspendedAt);
    expect(store.listUsers().find(u => u.id === member.id)?.suspendedAt).toBe(out.suspendedAt);
    // a session created while suspended is not honoured either
    const sneaky = store.createSession(member.id);
    expect(store.resolveSession(sneaky.token)).toBeUndefined();
    const back = store.setSuspended(member.id, false, admin.id);
    expect(back.suspendedAt).toBeUndefined();
    expect(store.findUserById(member.id)?.suspendedAt).toBeUndefined();
    expect(store.createSession(member.id)).toBeTruthy();
    expect(store.resolveSession(store.createSession(member.id).token)).toMatchObject({ id: member.id });
    expect(store.setSuspended(member.id, false, admin.id).suspendedAt).toBeUndefined();
  });

  it('refuses suspending yourself, an unknown id and the last ACTIVE admin', async () => {
    const { store, admin, member } = await world();
    expect(await codeOf(() => store.setSuspended(admin.id, true, admin.id))).toBe('SELF');
    expect(await codeOf(() => store.setSuspended('u_nope', true, admin.id))).toBe('NOT_FOUND');
    store.setAdmin(member.id, true, admin.id);
    store.setSuspended(admin.id, true, member.id);
    // the only active admin left is `member`: nobody may suspend them (and `admin` cannot act while suspended anyway)
    expect(await codeOf(() => store.setSuspended(member.id, true, admin.id))).toBe('LAST_ADMIN');
    expect(await codeOf(() => store.setAdmin(member.id, false, admin.id))).toBe('LAST_ADMIN');
    expect(await codeOf(() => store.removeUser(member.id, admin.id))).toBe('LAST_ADMIN');
  });
});

describe('T8 removeUser (C.3): a tombstone stays, projects are not this store\'s business', () => {
  it('writes a tombstone {id,email,removedAt,removedBy} in the same write that drops the user, sessions and invites', async () => {
    const { dir, store, admin, member } = await world();
    store.createSession(member.id);
    const invite = store.createInvite({ createdBy: member.id });
    const tomb = store.removeUser(member.id, admin.id);
    expect(tomb).toMatchObject({ id: member.id, email: 'm@x.io', removedBy: admin.id });
    expect(tomb.removedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(store.findUserById(member.id)).toBeUndefined();
    expect(store.findTombstone(member.id)).toEqual(tomb);
    expect(store.tombstones().map(t => t.id)).toEqual([member.id]);
    expect(store.peekInvite(invite.token)).toBeUndefined();
    const disk = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8')) as { users: { id: string }[]; removedUsers: { id: string }[]; sessions: unknown[] };
    expect(disk.users.map(u => u.id)).toEqual([admin.id]);
    expect(disk.removedUsers.map(t => t.id)).toEqual([member.id]);
    expect(disk.sessions).toEqual([]);
    // the password hash never goes into the tombstone
    expect(JSON.stringify(disk.removedUsers)).not.toMatch(/passwordHash|scrypt|\$/);
  });

  it('keeps the old guards (self, last admin, unknown) and a second removal is NOT_FOUND while the tombstone is still found (idempotent retry)', async () => {
    const { store, admin, member } = await world();
    expect(await codeOf(() => store.removeUser(admin.id, admin.id))).toBe('SELF');
    expect(await codeOf(() => store.removeUser(admin.id, member.id))).toBe('LAST_ADMIN');
    store.removeUser(member.id, admin.id);
    expect(await codeOf(() => store.removeUser(member.id, admin.id))).toBe('NOT_FOUND');
    expect(store.tombstones()).toHaveLength(1);
  });

  it('a suspended user can be removed; the tombstone lists them once; old auth.json without the new fields still loads', async () => {
    const { dir, store, admin, member } = await world();
    store.setSuspended(member.id, true, admin.id);
    store.removeUser(member.id, admin.id);
    expect(store.tombstones()).toHaveLength(1);
    const fresh = new UserAuthStore(tempDir());
    expect(fresh.tombstones()).toEqual([]);
    expect(fresh.findTombstone('u_x')).toBeUndefined();
    expect(new UserAuthStore(dir).hasUsers()).toBe(true);
  });
});
