import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE, registerAuthRoutes } from '../src/auth/routes.js';
import { MemberError, UserAuthStore } from '../src/auth/store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'oc-members-test-'));
}

async function codeOf(fn: () => unknown): Promise<string | undefined> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(MemberError);
    return (error as MemberError).code;
  }
  return undefined;
}

describe('UserAuthStore members', () => {
  it('lists public fields only, with lastSeenAt from the newest session', async () => {
    const store = new UserAuthStore(tempDir());
    const admin = await store.createUser({ email: 'a@x.io', password: 'admin-pass-1', isAdmin: true });
    const member = await store.createUser({ email: 'm@x.io', password: 'member-pass-1', isAdmin: false });
    store.createSession(member.id);
    const second = store.createSession(member.id);
    const list = store.listUsers();
    expect(list.map(u => u.email)).toEqual(['a@x.io', 'm@x.io']);
    for (const entry of list) {
      expect(Object.keys(entry).sort()).toEqual(
        entry.lastSeenAt === undefined
          ? ['createdAt', 'email', 'id', 'isAdmin']
          : ['createdAt', 'email', 'id', 'isAdmin', 'lastSeenAt']
      );
    }
    expect(list.find(u => u.id === admin.id)?.lastSeenAt).toBeUndefined();
    expect(list.find(u => u.id === member.id)?.lastSeenAt).toBe(second.session.createdAt);
  });

  it('setAdmin promotes and demotes, guarded against self, last admin and unknown ids', async () => {
    const store = new UserAuthStore(tempDir());
    const admin = await store.createUser({ email: 'a@x.io', password: 'admin-pass-1', isAdmin: true });
    const member = await store.createUser({ email: 'm@x.io', password: 'member-pass-1', isAdmin: false });

    expect(await codeOf(() => store.setAdmin(admin.id, false, admin.id))).toBe('SELF');
    expect(await codeOf(() => store.setAdmin('u_nope', true, admin.id))).toBe('NOT_FOUND');

    expect(store.setAdmin(member.id, true, admin.id)).toMatchObject({ id: member.id, isAdmin: true });
    expect(store.findUserById(member.id)?.isAdmin).toBe(true);

    // Two admins now: the other admin can demote the first one.
    expect(store.setAdmin(admin.id, false, member.id)).toMatchObject({ isAdmin: false });
    // member is now the only admin; demoting them (by someone else) must fail.
    expect(await codeOf(() => store.setAdmin(member.id, false, admin.id))).toBe('LAST_ADMIN');
    expect(store.findUserById(member.id)?.isAdmin).toBe(true);
  });

  it('removeUser deletes the user, their sessions and their pending invites', async () => {
    const dir = tempDir();
    const store = new UserAuthStore(dir);
    const admin = await store.createUser({ email: 'a@x.io', password: 'admin-pass-1', isAdmin: true });
    const other = await store.createUser({ email: 'b@x.io', password: 'admin-pass-2', isAdmin: true });
    const keep = store.createSession(admin.id);
    const gone = store.createSession(other.id);
    const invite = store.createInvite({ createdBy: other.id });

    expect(await codeOf(() => store.removeUser(admin.id, admin.id))).toBe('SELF');
    expect(await codeOf(() => store.removeUser('u_nope', admin.id))).toBe('NOT_FOUND');

    store.removeUser(other.id, admin.id);
    expect(store.findUserById(other.id)).toBeUndefined();
    expect(store.resolveSession(gone.token)).toBeUndefined();
    expect(store.resolveSession(keep.token)).toMatchObject({ id: admin.id });
    expect(store.peekInvite(invite.token)).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8')) as { sessions: { userId: string }[] };
    expect(onDisk.sessions.map(entry => entry.userId)).toEqual([admin.id]);
  });

  it('refuses to remove the last admin even when asked by someone else', async () => {
    const store = new UserAuthStore(tempDir());
    const admin = await store.createUser({ email: 'a@x.io', password: 'admin-pass-1', isAdmin: true });
    const member = await store.createUser({ email: 'm@x.io', password: 'member-pass-1', isAdmin: false });
    expect(await codeOf(() => store.removeUser(admin.id, member.id))).toBe('LAST_ADMIN');
    expect(store.findUserById(admin.id)).toBeDefined();
  });

  it('writes auth.json atomically: 0600, valid JSON, no temp files left behind', async () => {
    const dir = tempDir();
    const store = new UserAuthStore(dir);
    const admin = await store.createUser({ email: 'a@x.io', password: 'admin-pass-1', isAdmin: true });
    const member = await store.createUser({ email: 'm@x.io', password: 'member-pass-1', isAdmin: false });
    store.setAdmin(member.id, true, admin.id);
    store.removeUser(member.id, admin.id);
    expect(readdirSync(dir)).toEqual(['auth.json']);
    expect(statSync(join(dir, 'auth.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8')).users).toHaveLength(1);
  });
});

describe('member routes', () => {
  async function setup(): Promise<{
    server: FastifyInstance;
    store: UserAuthStore;
    adminId: string;
    memberId: string;
    admin: string;
    member: string;
  }> {
    const server = Fastify();
    const store = new UserAuthStore(tempDir());
    await registerAuthRoutes(server, store, {
      bootstrapAdminEmail: 'admin@x.io',
      bootstrapAdminPassword: 'bootstrap-pass-1'
    });
    const adminUser = store.findUserByEmail('admin@x.io')!;
    const memberUser = await store.createUser({ email: 'member@x.io', password: 'member-pass-1', isAdmin: false });
    const cookie = (userId: string) => `${SESSION_COOKIE}=${store.createSession(userId).token}`;
    return {
      server,
      store,
      adminId: adminUser.id,
      memberId: memberUser.id,
      admin: cookie(adminUser.id),
      member: cookie(memberUser.id)
    };
  }

  it('GET /auth/members: 401 anon, 403 member, admin gets public member list', async () => {
    const { server, admin, member, memberId } = await setup();
    expect((await server.inject({ method: 'GET', url: '/auth/members' })).statusCode).toBe(401);
    const forbidden = await server.inject({ method: 'GET', url: '/auth/members', headers: { cookie: member } });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('FORBIDDEN');

    const ok = await server.inject({ method: 'GET', url: '/auth/members', headers: { cookie: admin } });
    expect(ok.statusCode).toBe(200);
    const { members } = ok.json() as { members: Record<string, unknown>[] };
    expect(members.map(m => m.email)).toEqual(['admin@x.io', 'member@x.io']);
    expect(members.find(m => m.id === memberId)).toMatchObject({ isAdmin: false, lastSeenAt: expect.any(String) });
    expect(JSON.stringify(members)).not.toMatch(/passwordHash|tokenHash|invitedBy/);
  });

  it('PATCH /auth/members/:id changes the role with the right status codes', async () => {
    const { server, admin, member, adminId, memberId } = await setup();
    const patch = (id: string, payload: unknown, cookie?: string) =>
      server.inject({ method: 'PATCH', url: `/auth/members/${id}`, payload: payload as object, headers: cookie ? { cookie } : {} });

    expect((await patch(memberId, { isAdmin: true })).statusCode).toBe(401);
    expect((await patch(memberId, { isAdmin: true }, member)).statusCode).toBe(403);

    for (const bad of [{}, { isAdmin: 'true' }, { isAdmin: 1 }, { isAdmin: null }]) {
      const res = await patch(memberId, bad, admin);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().error.code).toBe('INVALID_INPUT');
    }

    const unknown = await patch('u_doesnotexist', { isAdmin: true }, admin);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('NOT_FOUND');

    const self = await patch(adminId, { isAdmin: false }, admin);
    expect(self.statusCode).toBe(409);
    expect(self.json().error.code).toBe('SELF');

    const promoted = await patch(memberId, { isAdmin: true }, admin);
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().member).toMatchObject({ id: memberId, email: 'member@x.io', isAdmin: true });
    expect(promoted.json().member.passwordHash).toBeUndefined();

    // The promoted member is now admin and may demote the bootstrap admin…
    const demoted = await patch(adminId, { isAdmin: false }, member);
    expect(demoted.statusCode).toBe(200);
    expect(demoted.json().member.isAdmin).toBe(false);
    // …after which the old admin has lost admin rights.
    expect((await patch(memberId, { isAdmin: false }, admin)).statusCode).toBe(403);
  });

  it('DELETE /auth/members/:id removes the user and kills their session', async () => {
    const { server, admin, member, adminId, memberId } = await setup();
    const del = (id: string, cookie?: string) =>
      server.inject({ method: 'DELETE', url: `/auth/members/${id}`, headers: cookie ? { cookie } : {} });

    expect((await del(memberId)).statusCode).toBe(401);
    expect((await del(adminId, member)).statusCode).toBe(403);

    const unknown = await del('u_doesnotexist', admin);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('NOT_FOUND');

    const self = await del(adminId, admin);
    expect(self.statusCode).toBe(409);
    expect(self.json().error.code).toBe('SELF');

    expect((await server.inject({ method: 'GET', url: '/auth/me', headers: { cookie: member } })).statusCode).toBe(200);
    const removed = await del(memberId, admin);
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true, orphanedProjects: 0 }); // T8 (06 §C.3): the answer now says how many projects were left without an owner

    const me = await server.inject({ method: 'GET', url: '/auth/me', headers: { cookie: member } });
    expect(me.statusCode).toBe(401);
    const login = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'member@x.io', password: 'member-pass-1' } });
    expect(login.statusCode).toBe(401);
    const list = await server.inject({ method: 'GET', url: '/auth/members', headers: { cookie: admin } });
    expect(list.json().members.map((m: { email: string }) => m.email)).toEqual(['admin@x.io']);
    // T8: removing the same member again is a harmless retry (200 alreadyRemoved), an id that never existed is still 404
    const again = await del(memberId, admin);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ ok: true, alreadyRemoved: true });
    expect((await del('u_never', admin)).statusCode).toBe(404);
  });

});
